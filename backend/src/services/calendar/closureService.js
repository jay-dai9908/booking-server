import prisma from '../../prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../../../shared/time.js';
import { methodLabel } from '../../../../shared/paymentMethods.js';
import { sendLinePushMessage, buildBrandFlexMessage } from '../../utils/lineMessaging.js';
import { log as auditLog } from '../audit/auditService.js';
import { getDayInfo } from './dayType.js';
import { cancelBooking, formatSessionsToTimeRange } from '../booking/cancelService.js';

export const DEFAULT_CLOSURE_ANNOUNCEMENT =
  '拾光製所 {日期} 臨時公休，您預約的 {時段}（{人數} 位）已取消。{店家說明}造成不便非常抱歉，如需改約請直接回覆這個 LINE。';

export function renderClosureAnnouncement(template, { dateStr, timeRange, pax, closedNote }) {
  const raw = template && String(template).trim()
    ? String(template).trim()
    : DEFAULT_CLOSURE_ANNOUNCEMENT;
  const noteText = closedNote && String(closedNote).trim()
    ? `${String(closedNote).trim()}。`
    : '';
  return raw
    .replaceAll('{日期}', dateStr || '')
    .replaceAll('{時段}', timeRange || '')
    .replaceAll('{人數}', String(pax ?? ''))
    .replaceAll('{店家說明}', noteText);
}

function getPushFn() {
  if (process.env.NODE_ENV === 'test' && typeof globalThis.__TEST_LINE_PUSH_FN__ === 'function') {
    return globalThis.__TEST_LINE_PUSH_FN__;
  }
  return sendLinePushMessage;
}

export async function getClosureImpact(client = prisma, dateStrInput) {
  const db = client || prisma;
  const dateStr = toTaipeiDateString(dateStrInput);
  const targetDate = dateOnly(dateStr);

  const [dayInfo, globalSetting, confirmedRows] = await Promise.all([
    getDayInfo(db, dateStr),
    db.globalSetting.findUnique({ where: { id: 1 }, select: { payment_methods_json: true } }),
    db.reservation.findMany({
      where: {
        status: 'confirmed',
        session: { session_date: targetDate }
      },
      include: {
        session: true,
        user: { select: { id: true, name: true, phone: true, line_user_id: true } }
      },
      orderBy: { session: { start_time: 'asc' } }
    })
  ]);

  const configuredMethods = Array.isArray(globalSetting?.payment_methods_json)
    ? globalSetting.payment_methods_json
    : null;

  const byRef = new Map();
  for (const r of confirmedRows) {
    if (!byRef.has(r.booking_ref)) byRef.set(r.booking_ref, []);
    byRef.get(r.booking_ref).push(r);
  }

  const refs = Array.from(byRef.keys());
  const [validPayments, prepays] = refs.length > 0
    ? await Promise.all([
        db.payment.findMany({
          where: { booking_ref: { in: refs }, status: 'valid' },
          orderBy: { created_at: 'asc' }
        }),
        db.bookingPrepay.findMany({
          where: { booking_ref: { in: refs } }
        })
      ])
    : [[], []];

  const paymentsByRef = new Map();
  const passIdsToLookup = new Set();
  for (const p of validPayments) {
    if (!paymentsByRef.has(p.booking_ref)) paymentsByRef.set(p.booking_ref, []);
    paymentsByRef.get(p.booking_ref).push(p);
    if (p.method === 'pass' && Array.isArray(p.pass_json)) {
      for (const pj of p.pass_json) {
        if (pj?.user_pass_id) passIdsToLookup.add(Number(pj.user_pass_id));
      }
    }
  }

  const userPassRows = passIdsToLookup.size > 0
    ? await db.userPass.findMany({
        where: { id: { in: Array.from(passIdsToLookup) } },
        select: { id: true, pass_code: true }
      })
    : [];
  const passCodeById = new Map(userPassRows.map((up) => [up.id, up.pass_code]));
  const prepayByRef = new Map(prepays.map((pr) => [pr.booking_ref, pr]));

  const directCancel = [];
  const needRefund = [];
  const passDeducted = [];
  const pendingReconcile = [];

  for (const [ref, rows] of byRef.entries()) {
    const first = rows[0];
    const user = first.user;
    const sessions = rows.map((r) => r.session).filter(Boolean);
    const timeRange = formatSessionsToTimeRange(sessions);
    const hasLine = Boolean(user?.line_user_id && !user.line_user_id.startsWith('manual_'));
    const prepay = prepayByRef.get(ref) || null;
    const payments = paymentsByRef.get(ref) || [];

    const baseItem = {
      booking_ref: ref,
      time_range: timeRange,
      pax: first.pax,
      user_id: user?.id || first.user_id,
      user_name: user?.name || '顧客',
      has_line: hasLine,
      line_user_id: hasLine ? user.line_user_id : null,
      is_self_service: Boolean(first.is_self_service || prepay)
    };

    const nonPassPayments = payments.filter((p) => p.method !== 'pass');
    const netNonPassPaid = nonPassPayments.reduce((sum, p) => {
      const amt = Number(p.amount) || 0;
      return sum + (p.kind === 'refund' ? -amt : amt);
    }, 0);
    const passPayments = payments.filter((p) => p.method === 'pass');

    if (netNonPassPaid > 0 || (first.amount_received || 0) > 0) {
      const chargePayments = nonPassPayments.filter((p) => p.kind !== 'refund' && (Number(p.amount) || 0) > 0);
      needRefund.push({
        ...baseItem,
        paid_amount: netNonPassPaid > 0 ? netNonPassPaid : (first.amount_received || 0),
        payments: chargePayments.map((p) => ({
          payment_no: p.payment_no,
          method: p.method,
          method_label: methodLabel(p.method, configuredMethods),
          amount: p.amount,
          paid_at: p.paid_at || p.created_at
        }))
      });
    } else if (passPayments.length > 0) {
      const passDetails = [];
      for (const vp of passPayments) {
        const items = Array.isArray(vp.pass_json) ? vp.pass_json : [];
        for (const pj of items) {
          const code = pj?.pass_code || passCodeById.get(Number(pj?.user_pass_id)) || '';
          passDetails.push({
            payment_no: vp.payment_no,
            user_pass_id: Number(pj?.user_pass_id) || null,
            last4: code ? String(code).slice(-4) : '****',
            units: Number(pj?.units) || 1,
            plan_name: pj?.plan_name || '計次卡'
          });
        }
      }
      passDeducted.push({
        ...baseItem,
        passes: passDetails
      });
    } else if (prepay && (prepay.status === 'reported_pending_verify' || prepay.status === 'mismatch')) {
      pendingReconcile.push({
        ...baseItem,
        prepay_status: prepay.status,
        remittance_last5: prepay.remittance_last5 || null,
        assigned_pool_account: prepay.assigned_pool_account || null
      });
    } else {
      directCancel.push({
        ...baseItem,
        prepay_status: prepay?.status || null
      });
    }
  }

  return {
    date: dateStr,
    is_closed: dayInfo.type === 'closed',
    closed_note: dayInfo.closed_note || null,
    groups: {
      direct_cancel: directCancel,
      need_refund: needRefund,
      pass_deducted: passDeducted,
      pending_reconcile: pendingReconcile
    },
    counts: {
      direct_cancel: directCancel.length,
      need_refund: needRefund.length,
      pass_deducted: passDeducted.length,
      pending_reconcile: pendingReconcile.length,
      total: refs.length
    }
  };
}

function csvCell(val) {
  let s = val === null || val === undefined ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export function buildClosureImpactCsv(impact) {
  const header = ['分類', '預約編號', '時段', '人數', '姓名', '有LINE', '處理說明'];
  const rows = [];

  for (const item of impact.groups.need_refund) {
    const payInfo = (item.payments || [])
      .map((p) => `${p.method_label} NT$${p.amount}`)
      .join(' / ');
    rows.push([
      '需退款',
      item.booking_ref,
      item.time_range,
      item.pax,
      item.user_name,
      item.has_line ? '是' : '否',
      `已收 NT$${item.paid_amount}${payInfo ? `（${payInfo}）` : ''}`
    ]);
  }

  for (const item of impact.groups.pass_deducted) {
    const passInfo = (item.passes || [])
      .map((p) => `卡號末4碼 ${p.last4} 扣 ${p.units} 次`)
      .join(' / ');
    rows.push([
      '卡券已扣',
      item.booking_ref,
      item.time_range,
      item.pax,
      item.user_name,
      item.has_line ? '是' : '否',
      passInfo || '請先作廢收款退回次數'
    ]);
  }

  for (const item of impact.groups.pending_reconcile) {
    const prepayInfo = item.remittance_last5
      ? `狀態 ${item.prepay_status}，末五碼 ${item.remittance_last5}`
      : `狀態 ${item.prepay_status}`;
    rows.push([
      '半自助待對帳',
      item.booking_ref,
      item.time_range,
      item.pax,
      item.user_name,
      item.has_line ? '是' : '否',
      prepayInfo
    ]);
  }

  const lines = [header, ...rows].map((cols) => cols.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function dispatchClosureLineNotice(
  db,
  { booking_ref, user, dateStr, timeRange, pax, closedNote, messageTemplate, staffName, staffId, deviceInfo }
) {
  const rendered = renderClosureAnnouncement(messageTemplate, {
    dateStr,
    timeRange,
    pax,
    closedNote
  });
  const frontendUrl = process.env.FRONTEND_URL || 'https://shiguangstudio.com';
  const flexPayload = buildBrandFlexMessage({
    title: `臨時公休通知（${dateStr}）`,
    subtitle: `${user.name || '顧客'} 您好`,
    bodyText: rendered,
    infoRows: [
      { label: '公休日期', value: dateStr },
      { label: '原預約時段', value: timeRange || '-' },
      { label: '人數', value: `${pax} 位` }
    ],
    buttonLabel: '查看預約紀錄',
    buttonUrl: `${frontendUrl}/history`,
    tagText: '臨時公休'
  });

  const pushFn = getPushFn();
  await pushFn(user.line_user_id, flexPayload);

  await auditLog(db, {
    event_type: 'line_message_sent',
    category: 'line',
    target_type: 'user',
    target_ref: String(user.id),
    booking_ref,
    summary: `發送公休取消通知給 ${user.name || '顧客'}（${dateStr}）`,
    after_json: {
      user_id: user.id,
      date: dateStr,
      message: rendered
    },
    staff_name: staffName || '管理員',
    staff_id: staffId || null,
    device_id: deviceInfo?.device_id || null,
    device_label: deviceInfo?.device_label || '後台'
  });

  return rendered;
}

export async function batchCancelClosureBookings(
  client = prisma,
  { dateStr, booking_refs = [], notify_line = false, message = '', staffName = '管理員', staffId = null, deviceInfo = {} }
) {
  const db = client || prisma;
  const targetDateStr = toTaipeiDateString(dateStr);
  const dayInfo = await getDayInfo(db, targetDateStr);
  if (dayInfo.type !== 'closed') {
    throw { status: 409, message: '這天尚未設為公休，請先設定公休後再批次取消' };
  }

  const trimmedMsg = message ? String(message).trim() : '';
  if (trimmedMsg.length > 300) {
    throw { status: 422, message: '公告內容最多 300 個字' };
  }

  const impact = await getClosureImpact(db, targetDateStr);
  const directSet = new Set(impact.groups.direct_cancel.map((i) => i.booking_ref));
  const refundSet = new Set(impact.groups.need_refund.map((i) => i.booking_ref));
  const passSet = new Set(impact.groups.pass_deducted.map((i) => i.booking_ref));
  const pendingSet = new Set(impact.groups.pending_reconcile.map((i) => i.booking_ref));
  const directByRef = new Map(impact.groups.direct_cancel.map((i) => [i.booking_ref, i]));

  const uniqueRefs = Array.from(new Set((Array.isArray(booking_refs) ? booking_refs : []).map(String).filter(Boolean)));

  const cancelled = [];
  const skipped = [];
  const failed = [];

  const targetDateObj = dateOnly(targetDateStr);

  for (const ref of uniqueRefs) {
    if (refundSet.has(ref)) {
      skipped.push({ booking_ref: ref, reason: '需退款', line_status: 'skipped' });
      continue;
    }
    if (passSet.has(ref)) {
      skipped.push({ booking_ref: ref, reason: '卡券已扣，請先作廢收款', line_status: 'skipped' });
      continue;
    }
    if (pendingSet.has(ref)) {
      skipped.push({ booking_ref: ref, reason: '半自助待對帳', line_status: 'skipped' });
      continue;
    }
    if (!directSet.has(ref)) {
      const existingRows = await db.reservation.findMany({
        where: { booking_ref: ref, session: { session_date: targetDateObj } },
        select: { status: true }
      });
      const reason = existingRows.length > 0 && existingRows.every((r) => r.status === 'cancelled')
        ? '先前已取消'
        : '這天沒有此確認中預約';
      skipped.push({ booking_ref: ref, reason, line_status: 'skipped' });
      continue;
    }

    const item = directByRef.get(ref);
    try {
      const txOut = await db.$transaction((tx) =>
        cancelBooking(tx, {
          booking_ref: ref,
          actor: 'admin',
          operatorName: staffName,
          reason: '臨時公休',
          isAdmin: true,
          suppressAutoNotify: true
        })
      );

      if (txOut.errorStatus) {
        failed.push({
          booking_ref: ref,
          reason: txOut.errorBody?.error || '取消失敗',
          line_status: 'skipped'
        });
        continue;
      }

      let lineStatus = notify_line ? 'no_line' : 'skipped';
      let lineError = null;
      if (notify_line) {
        if (!item.has_line || !item.line_user_id) {
          lineStatus = 'no_line';
        } else {
          try {
            await dispatchClosureLineNotice(db, {
              booking_ref: ref,
              user: { id: item.user_id, name: item.user_name, line_user_id: item.line_user_id },
              dateStr: targetDateStr,
              timeRange: item.time_range,
              pax: item.pax,
              closedNote: dayInfo.closed_note,
              messageTemplate: trimmedMsg,
              staffName,
              staffId,
              deviceInfo
            });
            lineStatus = 'sent';
          } catch (pushErr) {
            lineStatus = 'failed';
            lineError = pushErr.message || 'LINE 推播失敗';
          }
        }
      }

      cancelled.push({
        booking_ref: ref,
        user_name: item.user_name,
        line_status: lineStatus,
        ...(lineError ? { line_error: lineError } : {})
      });
    } catch (err) {
      failed.push({
        booking_ref: ref,
        reason: err.message || '取消失敗',
        line_status: 'skipped'
      });
    }
  }

  return {
    date: targetDateStr,
    cancelled,
    skipped,
    failed
  };
}

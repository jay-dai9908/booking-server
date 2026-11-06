import prisma from '../prismaClient.js';
import {
  getBookingBill,
  saveDraft,
  collectPayment,
  supplementPayment,
  refundPayment,
  voidPayment,
  markUnpaid,
  waivePayment
} from '../services/billing/billService.js';
import { validatePassUsage } from '../services/billing/passTender.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';

export async function getBillingDetails(req, res) {
  const { booking_ref } = req.params;
  try {
    const data = await getBookingBill(booking_ref);

    const addonPresets = await prisma.addonItem.findMany({
      where: { is_active: true },
      orderBy: { sort_order: 'asc' }
    });

    const quickPromos = await prisma.promoCode.findMany({
      where: { is_pos_quick_select: true, is_active: true, channel: { in: ['all', 'pos'] } }
    });

    return res.json({
      server_now: new Date().toISOString(),
      booking: data.booking,
      pricing: data.pricing,
      draft: data.draft,
      persons: data.persons,
      boards: data.boards,
      payments: data.payments,
      addon_presets: addonPresets,
      quick_promos: quickPromos,
      bill: data.bill,
      status: data.status
    });
  } catch (error) {
    console.error('[getBillingDetails] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '無法讀取結帳資訊', details: error.message });
  }
}

export async function putDraft(req, res) {
  const { booking_ref } = req.params;
  const { base_rev, draft } = req.body;
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const saveResult = await saveDraft(booking_ref, base_rev, draft, staffName, staffId, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      bill: saveResult.bill || saveResult,
      draft: saveResult.draft,
      rev: saveResult.rev
    });
  } catch (error) {
    console.error('[putDraft] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: '儲存草稿失敗', details: error.message });
  }
}

export async function postCollect(req, res) {
  const { booking_ref } = req.params;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await collectPayment(booking_ref, req.body, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postCollect] Error:', error);
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        bill: error.bill
      });
    }
    return res.status(500).json({ error: '收款失敗', details: error.message });
  }
}

export async function postSupplement(req, res) {
  const { booking_ref } = req.params;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await supplementPayment(booking_ref, req.body, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postSupplement] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '補收失敗', details: error.message });
  }
}

export async function postRefund(req, res) {
  const { booking_ref } = req.params;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await refundPayment(booking_ref, req.body, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postRefund] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '退款失敗', details: error.message });
  }
}

export async function postWaive(req, res) {
  const { booking_ref } = req.params;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await waivePayment(booking_ref, req.body, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postWaive] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '免收失敗', details: error.message });
  }
}

export async function postVoid(req, res) {
  const { id } = req.params;
  const { reason } = req.body;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await voidPayment(id, reason, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postVoid] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '作廢收款失敗', details: error.message });
  }
}

export async function postMarkUnpaid(req, res) {
  const { booking_ref } = req.params;
  const { reason } = req.body;
  const staffUser = req.user;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await markUnpaid(booking_ref, reason, staffUser, deviceInfo);
    return res.json({
      success: true,
      server_now: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    console.error('[postMarkUnpaid] Error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '標記未結帳失敗', details: error.message });
  }
}

export async function getMemberPasses(req, res) {
  const { booking_ref } = req.params;
  try {
    const reservation = await prisma.reservation.findFirst({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { session: true }
    });
    if (!reservation) {
      return res.status(404).json({ error: '找不到該筆預約' });
    }

    const { bill, pricing } = await getBookingBill(booking_ref);
    const sessionDate = reservation.session.session_date;

    const passes = await prisma.userPass.findMany({
      where: { user_id: reservation.user_id },
      include: { plan: true },
      orderBy: { created_at: 'desc' }
    });

    const passList = passes.map(pass => {
      const validation = validatePassUsage(pass, { date: sessionDate });
      const suggests = [];

      if (bill.persons) {
        for (const p of bill.persons) {
          if (p.paid) continue;
          let units = 1;
          let value = 0;
          const effect = pass.plan?.checkout_effect || (pass.pass_type === 'TIME_PASS' ? 'entry_hours' : 'entry_full');

          if (effect === 'entry_hours') {
            const needHours = Math.floor(p.hours || 0);
            units = Math.max(1, Math.min(pass.remaining_quota || 99, needHours));
            value = Math.min(p.entry?.amount || 0, units * (pricing.hourly || 150));
          } else if (effect === 'entry_full') {
            units = 1;
            value = p.entry?.amount || 0;
          } else if (effect === 'percent_off') {
            units = 1;
            const scope = pass.plan?.checkout_scope === 'all' ? (p.total || 0) : (p.entry?.amount || 0);
            value = Math.round(scope * (pass.plan?.discount_percent || 0) / 100);
          } else if (effect === 'fixed_amount') {
            units = 1;
            const scope = pass.plan?.checkout_scope === 'all' ? (p.total || 0) : (p.entry?.amount || 0);
            value = Math.min(pass.plan?.checkout_value || 0, scope);
          }

          suggests.push({
            person_no: p.person_no,
            units,
            value
          });
        }
      }

      return {
        id: pass.id,
        pass_code: pass.pass_code,
        plan_name: pass.plan_name_snapshot,
        pass_type: pass.pass_type,
        remaining_quota: pass.remaining_quota,
        total_quota: pass.total_quota,
        expires_at: pass.expires_at,
        usable: validation.usable,
        reason: validation.reason || null,
        suggest: suggests
      };
    });

    return res.json({
      server_now: new Date().toISOString(),
      passes: passList
    });
  } catch (error) {
    console.error('[getMemberPasses] Error:', error);
    return res.status(500).json({ error: '無法讀取會員卡券', details: error.message });
  }
}

export default {
  getBillingDetails,
  putDraft,
  postCollect,
  postSupplement,
  postRefund,
  postWaive,
  postVoid,
  postMarkUnpaid,
  getMemberPasses
};

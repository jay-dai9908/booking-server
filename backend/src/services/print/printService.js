import { EventEmitter } from 'events';
import prisma from '../../prismaClient.js';
import {
  buildReceipt,
  buildSupplementReceipt,
  buildRefundSlip,
  buildOrderSummary,
  buildClosingSlip,
  buildTestPage,
  formatBookingRef
} from '../../../../shared/receipts.js';
import { getNextDailySeq, nextSerialNo } from '../billing/billService.js';
import { log as auditLog } from '../audit/auditService.js';

const printEvents = new EventEmitter();
printEvents.setMaxListeners(100);

/**
 * Queue a print job (spec 5.6 & 7.2)
 */
export async function queuePrintJob({
  type, // receipt | supplement | refund | summary | closing | test
  booking_ref = null,
  payment_id = null,
  batch_no = null,
  closing_id = null,
  reprint_of_id = null,
  user = {},
  device = {},
  commands: passedCommands = null,
  title: passedTitle = null,
  opts: passedOpts = {},
  now: passedNow = null
}, clientTx = null) {
  const staffName = user?.name || '系統';
  const staffId = user?.id || null;
  const deviceLabel = device?.device_label || '櫃檯';
  const deviceId = device?.device_id || null;

  const client = clientTx || prisma;
  const globalSetting = await client.globalSetting.findFirst() || {};
  const footerText = globalSetting.receipt_footer_text || '謝謝光臨，作品記得帶回家';
  const opts = {
    footerText,
    receiptFooterText: footerText,
    publicSiteUrl: process.env.PUBLIC_SITE_URL || device?.origin || 'https://shiguang.tw',
    ...passedOpts
  };

  let commands = [];
  let title = '列印單';
  let copyNo = 1;
  const isReprint = Boolean(reprint_of_id);

  if (isReprint) {
    const orig = await client.printJob.findUnique({ where: { id: Number(reprint_of_id) } });
    if (orig) {
      copyNo = (orig.copy_no || 1) + 1;
    }
    opts.isReprint = true;
    opts.copyNo = copyNo;
  }

  const formattedRef = formatBookingRef(booking_ref);

  if (passedCommands && passedCommands.length > 0) {
    commands = passedCommands;
    title = passedTitle || `列印單 ${formattedRef || ''}`;
  } else if (type === 'receipt' && payment_id) {
    const payment = await client.payment.findUnique({ where: { id: Number(payment_id) } });
    const bookingReservations = booking_ref ? await client.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { user: true, session: true },
      orderBy: { session: { start_time: 'asc' } }
    }) : [];
    const firstRes = bookingReservations[0];
    const lastRes = bookingReservations[bookingReservations.length - 1];
    const booking = firstRes ? {
      booking_ref,
      ref_display: formattedRef,
      customer_name: firstRes.user?.name,
      pax: firstRes.pax,
      paid_persons: firstRes.paid_persons,
      session_date: firstRes.session?.session_date,
      start_time: firstRes.session?.start_time,
      end_time: lastRes.session?.end_time,
      assigned_seats: firstRes.assigned_seats || []
    } : null;
    commands = buildReceipt(payment, booking, opts);
    title = `結帳單 ${formattedRef || ''} 第 ${(payment?.person_nos || []).join('、')} 位`;
  } else if (type === 'supplement' && payment_id) {
    const payment = await client.payment.findUnique({ where: { id: Number(payment_id) } });
    const bookingReservations = booking_ref ? await client.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { user: true, session: true },
      orderBy: { session: { start_time: 'asc' } }
    }) : [];
    const firstRes = bookingReservations[0];
    const lastRes = bookingReservations[bookingReservations.length - 1];
    const booking = firstRes ? {
      booking_ref,
      ref_display: formattedRef,
      customer_name: firstRes.user?.name,
      pax: firstRes.pax,
      session_date: firstRes.session?.session_date,
      start_time: firstRes.session?.start_time,
      end_time: lastRes.session?.end_time,
      assigned_seats: firstRes.assigned_seats || []
    } : null;
    commands = buildSupplementReceipt(payment, booking, opts);
    title = `補收收據 ${formattedRef || ''}`;
  } else if (type === 'refund' && payment_id) {
    const payment = await client.payment.findUnique({ where: { id: Number(payment_id) } });
    const bookingReservations = booking_ref ? await client.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { user: true, session: true },
      orderBy: { session: { start_time: 'asc' } }
    }) : [];
    const firstRes = bookingReservations[0];
    const lastRes = bookingReservations[bookingReservations.length - 1];
    const booking = firstRes ? {
      booking_ref,
      ref_display: formattedRef,
      customer_name: firstRes.user?.name,
      pax: firstRes.pax,
      session_date: firstRes.session?.session_date,
      start_time: firstRes.session?.start_time,
      end_time: lastRes.session?.end_time,
      assigned_seats: firstRes.assigned_seats || []
    } : null;
    commands = buildRefundSlip(payment, booking, opts);
    title = `退款單 ${formattedRef || ''}`;
  } else if (type === 'summary' && booking_ref) {
    const bookingReservations = await client.reservation.findMany({
      where: { booking_ref, status: { not: 'cancelled' } },
      include: { user: true, session: true },
      orderBy: { session: { start_time: 'asc' } }
    });
    const firstRes = bookingReservations[0];
    const lastRes = bookingReservations[bookingReservations.length - 1];
    const booking = firstRes ? {
      booking_ref,
      ref_display: formattedRef,
      customer_name: firstRes.user?.name,
      pax: firstRes.pax,
      session_date: firstRes.session?.session_date,
      start_time: firstRes.session?.start_time,
      end_time: lastRes.session?.end_time,
      assigned_seats: firstRes.assigned_seats || []
    } : {};
    const payments = await client.payment.findMany({
      where: { booking_ref, status: 'valid' }
    });
    commands = buildOrderSummary(booking, payments, opts);
    title = `整單總表 ${formattedRef}`;
  } else if (type === 'closing' && closing_id) {
    const closing = await client.cashClosing.findUnique({ where: { id: Number(closing_id) } });
    commands = buildClosingSlip(closing, opts);
    title = `日結單 ${closing?.business_date ? closing.business_date.toISOString().slice(0, 10) : ''}`;
  } else if (type === 'test') {
    const stationId = opts.station_id || opts.stationId;
    const station = stationId
      ? await client.printStation.findUnique({ where: { id: Number(stationId) } })
      : await client.printStation.findFirst({ where: { is_default: true } });
    commands = buildTestPage(station);
    title = '測試頁';
  }

  // Create PrintJob with daily sequence
  const executeInTx = async (tx) => {
    const jobDate = passedNow || passedOpts?.now || passedOpts?.job_date;
    const jobNo = await nextSerialNo(tx, 'job', jobDate);

    const createdJob = await tx.printJob.create({
      data: {
        job_no: jobNo,
        type,
        booking_ref: booking_ref || null,
        payment_id: payment_id ? Number(payment_id) : null,
        batch_no: batch_no || null,
        closing_id: closing_id ? Number(closing_id) : null,
        title,
        commands_json: commands,
        is_reprint: isReprint,
        reprint_of_id: reprint_of_id ? Number(reprint_of_id) : null,
        copy_no: copyNo,
        status: 'queued',
        requested_by_name: staffName,
        requested_device: deviceLabel
      }
    });

    if (payment_id) {
      await tx.payment.update({
        where: { id: Number(payment_id) },
        data: { receipt_status: 'queued' }
      });
    }

    await auditLog(tx, {
      booking_ref,
      event_type: isReprint ? 'reprint' : 'print_queued',
      category: 'print',
      summary: isReprint ? `補印單已送出（#${jobNo}，第 ${copyNo} 次）` : `列印單已排入（#${jobNo}）`,
      print_job_id: createdJob.id,
      payment_id: payment_id ? Number(payment_id) : null,
      staff_name: staffName,
      staff_id: staffId,
      device_id: deviceId,
      device_label: deviceLabel
    });

    return createdJob;
  };

  const job = clientTx ? await executeInTx(clientTx) : await prisma.$transaction(executeInTx);

  // Notify any waiting station pollers
  printEvents.emit('job-queued', job);
  return job;
}

/**
 * Atomically claim next job for a print station (spec 5.7)
 */
export async function claimNextJob(stationId, waitSeconds = 20) {
  const station = await prisma.printStation.findUnique({ where: { id: stationId } });
  if (!station || !station.accepting) {
    return null;
  }

  // Immediate claim attempt with SKIP LOCKED
  const tryClaim = async () => {
    const result = await prisma.$queryRaw`
      UPDATE "PrintJob"
      SET status = 'claimed',
          claimed_at = now(),
          lease_until = now() + interval '60 seconds',
          station_id = ${stationId},
          attempts = attempts + 1
      WHERE id = (
        SELECT id FROM "PrintJob"
        WHERE status = 'queued' AND (station_id IS NULL OR station_id = ${stationId})
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *;
    `;
    return result[0] || null;
  };

  let job = await tryClaim();
  if (job) return job;

  if (waitSeconds <= 0) return null;

  // Long poll wait
  return new Promise((resolve) => {
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        printEvents.off('job-queued', onQueue);
        resolve(null);
      }
    }, waitSeconds * 1000);

    const onQueue = async () => {
      if (resolved) return;
      const claimed = await tryClaim();
      if (claimed) {
        resolved = true;
        clearTimeout(timer);
        printEvents.off('job-queued', onQueue);
        resolve(claimed);
      }
    };

    printEvents.on('job-queued', onQueue);
  });
}

/**
 * Report result of a print job
 */
export async function reportJobResult(jobId, { success, error_code = null, error_message = null }, via = 'station') {
  return await prisma.$transaction(async (tx) => {
    const job = await tx.printJob.findUnique({ where: { id: Number(jobId) } });
    if (!job) throw { status: 404, message: '找不到此列印單' };

    const status = success ? 'printed' : 'failed';
    const now = new Date();

    const updatedJob = await tx.printJob.update({
      where: { id: job.id },
      data: {
        status,
        printed_at: success ? now : null,
        printed_by: via,
        error_code: success ? null : error_code,
        error_message: success ? null : error_message
      }
    });

    if (job.payment_id) {
      await tx.payment.update({
        where: { id: job.payment_id },
        data: { receipt_status: status }
      });
    }

    await auditLog(tx, {
      booking_ref: job.booking_ref,
      event_type: success ? 'print_succeeded' : 'print_failed',
      category: 'print',
      summary: success
        ? `${job.is_reprint ? '補印成功' : '收據已印出'}（#${job.job_no}）`
        : `列印失敗：${error_message || error_code || '未知錯誤'}（#${job.job_no}）`,
      print_job_id: job.id,
      payment_id: job.payment_id,
      reason: error_message,
      staff_name: job.requested_by_name || '列印站',
      device_label: job.requested_device || '列印站'
    });

    return updatedJob;
  });
}

export default {
  queuePrintJob,
  claimNextJob,
  reportJobResult
};

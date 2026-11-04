import prisma from '../../prismaClient.js';

/**
 * Append-only audit logger for accounting events (spec 3.5 & 4.6.4)
 */
export async function log(tx, {
  booking_ref = null,
  event_type,
  category,
  summary,
  amount = null,
  before_json = null,
  after_json = null,
  reason = null,
  payment_id = null,
  print_job_id = null,
  staff_name,
  staff_id = null,
  device_id = null,
  device_label
}) {
  const client = tx || prisma;
  return await client.accountingEvent.create({
    data: {
      booking_ref: booking_ref || null,
      event_type,
      category,
      summary,
      amount: amount !== null && amount !== undefined ? Math.round(Number(amount)) : null,
      before_json: before_json || null,
      after_json: after_json || null,
      reason: reason ? String(reason).trim() : null,
      payment_id: payment_id ? Number(payment_id) : null,
      print_job_id: print_job_id ? Number(print_job_id) : null,
      staff_name: staff_name || '系統',
      staff_id: staff_id ? Number(staff_id) : null,
      device_id: device_id || null,
      device_label: (device_label || '櫃檯').slice(0, 20)
    }
  });
}

export default {
  log
};

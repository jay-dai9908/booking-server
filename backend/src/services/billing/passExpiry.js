import prisma from '../../prismaClient.js';
import { log as auditLog } from '../audit/auditService.js';

/**
 * Mark overdue ACTIVE passes as EXPIRED and write pass_status_changed audit events.
 * Safe to invoke repeatedly; only updates rows still in ACTIVE with expires_at < now.
 */
export async function expireOverduePasses(now = new Date(), client = prisma) {
  const overduePasses = await client.userPass.findMany({
    where: {
      status: 'ACTIVE',
      expires_at: { not: null, lt: now }
    },
    select: {
      id: true,
      pass_code: true,
      remaining_quota: true,
      expires_at: true
    }
  });

  if (overduePasses.length === 0) {
    return { expiredCount: 0, passCodes: [] };
  }

  const updatedCodes = [];
  for (const pass of overduePasses) {
    const code = await client.$transaction(async (tx) => {
      const upd = await tx.userPass.updateMany({
        where: { id: pass.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' }
      });
      if (upd.count === 0) return null;

      await auditLog(tx, {
        booking_ref: pass.pass_code,
        event_type: 'pass_status_changed',
        category: 'pass',
        target_type: 'user_pass',
        target_ref: pass.pass_code,
        summary: `卡券 ${pass.pass_code} 已過期自動標記（ACTIVE → EXPIRED）`,
        reason: '已過期',
        before_json: { status: 'ACTIVE', remaining_quota: pass.remaining_quota },
        after_json: { status: 'EXPIRED', remaining_quota: pass.remaining_quota },
        staff_name: '系統',
        staff_id: null,
        device_label: '系統排程'
      });
      return pass.pass_code;
    });
    if (code) updatedCodes.push(code);
  }

  return { expiredCount: updatedCodes.length, passCodes: updatedCodes };
}

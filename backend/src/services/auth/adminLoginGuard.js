import prisma from '../../prismaClient.js';
import auditService from '../audit/auditService.js';

export const PASSWORD_FAIL_LIMIT = 3;
export const PASSWORD_FAIL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Ensure single-row AdminLoginGuard (id=1) exists and acquire a row-level FOR UPDATE lock inside tx.
 */
export async function lockGuardRow(tx) {
  await tx.$executeRawUnsafe(
    `INSERT INTO "AdminLoginGuard" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING`
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT * FROM "AdminLoginGuard" WHERE "id" = 1 FOR UPDATE`
  );
  return rows[0];
}

/**
 * Public status check for the admin login page. Returns ONLY locked & can_unlock_with_code.
 */
export async function getAdminLockStatus(db = prisma) {
  const guard = await db.adminLoginGuard.findUnique({
    where: { id: 1 },
    select: { locked_at: true, totp_enabled: true }
  });
  return {
    locked: Boolean(guard?.locked_at),
    can_unlock_with_code: Boolean(guard?.totp_enabled)
  };
}

/**
 * Evaluate an admin login attempt inside a serialized transaction on AdminLoginGuard (id=1).
 * Never compares passwords while locked; locks globally on 3 password failures within 10 minutes.
 */
export async function attemptAdminPasswordLogin({
  inputPass,
  ip,
  userAgent,
  verifyPasswordFn
}) {
  const safeIp = ip ? String(ip) : null;
  const safeUa = userAgent ? String(userAgent).slice(0, 200) : null;

  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);

    if (guard.locked_at) {
      return {
        status: 423,
        code: 'ADMIN_LOCKED',
        error: '後台已鎖定'
      };
    }

    if (!inputPass) {
      return {
        status: 400,
        error: '請輸入登入密碼'
      };
    }

    const verified = await verifyPasswordFn(tx);
    const now = new Date();

    if (verified?.ok) {
      await tx.adminLoginGuard.update({
        where: { id: 1 },
        data: { password_failures_reset_at: now }
      });
      return {
        status: 200,
        ...verified
      };
    }

    const resetAt = guard.password_failures_reset_at ? new Date(guard.password_failures_reset_at) : null;
    const tenMinutesAgo = new Date(now.getTime() - PASSWORD_FAIL_WINDOW_MS);
    const cutoff = resetAt && resetAt > tenMinutesAgo ? resetAt : tenMinutesAgo;
    const failureCreatedAt = new Date(Math.max(now.getTime(), (resetAt?.getTime() || 0) + 1));

    await tx.adminLoginFailure.create({
      data: {
        kind: 'password',
        ip: safeIp,
        user_agent: safeUa,
        created_at: failureCreatedAt
      }
    });

    const recentFailures = await tx.adminLoginFailure.count({
      where: {
        kind: 'password',
        created_at: { gt: cutoff }
      }
    });

    if (recentFailures >= PASSWORD_FAIL_LIMIT) {
      await tx.adminLoginGuard.update({
        where: { id: 1 },
        data: { locked_at: now }
      });

      await tx.adminLoginGuardEvent.create({
        data: {
          type: 'locked',
          ip: safeIp,
          user_agent: safeUa,
          note: '密碼連續錯誤 3 次'
        }
      });

      await auditService.log(tx, {
        event_type: 'admin_login_locked',
        category: 'security',
        summary: '後台登入密碼連續錯誤 3 次，已鎖定全站後台登入',
        before_json: { locked_at: null },
        after_json: {
          locked_at: now.toISOString(),
          ip: safeIp,
          failure_count: recentFailures
        },
        staff_name: '系統防護',
        device_label: (safeIp || '後台').slice(0, 20)
      });

      return {
        status: 423,
        code: 'ADMIN_LOCKED',
        error: '後台已鎖定'
      };
    }

    return {
      status: 401,
      error: '密碼錯誤，請重新輸入'
    };
  });
}

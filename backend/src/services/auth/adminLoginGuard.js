import prisma from '../../prismaClient.js';
import auditService from '../audit/auditService.js';
import {
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateBackupCodes,
  generateSecret,
  hashBackupCode,
  normalizeBackupCode,
  verifyBackupCodeHash,
  verifyTotp
} from './totp.js';

export const PASSWORD_FAIL_LIMIT = 3;
export const PASSWORD_FAIL_WINDOW_MS = 10 * 60 * 1000;
export const UNLOCK_FAIL_LIMIT = 5;
export const UNLOCK_FAIL_WINDOW_MS = 10 * 60 * 1000;

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

function countRemainingBackupCodes(backupCodesJson) {
  if (!Array.isArray(backupCodesJson)) return 0;
  return backupCodesJson.filter((item) => item && !item.used_at).length;
}

/**
 * Attempt to unlock a globally locked admin login using a 6-digit TOTP or single-use backup code.
 */
export async function attemptAdminUnlock({ code, ip, userAgent, nowMs = Date.now() }) {
  const safeIp = ip ? String(ip) : null;
  const safeUa = userAgent ? String(userAgent).slice(0, 200) : null;
  const rawCode = typeof code === 'string' ? code.trim() : '';

  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date(nowMs);

    if (guard.unlock_blocked_until && new Date(guard.unlock_blocked_until) > now) {
      return {
        status: 429,
        code: 'UNLOCK_BLOCKED',
        error: '解鎖嘗試太多次，請 10 分鐘後再試'
      };
    }

    if (!guard.locked_at) {
      return {
        status: 409,
        code: 'NOT_LOCKED',
        error: '目前沒有鎖定'
      };
    }

    if (!guard.totp_enabled || !guard.totp_secret_enc) {
      return {
        status: 409,
        code: 'TOTP_NOT_CONFIGURED',
        error: '尚未設定驗證器，請從伺服器解鎖'
      };
    }

    let secretBase32;
    try {
      secretBase32 = decryptTotpSecret(guard.totp_secret_enc);
    } catch (err) {
      console.error('[adminLoginGuard] Failed to decrypt TOTP secret:', err.message);
      return {
        status: 409,
        code: 'TOTP_NOT_CONFIGURED',
        error: '尚未設定驗證器，請從伺服器解鎖'
      };
    }

    let matchedKind = null;
    let newLastStep = guard.totp_last_step;
    let updatedBackupCodes = null;

    if (/^\d{6}$/.test(rawCode)) {
      const check = verifyTotp(secretBase32, rawCode, {
        nowMs: now.getTime(),
        lastStep: guard.totp_last_step
      });
      if (check.ok) {
        matchedKind = 'unlocked_totp';
        newLastStep = check.step;
      }
    } else {
      const normalized = normalizeBackupCode(rawCode);
      if (normalized && Array.isArray(guard.backup_codes_json)) {
        const idx = guard.backup_codes_json.findIndex(
          (entry) => entry && !entry.used_at && verifyBackupCodeHash(normalized, entry.hash)
        );
        if (idx >= 0) {
          matchedKind = 'unlocked_backup';
          updatedBackupCodes = guard.backup_codes_json.map((entry, i) =>
            i === idx ? { ...entry, used_at: now.toISOString() } : entry
          );
        }
      }
    }

    if (matchedKind) {
      const updateData = {
        locked_at: null,
        password_failures_reset_at: now,
        unlock_failures_reset_at: now,
        unlock_blocked_until: null
      };
      if (matchedKind === 'unlocked_totp') {
        updateData.totp_last_step = newLastStep;
      }
      if (updatedBackupCodes) {
        updateData.backup_codes_json = updatedBackupCodes;
      }

      await tx.adminLoginGuard.update({
        where: { id: 1 },
        data: updateData
      });

      const remaining = countRemainingBackupCodes(updatedBackupCodes || guard.backup_codes_json);

      await tx.adminLoginGuardEvent.create({
        data: {
          type: matchedKind,
          ip: safeIp,
          user_agent: safeUa,
          note: matchedKind === 'unlocked_totp' ? '驗證器 6 位數碼解鎖' : '備用碼解鎖'
        }
      });

      await auditService.log(tx, {
        event_type: 'admin_login_unlocked',
        category: 'security',
        summary: matchedKind === 'unlocked_totp' ? '使用驗證器解除後台登入鎖定' : '使用備用碼解除後台登入鎖定',
        before_json: { locked_at: guard.locked_at },
        after_json: {
          locked_at: null,
          method: matchedKind,
          backup_codes_remaining: remaining
        },
        staff_name: '最高管理員',
        device_label: (safeIp || '後台').slice(0, 20)
      });

      return {
        status: 200,
        unlocked: true,
        backup_codes_remaining: remaining
      };
    }

    // Unlock failure -> insert failure row & check 5-attempt window
    const resetAt = guard.unlock_failures_reset_at ? new Date(guard.unlock_failures_reset_at) : null;
    const tenMinutesAgo = new Date(now.getTime() - UNLOCK_FAIL_WINDOW_MS);
    const cutoff = resetAt && resetAt > tenMinutesAgo ? resetAt : tenMinutesAgo;
    const failureCreatedAt = new Date(Math.max(now.getTime(), (resetAt?.getTime() || 0) + 1));

    await tx.adminLoginFailure.create({
      data: {
        kind: 'unlock_code',
        ip: safeIp,
        user_agent: safeUa,
        created_at: failureCreatedAt
      }
    });

    const recentFailures = await tx.adminLoginFailure.count({
      where: {
        kind: 'unlock_code',
        created_at: { gt: cutoff }
      }
    });

    if (recentFailures >= UNLOCK_FAIL_LIMIT) {
      const blockedUntil = new Date(now.getTime() + UNLOCK_FAIL_WINDOW_MS);
      await tx.adminLoginGuard.update({
        where: { id: 1 },
        data: { unlock_blocked_until: blockedUntil }
      });

      await tx.adminLoginGuardEvent.create({
        data: {
          type: 'unlock_blocked',
          ip: safeIp,
          user_agent: safeUa,
          note: '解鎖碼連續錯誤 5 次，封鎖解鎖 10 分鐘'
        }
      });

      return {
        status: 429,
        code: 'UNLOCK_BLOCKED',
        error: '解鎖嘗試太多次，請 10 分鐘後再試'
      };
    }

    return {
      status: 401,
      code: 'UNLOCK_CODE_INVALID',
      error: '驗證碼不正確'
    };
  });
}

/**
 * CLI helper: unlock admin login from local server shell.
 */
export async function cliUnlockAdminLogin(db = prisma) {
  return await db.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date();
    const wasLocked = Boolean(guard.locked_at || guard.unlock_blocked_until);

    if (!guard.locked_at && !guard.unlock_blocked_until) {
      return { wasLocked: false };
    }

    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        locked_at: null,
        password_failures_reset_at: now,
        unlock_failures_reset_at: now,
        unlock_blocked_until: null
      }
    });

    await tx.adminLoginGuardEvent.create({
      data: {
        type: 'unlocked_cli',
        ip: 'cli',
        user_agent: 'cli',
        note: '伺服器指令解鎖'
      }
    });

    await auditService.log(tx, {
      event_type: 'admin_login_unlocked',
      category: 'security',
      summary: '透過伺服器指令解除後台登入鎖定',
      before_json: { locked_at: guard.locked_at },
      after_json: { locked_at: null, method: 'unlocked_cli' },
      staff_name: '伺服器指令',
      device_label: 'cli'
    });

    return { wasLocked };
  });
}

/**
 * CLI helper: reset TOTP & backup codes from local server shell.
 */
export async function cliResetAdminTotp(db = prisma) {
  return await db.$transaction(async (tx) => {
    await lockGuardRow(tx);
    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        totp_secret_enc: null,
        totp_pending_secret_enc: null,
        totp_enabled: false,
        totp_enabled_at: null,
        totp_last_step: null,
        backup_codes_json: null
      }
    });

    await tx.adminLoginGuardEvent.create({
      data: {
        type: 'totp_reset_cli',
        ip: 'cli',
        user_agent: 'cli',
        note: '伺服器指令重設驗證器'
      }
    });

    await auditService.log(tx, {
      event_type: 'admin_totp_reset_cli',
      category: 'security',
      summary: '透過伺服器指令重設後台驗證器與備用碼',
      staff_name: '伺服器指令',
      device_label: 'cli'
    });
  });
}

/**
 * CLI helper: fetch safe status summary (never includes secrets or backup codes).
 */
export async function cliGetAdminGuardStatus(db = prisma) {
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - PASSWORD_FAIL_WINDOW_MS);

  const [guard, recentPwdFails, recentUnlockFails, recentEvents] = await Promise.all([
    db.adminLoginGuard.findUnique({ where: { id: 1 } }),
    db.adminLoginFailure.count({ where: { kind: 'password', created_at: { gt: tenMinutesAgo } } }),
    db.adminLoginFailure.count({ where: { kind: 'unlock_code', created_at: { gt: tenMinutesAgo } } }),
    db.adminLoginGuardEvent.findMany({
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 10,
      select: { id: true, type: true, ip: true, note: true, created_at: true }
    })
  ]);

  return {
    locked: Boolean(guard?.locked_at),
    locked_at: guard?.locked_at || null,
    totp_enabled: Boolean(guard?.totp_enabled),
    backup_codes_remaining: countRemainingBackupCodes(guard?.backup_codes_json),
    recent_password_failures_10m: recentPwdFails,
    recent_unlock_failures_10m: recentUnlockFails,
    recent_events: recentEvents
  };
}

/**
 * SuperAdmin guard settings overview (never exposes secret or backup code hashes).
 */
export async function getAdminGuardOverview(db = prisma) {
  const [guard, recentEvents] = await Promise.all([
    db.adminLoginGuard.findUnique({ where: { id: 1 } }),
    db.adminLoginGuardEvent.findMany({
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: 20,
      select: {
        id: true,
        type: true,
        ip: true,
        user_agent: true,
        note: true,
        created_at: true
      }
    })
  ]);

  let totpBroken = false;
  if (guard?.totp_secret_enc) {
    try {
      decryptTotpSecret(guard.totp_secret_enc);
    } catch (err) {
      console.error('[adminLoginGuard] TOTP secret decryption failed (JWT_SECRET changed or corrupted):', err.message);
      totpBroken = true;
    }
  } else if (guard?.totp_enabled) {
    totpBroken = true;
  }

  return {
    locked: Boolean(guard?.locked_at),
    locked_at: guard?.locked_at || null,
    totp_enabled: Boolean(guard?.totp_enabled),
    totp_enabled_at: guard?.totp_enabled_at || null,
    totp_broken: totpBroken,
    backup_codes_remaining: countRemainingBackupCodes(guard?.backup_codes_json),
    recent_events: recentEvents
  };
}

/**
 * Step 1 of TOTP setup/rotation: requires current TOTP code when already enabled & unbroken.
 */
export async function setupAdminTotp({ code }) {
  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date();
    let updatedLastStep = undefined;

    if (guard.totp_enabled && guard.totp_secret_enc) {
      let currentSecret = null;
      let isBroken = false;
      try {
        currentSecret = decryptTotpSecret(guard.totp_secret_enc);
      } catch (err) {
        console.error('[adminLoginGuard] Existing TOTP secret broken during setup:', err.message);
        isBroken = true;
      }

      if (!isBroken) {
        const cleanCode = typeof code === 'string' ? code.trim() : '';
        const check = verifyTotp(currentSecret, cleanCode, {
          nowMs: now.getTime(),
          lastStep: guard.totp_last_step
        });
        if (!check.ok) {
          return {
            status: 401,
            code: 'TOTP_INVALID',
            error: '目前驗證碼不正確'
          };
        }
        updatedLastStep = check.step;
      }
    }

    const secret = generateSecret();
    const pendingEnc = encryptTotpSecret(secret);
    const otpauthUri = buildOtpauthUri(secret);

    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        totp_pending_secret_enc: pendingEnc,
        ...(updatedLastStep !== undefined ? { totp_last_step: updatedLastStep } : {})
      }
    });

    return {
      status: 200,
      secret,
      otpauth_uri: otpauthUri
    };
  });
}

/**
 * Step 2 of TOTP setup: verify code against pending secret, promote it, and return 8 plain backup codes once.
 */
export async function confirmAdminTotp({ code, ip, userAgent, staffName, staffId }) {
  const safeIp = ip ? String(ip) : null;
  const safeUa = userAgent ? String(userAgent).slice(0, 200) : null;

  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date();

    if (!guard.totp_pending_secret_enc) {
      return {
        status: 400,
        code: 'NO_PENDING_TOTP',
        error: '請先產生驗證器金鑰'
      };
    }

    let pendingSecret;
    try {
      pendingSecret = decryptTotpSecret(guard.totp_pending_secret_enc);
    } catch {
      return {
        status: 400,
        code: 'NO_PENDING_TOTP',
        error: '待確認驗證器金鑰已失效，請重新產生'
      };
    }

    const cleanCode = typeof code === 'string' ? code.trim() : '';
    const check = verifyTotp(pendingSecret, cleanCode, {
      nowMs: now.getTime(),
      lastStep: null
    });
    if (!check.ok) {
      return {
        status: 401,
        code: 'TOTP_INVALID',
        error: '驗證碼不正確，請重新輸入'
      };
    }

    const wasEnabled = Boolean(guard.totp_enabled);
    const plainCodes = generateBackupCodes(8);
    const hashedCodes = plainCodes.map((c) => ({
      hash: hashBackupCode(c),
      used_at: null
    }));

    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        totp_secret_enc: guard.totp_pending_secret_enc,
        totp_pending_secret_enc: null,
        totp_enabled: true,
        totp_enabled_at: now,
        totp_last_step: check.step,
        backup_codes_json: hashedCodes
      }
    });

    const eventType = wasEnabled ? 'totp_regenerated' : 'totp_enabled';
    await tx.adminLoginGuardEvent.create({
      data: {
        type: eventType,
        ip: safeIp,
        user_agent: safeUa,
        note: wasEnabled ? '更換驗證器' : '首次啟用驗證器'
      }
    });

    await auditService.log(tx, {
      event_type: eventType,
      category: 'security',
      summary: wasEnabled ? '更換後台登入驗證器' : '啟用後台登入驗證器',
      before_json: { totp_enabled: wasEnabled },
      after_json: { totp_enabled: true, backup_codes_count: 8 },
      staff_name: staffName || '最高管理員',
      staff_id: staffId || null,
      device_label: (safeIp || '後台').slice(0, 20)
    });

    return {
      status: 200,
      backup_codes: plainCodes
    };
  });
}

/**
 * Regenerate 8 single-use backup codes after verifying current TOTP code.
 */
export async function regenerateAdminBackupCodes({ code, ip, userAgent, staffName, staffId }) {
  const safeIp = ip ? String(ip) : null;
  const safeUa = userAgent ? String(userAgent).slice(0, 200) : null;

  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date();

    if (!guard.totp_enabled || !guard.totp_secret_enc) {
      return {
        status: 409,
        code: 'TOTP_NOT_CONFIGURED',
        error: '尚未設定驗證器'
      };
    }

    let currentSecret;
    try {
      currentSecret = decryptTotpSecret(guard.totp_secret_enc);
    } catch {
      return {
        status: 409,
        code: 'TOTP_BROKEN',
        error: '驗證器設定已失效，請重新設定'
      };
    }

    const cleanCode = typeof code === 'string' ? code.trim() : '';
    const check = verifyTotp(currentSecret, cleanCode, {
      nowMs: now.getTime(),
      lastStep: guard.totp_last_step
    });
    if (!check.ok) {
      return {
        status: 401,
        code: 'TOTP_INVALID',
        error: '驗證碼不正確'
      };
    }

    const plainCodes = generateBackupCodes(8);
    const hashedCodes = plainCodes.map((c) => ({
      hash: hashBackupCode(c),
      used_at: null
    }));

    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        totp_last_step: check.step,
        backup_codes_json: hashedCodes
      }
    });

    await tx.adminLoginGuardEvent.create({
      data: {
        type: 'backup_codes_regenerated',
        ip: safeIp,
        user_agent: safeUa,
        note: '重新產生 8 組備用碼'
      }
    });

    await auditService.log(tx, {
      event_type: 'backup_codes_regenerated',
      category: 'security',
      summary: '重新產生後台登入備用碼',
      after_json: { backup_codes_count: 8 },
      staff_name: staffName || '最高管理員',
      staff_id: staffId || null,
      device_label: (safeIp || '後台').slice(0, 20)
    });

    return {
      status: 200,
      backup_codes: plainCodes
    };
  });
}

/**
 * Disable TOTP and clear all backup codes after verifying current TOTP code.
 */
export async function disableAdminTotp({ code, ip, userAgent, staffName, staffId }) {
  const safeIp = ip ? String(ip) : null;
  const safeUa = userAgent ? String(userAgent).slice(0, 200) : null;

  return await prisma.$transaction(async (tx) => {
    const guard = await lockGuardRow(tx);
    const now = new Date();

    if (!guard.totp_enabled || !guard.totp_secret_enc) {
      return {
        status: 409,
        code: 'TOTP_NOT_CONFIGURED',
        error: '尚未設定驗證器'
      };
    }

    let currentSecret;
    try {
      currentSecret = decryptTotpSecret(guard.totp_secret_enc);
    } catch {
      return {
        status: 409,
        code: 'TOTP_BROKEN',
        error: '驗證器設定已失效，請重新設定或從伺服器重設'
      };
    }

    const cleanCode = typeof code === 'string' ? code.trim() : '';
    const check = verifyTotp(currentSecret, cleanCode, {
      nowMs: now.getTime(),
      lastStep: guard.totp_last_step
    });
    if (!check.ok) {
      return {
        status: 401,
        code: 'TOTP_INVALID',
        error: '驗證碼不正確'
      };
    }

    await tx.adminLoginGuard.update({
      where: { id: 1 },
      data: {
        totp_secret_enc: null,
        totp_pending_secret_enc: null,
        totp_enabled: false,
        totp_enabled_at: null,
        totp_last_step: null,
        backup_codes_json: null
      }
    });

    await tx.adminLoginGuardEvent.create({
      data: {
        type: 'totp_disabled',
        ip: safeIp,
        user_agent: safeUa,
        note: '停用後台驗證器'
      }
    });

    await auditService.log(tx, {
      event_type: 'totp_disabled',
      category: 'security',
      summary: '停用後台登入驗證器',
      before_json: { totp_enabled: true },
      after_json: { totp_enabled: false },
      staff_name: staffName || '最高管理員',
      staff_id: staffId || null,
      device_label: (safeIp || '後台').slice(0, 20)
    });

    return {
      status: 200,
      disabled: true
    };
  });
}

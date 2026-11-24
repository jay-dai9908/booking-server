import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import prisma from '../../backend/src/prismaClient.js';
import { currentStep, totpAt } from './helpers/totp.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
const HEADLESS = process.env.HEADLESS !== 'false';

async function resetGuardTables() {
  await prisma.adminLoginFailure.deleteMany({}).catch(() => {});
  await prisma.adminLoginGuardEvent.deleteMany({}).catch(() => {});
  await prisma.adminLoginGuard.deleteMany({}).catch(() => {});
}

async function waitAwayFromStepBoundary() {
  const rem = Date.now() % 30000;
  if (rem > 27000) {
    await new Promise((r) => setTimeout(r, 30000 - rem + 300));
  }
}

async function run() {
  console.log('--- Starting Round 31 Items 4 & 5 Admin Login Guard Playwright Test ---');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await resetGuardTables();

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    // =========================================================================
    // PART 1: SuperAdmin sets up TOTP in SettingsPage (Screenshots 1 & 2)
    // =========================================================================
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const adminPage = await adminCtx.newPage();

    console.log('1. SuperAdmin logging in...');
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => u.pathname === '/admin/sessions', { timeout: 10000 });
    await adminPage.waitForLoadState('networkidle');

    console.log('2. Opening /admin/settings and verifying unconfigured guard card...');
    await adminPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    const guardCard = adminPage.locator('[data-testid="admin-login-guard-card"]');
    await guardCard.waitFor({ state: 'visible', timeout: 10000 });

    const unconfAlert = adminPage.locator('[data-testid="guard-unconfigured-alert"]');
    await unconfAlert.waitFor({ state: 'visible', timeout: 8000 });
    const unconfText = await unconfAlert.innerText();
    assert.ok(unconfText.includes('尚未設定驗證器，鎖定後只能從伺服器解鎖'));

    const shot1 = path.join(SCREENSHOT_DIR, 'round31_shot1_guard_unconfigured.png');
    await guardCard.screenshot({ path: shot1 });
    console.log(`Saved Screenshot 1: ${shot1}`);

    // Start TOTP setup wizard & capture secret from /totp/setup response
    const [setupRes] = await Promise.all([
      adminPage.waitForResponse((r) => r.url().includes('/api/auth/admin/guard/totp/setup') && r.request().method() === 'POST'),
      unconfAlert.locator('button', { hasText: '設定驗證器' }).click()
    ]);
    assert.equal(setupRes.status(), 200);
    const setupJson = await setupRes.json();
    const secret = setupJson.secret;
    assert.ok(secret && secret.length >= 16, 'Expected valid Base32 secret from setup');

    const stepQr = adminPage.locator('[data-testid="guard-setup-step-qr"]');
    await stepQr.waitFor({ state: 'visible', timeout: 8000 });
    await stepQr.locator('img[alt*="QR Code"]').waitFor({ state: 'visible', timeout: 8000 });
    await stepQr.locator('button', { hasText: '下一步' }).click();

    const stepConfirm = adminPage.locator('[data-testid="guard-setup-step-confirm"]');
    await stepConfirm.waitFor({ state: 'visible', timeout: 5000 });

    await waitAwayFromStepBoundary();
    const confirmStep = currentStep();
    const confirmCode = totpAt(secret, confirmStep);
    await stepConfirm.locator('input').fill(confirmCode);
    await stepConfirm.locator('button[type="submit"]').click();

    const backupPanel = adminPage.locator('[data-testid="guard-backup-codes-panel"]');
    await backupPanel.waitFor({ state: 'visible', timeout: 8000 });
    const backupText = await backupPanel.innerText();
    assert.ok(backupText.includes('這些備用碼只會顯示這一次，請抄下來或印出來收好。每組只能用一次。'));
    const backupMatches = backupText.match(/[A-Z2-9]{5}-[A-Z2-9]{5}/g) || [];
    assert.equal(backupMatches.length, 8, `Expected 8 backup codes, got ${backupMatches.length}`);

    const shot2 = path.join(SCREENSHOT_DIR, 'round31_shot2_guard_backup_codes.png');
    await guardCard.screenshot({ path: shot2 });
    console.log(`Saved Screenshot 2: ${shot2}`);

    await backupPanel.locator('button', { hasText: '我已收好' }).click();
    await adminPage.locator('[data-testid="guard-configured-panel"]').waitFor({ state: 'visible', timeout: 8000 });
    await adminCtx.close();

    // =========================================================================
    // PART 2: Trigger 3 wrong logins -> lock screen -> TOTP unlock -> login
    // =========================================================================
    const loginCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const loginPage = await loginCtx.newPage();
    await loginPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });

    console.log('3. Submitting 3 wrong passwords to trigger global lockout...');
    for (let i = 1; i <= 3; i++) {
      await loginPage.locator('input[type="password"]').fill(`r31-wrong-pass-${i}`);
      await loginPage.click('button[type="submit"]');
      if (i < 3) {
        await loginPage.locator('text=密碼錯誤').waitFor({ state: 'visible', timeout: 5000 });
      }
    }

    const lockScreen = loginPage.locator('[data-testid="admin-lock-screen"]');
    await lockScreen.waitFor({ state: 'visible', timeout: 8000 });
    const lockText = await lockScreen.innerText();
    assert.ok(lockText.includes('後台已鎖定') && lockText.includes('請輸入驗證器上的 6 位數碼解鎖'));

    const shot3 = path.join(SCREENSHOT_DIR, 'round31_shot3_login_locked.png');
    await loginPage.screenshot({ path: shot3, fullPage: true });
    console.log(`Saved Screenshot 3: ${shot3}`);

    // Verify correct password returns 423 while locked
    const lockedLoginRes = await fetch(`${API_BASE}/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD })
    });
    assert.equal(lockedLoginRes.status, 423, `Expected 423 while locked, got ${lockedLoginRes.status}`);

    // Try wrong 6-digit TOTP code
    const badCode = confirmCode === '000000' ? '111111' : '000000';
    await loginPage.locator('[data-testid="admin-unlock-input"]').fill(badCode);
    await loginPage.locator('[data-testid="admin-unlock-submit"]').click();
    await loginPage.locator('text=驗證碼不正確').waitFor({ state: 'visible', timeout: 5000 });

    // Unlock with valid unused TOTP step (step + 1 if still in confirmStep)
    await waitAwayFromStepBoundary();
    const nowStep = currentStep();
    const unlockStep = nowStep > confirmStep ? nowStep : confirmStep + 1;
    const validUnlockCode = totpAt(secret, unlockStep);
    await loginPage.locator('[data-testid="admin-unlock-input"]').fill(validUnlockCode);
    await loginPage.locator('[data-testid="admin-unlock-submit"]').click();

    await loginPage.locator('text=已解鎖，請重新輸入密碼登入').waitFor({ state: 'visible', timeout: 8000 });

    // Log in with correct password after unlock
    await loginPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await loginPage.click('button[type="submit"]');
    await loginPage.waitForURL((u) => u.pathname === '/admin/sessions', { timeout: 10000 });
    await loginCtx.close();

    // =========================================================================
    // PART 3: Lock again -> unlock via backup code
    // =========================================================================
    console.log('4. Locking again and unlocking with backup code...');
    const backupCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const backupPage = await backupCtx.newPage();
    await backupPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });

    for (let i = 1; i <= 3; i++) {
      await backupPage.locator('input[type="password"]').fill(`r31-wrong-backup-${i}`);
      await backupPage.click('button[type="submit"]');
      if (i < 3) {
        await backupPage.locator('text=密碼錯誤').waitFor({ state: 'visible', timeout: 5000 });
      }
    }
    await backupPage.locator('[data-testid="admin-lock-screen"]').waitFor({ state: 'visible', timeout: 8000 });
    await backupPage.locator('[data-testid="admin-unlock-use-backup"]').click();
    await backupPage.locator('[data-testid="admin-unlock-input"]').fill(backupMatches[0]);
    await backupPage.locator('[data-testid="admin-unlock-submit"]').click();
    await backupPage.locator('text=已解鎖，請重新輸入密碼登入').waitFor({ state: 'visible', timeout: 8000 });
    await backupCtx.close();

    // =========================================================================
    // PART 4: Lock with NO TOTP configured (Screenshot 4)
    // =========================================================================
    console.log('5. Testing lock screen when TOTP is not configured...');
    await resetGuardTables();
    const noTotpCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const noTotpPage = await noTotpCtx.newPage();
    await noTotpPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });

    for (let i = 1; i <= 3; i++) {
      await noTotpPage.locator('input[type="password"]').fill(`r31-wrong-nototp-${i}`);
      await noTotpPage.click('button[type="submit"]');
      if (i < 3) {
        await noTotpPage.locator('text=密碼錯誤').waitFor({ state: 'visible', timeout: 5000 });
      }
    }

    const noTotpLock = noTotpPage.locator('[data-testid="admin-lock-screen"]');
    await noTotpLock.waitFor({ state: 'visible', timeout: 8000 });
    const noTotpText = await noTotpLock.innerText();
    assert.ok(noTotpText.includes('後台已鎖定。尚未設定驗證器，請聯絡店主從伺服器解鎖。'));
    assert.equal(await noTotpPage.locator('[data-testid="admin-unlock-input"]').count(), 0);

    const shot4 = path.join(SCREENSHOT_DIR, 'round31_shot4_login_locked_no_totp.png');
    await noTotpPage.screenshot({ path: shot4, fullPage: true });
    console.log(`Saved Screenshot 4: ${shot4}`);

    await noTotpCtx.close();
    console.log('✅ Round 31 Items 4 & 5 Admin Login Guard Playwright Test PASSED!');
  } finally {
    await browser.close().catch(() => {});
    await resetGuardTables();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 31 Admin Login Guard Playwright Test Failed:', err);
  process.exit(1);
});

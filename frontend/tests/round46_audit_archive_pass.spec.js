import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });

const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function adminLogin(page) {
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  const pwdInput = page.locator('input[type="password"]');
  await pwdInput.waitFor({ state: 'visible', timeout: 10000 });
  await pwdInput.fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname.includes('/admin/'), { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
}

async function run() {
  console.log('--- Starting Round 46 Audit, Archive/Close & Pass Overview E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const futureStr = toTaipeiDateString(new Date(Date.now() + 18 * 86400000));
  const targetDate = dateOnly(futureStr);
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });

  const createdSessionIds = [];
  const createdPassIds = [];
  let testPlan = null;
  let testUser = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Seed test user, sessions, cancelled reservation, and passes
    testUser = await prisma.user.create({
      data: {
        line_user_id: `U_R46_E2E_${runId}`,
        name: `R46測試顧客${runId}`,
        phone: `0988${runId.padStart(6, '0')}`
      }
    });

    const sWithCancelled = await prisma.session.create({
      data: { session_date: targetDate, start_time: '10:00', end_time: '11:00', max_capacity: 16 }
    });
    const sEmpty = await prisma.session.create({
      data: { session_date: targetDate, start_time: '11:00', end_time: '12:00', max_capacity: 16 }
    });
    createdSessionIds.push(sWithCancelled.id, sEmpty.id);

    const cancelledRef = `R46-E2E-${crypto.randomUUID().slice(0, 8)}`;
    await prisma.reservation.create({
      data: {
        booking_ref: cancelledRef,
        session_id: sWithCancelled.id,
        user_id: testUser.id,
        pax: 2,
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_by: '測試店長'
      }
    });

    testPlan = await prisma.passPlan.create({
      data: {
        code: `r46_e2e_${runId}`,
        name: `R46十次券_${runId}`,
        pass_type: 'PUNCH_CARD',
        total_quota: 10,
        price: 1500,
        valid_days: 90
      }
    });

    const nowMs = Date.now();
    const soonPassCode = `PASS-R46S-${runId}`;
    const laterPassCode = `PASS-R46L-${runId}`;
    const pSoon = await prisma.userPass.create({
      data: {
        pass_code: soonPassCode,
        user_id: testUser.id,
        plan_id: testPlan.id,
        plan_name_snapshot: testPlan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 10,
        remaining_quota: 8,
        status: 'ACTIVE',
        expires_at: new Date(nowMs + 10 * 86400000)
      }
    });
    const pLater = await prisma.userPass.create({
      data: {
        pass_code: laterPassCode,
        user_id: testUser.id,
        plan_id: testPlan.id,
        plan_name_snapshot: testPlan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 10,
        remaining_quota: 10,
        status: 'ACTIVE',
        expires_at: new Date(nowMs + 75 * 86400000)
      }
    });
    createdPassIds.push(pSoon.id, pLater.id);

    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { weekday_hourly_price: 100 },
      create: { id: 1, weekday_hourly_price: 100 }
    });

    await adminLogin(page);

    // ---------------------------------------------------------
    // Part 1: Settings -> Change weekday_hourly_price -> Accounting Events 'setting' -> Diff Modal Screenshot
    // ---------------------------------------------------------
    await page.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    const weekdayCard = page.locator('div.bg-\\[\\#FAF7F2\\]', { hasText: '平日每小時 ($/hr)' });
    const weekdayInput = weekdayCard.locator('input[type="number"]');
    await weekdayInput.fill('135');
    await page.getByRole('button', { name: '儲存全店預設價格' }).click();
    await page.waitForTimeout(500);

    await page.goto(`${BASE_URL}/admin/accounting?tab=events`, { waitUntil: 'networkidle' });
    await page.getByTestId('event-category-chip-setting').click();
    await page.waitForTimeout(500);

    const settingRow = page.locator('tbody tr', { hasText: '平日每小時價格' }).first();
    await settingRow.waitFor({ state: 'visible', timeout: 10000 });
    await settingRow.click();

    await page.getByText('改前 / 改後對照').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('weekday_hourly_price').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round46_shot1_audit_diff.png') });
    console.log('Shot 1 saved: round46_shot1_audit_diff.png');

    // Close modal cleanly via Escape or close button
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ---------------------------------------------------------
    // Part 2a: Reservations -> Archive cancelled booking -> Gone from default list -> Visible in Archived filter
    // ---------------------------------------------------------
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    await page.getByTestId('scope-btn-all').click();
    await page.waitForTimeout(500);

    const resRow = page.locator(`tr[data-testid="reservation-card-${cancelledRef}"]`);
    await resRow.waitFor({ state: 'visible', timeout: 10000 });
    await resRow.click();

    const archiveBtn = page.getByTestId('archive-record-btn');
    await archiveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await archiveBtn.click();
    // Confirm panel
    await page.getByRole('button', { name: /^確認$/ }).click();
    await page.waitForTimeout(800);

    await resRow.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await resRow.isVisible(), false, 'Archived reservation must disappear from default list');

    await page.getByTestId('reservation-filter-archived').click();
    await page.waitForTimeout(600);
    await resRow.waitFor({ state: 'visible', timeout: 10000 });
    console.log('Archive filter verified.');

    // ---------------------------------------------------------
    // Part 2b: Sessions -> Delete all for targetDate -> "刪除 1 個、關閉 1 個" toast -> Screenshot 2
    // ---------------------------------------------------------
    await page.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });
    const dateInput = page.locator('input[type="date"]').first();
    await dateInput.fill(futureStr);
    await page.waitForTimeout(600);

    await page.locator('button[title="刪除當日所有未被預約時段"]').click();
    await page.getByRole('button', { name: '確認刪除' }).click();

    const toastLoc = page.getByText(/刪除 1 個、關閉 1 個（有已取消的預約紀錄）/);
    await toastLoc.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('已關閉').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round46_shot2_session_close_toast.png') });
    console.log('Shot 2 saved: round46_shot2_session_close_toast.png');

    // ---------------------------------------------------------
    // Part 3: Coupons -> Pass Overview Tab -> Expiring 30d Filter -> Revoke with reason -> Screenshot 3
    // ---------------------------------------------------------
    await page.goto(`${BASE_URL}/admin/coupons`, { waitUntil: 'networkidle' });
    await page.getByTestId('coupons-tab-all-passes').click();
    await page.getByTestId('pass-overview-summary').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId(`pass-overview-row-${soonPassCode}`).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId(`pass-overview-row-${laterPassCode}`).waitFor({ state: 'visible', timeout: 10000 });

    // Filter 30 days expiring -> only soonPassCode visible
    await page.getByTestId('filter-expiring-30d-btn').click();
    await page.waitForTimeout(500);
    await page.getByTestId(`pass-overview-row-${soonPassCode}`).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await page.getByTestId(`pass-overview-row-${laterPassCode}`).isVisible(),
      false,
      'Non-expiring pass must be filtered out when 30d expiring filter is active'
    );

    // Screenshot 3 of Pass Overview (filtered to 30d expiring)
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round46_shot3_pass_overview.png') });
    console.log('Shot 3 saved: round46_shot3_pass_overview.png');

    // Reset filter and revoke soonPassCode with mandatory reason
    await page.getByTestId('filter-expiring-30d-btn').click();
    await page.waitForTimeout(400);
    await page.getByTestId(`revoke-pass-btn-${soonPassCode}`).click();
    const statusModal = page.getByTestId('pass-status-modal');
    await statusModal.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.getByTestId('confirm-pass-status-btn').isDisabled(), true, 'Confirm revoke must be disabled without reason');
    await statusModal.getByRole('button', { name: '其他' }).click();
    await statusModal.locator('input[placeholder="請輸入原因..."]').fill('E2E 測試作廢原因');
    await page.getByTestId('confirm-pass-status-btn').click();
    await page.waitForTimeout(600);

    const revokedRow = page.getByTestId(`pass-overview-row-${soonPassCode}`);
    await revokedRow.getByText('已作廢').waitFor({ state: 'visible', timeout: 10000 });
    console.log('Pass revoke verified -> 已作廢.');

    console.log('ALL ROUND 46 E2E ASSERTIONS PASSED!');
  } finally {
    await browser.close();
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: { weekday_hourly_price: origGlobal.weekday_hourly_price }
      });
    }
    await cleanOperationalData(prisma);
    if (createdPassIds.length > 0) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } });
    }
    if (testPlan) {
      await prisma.passPlan.deleteMany({ where: { id: testPlan.id } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (testUser) {
      await prisma.user.deleteMany({ where: { id: testUser.id } });
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 46 E2E failed:', err);
  process.exit(1);
});

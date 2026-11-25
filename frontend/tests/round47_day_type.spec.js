import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dotenv = require('../../backend/node_modules/dotenv/lib/main.js');
dotenv.config({ path: path.resolve(__dirname, '../../backend/.env') });
const jwt = require('../../backend/node_modules/jsonwebtoken');

const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim() || !process.env.JWT_SECRET?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 與 JWT_SECRET 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();
const JWT_SECRET = process.env.JWT_SECRET.trim();

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
  console.log('--- Starting Round 47 Day Type & Temporary Closure E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const targetStr = '2026-12-02';
  const openStr = '2026-12-03';
  const targetDate = dateOnly(targetStr);
  const openDate = dateOnly(openStr);
  const poolAccNum = `8220${runId}99`;

  const createdSessionIds = [];
  const createdUserIds = [];
  const createdRefs = [];
  const passPlanCode = `R47E2E_PLAN_${runId}`;
  const passCode = `R47E2EPASS${runId.slice(-4)}`;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const adminPage = await adminCtx.newPage();

  const custCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const custPage = await custCtx.newPage();

  try {
    const ensureSession = async (session_date, start_time, end_time) => {
      const ex = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date, start_time } }
      });
      if (ex) {
        if (ex.closed_at) {
          return prisma.session.update({ where: { id: ex.id }, data: { closed_at: null, closed_by: null } });
        }
        return ex;
      }
      const s = await prisma.session.create({
        data: { session_date, start_time, end_time, max_capacity: 20 }
      });
      createdSessionIds.push(s.id);
      return s;
    };

    const [sClosed, sOpen] = await Promise.all([
      ensureSession(targetDate, '13:00', '15:00'),
      ensureSession(openDate, '13:00', '15:00')
    ]);
    await prisma.dailySetting.deleteMany({ where: { date: { in: [targetDate, openDate] } } });

    const [uA, uB, uC, uD, uE] = await Promise.all([
      prisma.user.create({ data: { name: '林可取消有Line', phone: `0911${runId}`, line_user_id: `U_R47E2E_A_${runId}` } }),
      prisma.user.create({ data: { name: '陳可取消無Line', phone: `0912${runId}`, line_user_id: `manual_R47E2E_B_${runId}` } }),
      prisma.user.create({ data: { name: '王需退款', phone: `0913${runId}`, line_user_id: `U_R47E2E_C_${runId}` } }),
      prisma.user.create({ data: { name: '張卡券已扣', phone: `0914${runId}`, line_user_id: `U_R47E2E_D_${runId}` } }),
      prisma.user.create({ data: { name: '周待對帳', phone: `0915${runId}`, line_user_id: `U_R47E2E_E_${runId}` } })
    ]);
    createdUserIds.push(uA.id, uB.id, uC.id, uD.id, uE.id);

    const plan = await prisma.passPlan.create({
      data: { code: passPlanCode, name: 'R47E2E計次卡', pass_type: 'PUNCH_CARD', price: 1000, total_quota: 5, is_active: true }
    });
    const passD = await prisma.userPass.create({
      data: {
        user_id: uD.id,
        plan_id: plan.id,
        pass_code: passCode,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 4,
        payment_status: 'active',
        status: 'ACTIVE',
        expires_at: dateOnly('2099-12-31')
      }
    });
    await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: 'ctbc_pool',
        account_number: poolAccNum,
        status: 'ASSIGNED',
        assigned_order_ref: `R47E2E-E-${runId}`
      }
    });

    const refA = `R47E2E-A-${runId}`;
    const refB = `R47E2E-B-${runId}`;
    const refC = `R47E2E-C-${runId}`;
    const refD = `R47E2E-D-${runId}`;
    const refE = `R47E2E-E-${runId}`;
    createdRefs.push(refA, refB, refC, refD, refE);

    await prisma.reservation.createMany({
      data: [
        { booking_ref: refA, session_id: sClosed.id, user_id: uA.id, pax: 2, status: 'confirmed' },
        { booking_ref: refB, session_id: sClosed.id, user_id: uB.id, pax: 1, status: 'confirmed' },
        { booking_ref: refC, session_id: sClosed.id, user_id: uC.id, pax: 2, status: 'confirmed', amount_received: 600, billing_status: 'paid', is_paid: true },
        { booking_ref: refD, session_id: sClosed.id, user_id: uD.id, pax: 1, status: 'confirmed', billing_status: 'paid', is_paid: true },
        { booking_ref: refE, session_id: sClosed.id, user_id: uE.id, pax: 1, status: 'confirmed', is_self_service: true }
      ]
    });

    await prisma.payment.createMany({
      data: [
        {
          payment_no: `PAY-R47E-C-${runId}`,
          batch_no: `B-R47E-C-${runId}`,
          booking_ref: refC,
          method: 'cash',
          kind: 'charge',
          amount: 600,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {}
        },
        {
          payment_no: `PAY-R47E-D-${runId}`,
          batch_no: `B-R47E-D-${runId}`,
          booking_ref: refD,
          method: 'pass',
          kind: 'charge',
          amount: 0,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          pass_json: [{ user_pass_id: passD.id, units: 1, pass_code: passCode, plan_name: plan.name }]
        }
      ]
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refE,
        user_id: uE.id,
        total_amount: 800,
        amount_due: 800,
        status: 'reported_pending_verify',
        remittance_last5: '54321',
        assigned_pool_account: poolAccNum,
        deadline_at: new Date('2026-12-01T12:00:00+08:00')
      }
    });

    // Step 1: Admin sets 2026-12-02 to closed with note '設備維修'
    await adminLogin(adminPage);
    await adminPage.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });

    // Ensure calendar displays 2026-12
    for (let i = 0; i < 6; i++) {
      const visible = await adminPage.locator(`[data-testid="admin-calendar-day-${targetStr}"]`).isVisible().catch(() => false);
      if (visible) break;
      await adminPage.locator('button:has(svg.lucide-chevron-right)').first().click();
      await adminPage.waitForTimeout(200);
    }

    await adminPage.locator(`[data-testid="admin-calendar-day-${targetStr}"]`).click();
    await adminPage.waitForTimeout(300);

    await adminPage.locator('[data-testid="day-type-opt-closed"]').click();
    await adminPage.locator('[data-testid="closed-note-input"]').fill('設備維修');
    await adminPage.locator('[data-testid="save-daily-self-service-btn"]').click();
    await adminPage.locator('[data-testid="closure-impact-panel"]').waitFor({ state: 'visible', timeout: 8000 });
    await adminPage.waitForTimeout(400);

    const calCellText = await adminPage.locator(`[data-testid="admin-calendar-day-${targetStr}"]`).innerText();
    assert.ok(calCellText.includes('休'), `Expected 休 badge on ${targetStr}, got: ${calCellText}`);

    await adminPage.locator('[data-testid="day-type-selector"]').scrollIntoViewIfNeeded();
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round47_shot1_admin_calendar.png'), fullPage: true });

    // Step 2: Customer calendar shows 12/2 disabled with '公休' and shows note when clicked
    const custToken = jwt.sign(
      { id: uA.id, typ: 'customer', role: 'customer', name: uA.name },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    await custPage.addInitScript((tok) => {
      sessionStorage.setItem('shiguang_auth_token', tok);
    }, custToken);

    await custPage.goto(`${BASE_URL}/booking?step=1`, { waitUntil: 'networkidle' });
    await custPage.locator('button:has-text("整月")').first().click();
    await custPage.waitForTimeout(300);

    // Advance customer calendar month to 2026-12 if needed
    for (let i = 0; i < 6; i++) {
      const vis = await custPage.locator(`[data-testid="customer-calendar-day-${targetStr}"]`).isVisible().catch(() => false);
      if (vis) break;
      await custPage.locator('button[aria-label="下個月"]').first().click();
      await custPage.waitForTimeout(200);
    }

    const custDayBtn = custPage.locator(`[data-testid="customer-calendar-day-${targetStr}"]`);
    await custDayBtn.waitFor({ state: 'visible', timeout: 8000 });
    const custBtnText = await custDayBtn.innerText();
    assert.ok(custBtnText.includes('公休'), `Expected 公休 badge on customer calendar ${targetStr}, got: ${custBtnText}`);
    assert.equal(await custDayBtn.getAttribute('aria-disabled'), 'true');
    await custDayBtn.click({ force: true });
    await custPage.locator('[data-testid="closed-date-notice"]').waitFor({ state: 'visible', timeout: 5000 });
    const noticeText = await custPage.locator('[data-testid="closed-date-notice"]').innerText();
    assert.ok(noticeText.includes('設備維修'), `Expected 設備維修 in notice, got: ${noticeText}`);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round47_shot2_customer_calendar.png'), fullPage: false });

    // Step 3: Screenshot 3 - Admin closure impact 4 groups
    const impactPanel = adminPage.locator('[data-testid="closure-impact-panel"]');
    await impactPanel.scrollIntoViewIfNeeded();
    assert.equal(await adminPage.locator('[data-testid="impact-count-direct"]').innerText(), '2');
    assert.equal(await adminPage.locator('[data-testid="impact-count-refund"]').innerText(), '1');
    assert.equal(await adminPage.locator('[data-testid="impact-count-pass"]').innerText(), '1');
    assert.equal(await adminPage.locator('[data-testid="impact-count-pending"]').innerText(), '1');
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round47_shot3_closure_impact.png'), fullPage: true });

    // Step 4: Open batch cancel modal, edit announcement, verify live preview, screenshot 4, submit
    await adminPage.locator('[data-testid="open-closure-cancel-btn"]').click();
    await adminPage.locator('[data-testid="closure-cancel-modal"]').waitFor({ state: 'visible', timeout: 5000 });

    const notifyBox = adminPage.locator('[data-testid="closure-notify-checkbox"]');
    if (!(await notifyBox.isChecked())) await notifyBox.check();

    const customMsg = '拾光製所 {日期} 因{店家說明}臨時公休，您預約的 {時段}（{人數} 位）已取消，請改約其他時段。';
    await adminPage.locator('[data-testid="closure-announcement-input"]').fill(customMsg);
    const previewText = await adminPage.locator('[data-testid="closure-announcement-preview"]').innerText();
    assert.ok(previewText.includes(targetStr) && previewText.includes('設備維修'));
    await adminPage.waitForTimeout(300);
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round47_shot4_closure_preview.png'), fullPage: false });

    await adminPage.locator('[data-testid="closure-cancel-submit-btn"]').click();
    await adminPage.locator('[data-testid="closure-cancel-result"]').waitFor({ state: 'visible', timeout: 8000 });
    const resultText = await adminPage.locator('[data-testid="closure-cancel-result"]').innerText();
    assert.ok(resultText.includes('已取消 2 筆'), `Expected 已取消 2 筆, got: ${resultText}`);
    assert.ok(resultText.includes('已推播 LINE 1 筆'), `Expected 已推播 LINE 1 筆, got: ${resultText}`);
    assert.ok(resultText.includes('沒有 LINE 1 筆'), `Expected 沒有 LINE 1 筆, got: ${resultText}`);

    console.log('--- Round 47 Day Type & Temporary Closure E2E PASSED ---');
  } finally {
    await adminCtx.close();
    await custCtx.close();
    await browser.close();
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: poolAccNum } });
    await prisma.userPass.deleteMany({ where: { pass_code: passCode } });
    await prisma.passPlan.deleteMany({ where: { code: passPlanCode } });
    if (createdUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdSessionIds.length > 0) await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: [targetDate, openDate] } } });
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 47 E2E Failed:', err);
  process.exit(1);
});

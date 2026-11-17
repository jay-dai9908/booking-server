import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded, cleanOperationalData } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const require = createRequire(import.meta.url);
const jwt = require('../../backend/node_modules/jsonwebtoken/index.js');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const HEADLESS = process.env.HEADLESS !== 'false';

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve('tests/screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function run() {
  console.log('--- Starting Round 25 Self-Service Day Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const targetDateStr = addDaysYmd(todayStr, 3);
  const targetDateObj = dateOnly(targetDateStr);
  const [, tMonthNum, tDayNum] = targetDateStr.split('-').map(Number);

  let createdLayoutId = null;
  let customerUser = null;
  let createdPlanId = null;
  let createdPromoId = null;
  let savedSmallCfg = null;

  try {
    // 0. Ensure published layout with seats exists
    const activeLayouts = await prisma.seatLayout.findMany({
      where: { status: 'published' },
      include: { tables: { include: { seats: true } } }
    });
    if (activeLayouts.length === 0) {
      const l = await prisma.seatLayout.create({
        data: {
          name: `R25-E2E-Layout-${Date.now()}`,
          status: 'published',
          effective_from: dateOnly(todayStr),
          capacity: 16,
          tables: {
            create: {
              label: '桌 1',
              shape: 'rect',
              cx: 200,
              cy: 200,
              w: 80,
              h: 120,
              seats: {
                create: Array.from({ length: 16 }, (_, i) => ({
                  code: `E${i + 1}`,
                  seat_no: i + 1,
                  offset_x: (i % 4) * 30,
                  offset_y: Math.floor(i / 4) * 30,
                  is_active: true
                }))
              }
            }
          }
        }
      });
      createdLayoutId = l.id;
    }

    // Seed transfer payment methods + pool account
    await prisma.paymentMethodConfig.upsert({
      where: { code: 'ctbc_pool' },
      update: { is_enabled: true, method_type: 'POOL_ACCOUNT' },
      create: {
        code: 'ctbc_pool',
        name: '中信專屬轉帳帳號',
        method_type: 'POOL_ACCOUNT',
        is_enabled: true,
        sort_order: 1
      }
    });
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: '82288881111' } });
    await prisma.oneTimeAccountPool.create({
      data: {
        payment_method_code: 'ctbc_pool',
        account_number: '82288881111',
        status: 'AVAILABLE'
      }
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 3 },
      create: { id: 1, early_minutes: 30, after_close_minutes: 60, prepay_deadline_hour: 12, max_unpaid_self_bookings: 3 }
    });

    // Save current pegboard_s config to restore later
    savedSmallCfg = await prisma.equipmentConfig.findUnique({ where: { id: 'pegboard_s' } });

    // Seed sessions on targetDateStr (13:00 - 21:00)
    await prisma.session.deleteMany({ where: { session_date: targetDateObj } });
    await prisma.dailySetting.deleteMany({ where: { date: targetDateObj } });
    for (let h = 13; h < 21; h++) {
      await prisma.session.create({
        data: {
          session_date: targetDateObj,
          start_time: `${String(h).padStart(2, '0')}:00`,
          end_time: `${String(h + 1).padStart(2, '0')}:00`,
          max_capacity: 16
        }
      });
    }

    // Seed customer user + punch card + promo for combo screenshot
    customerUser = await prisma.user.upsert({
      where: { line_user_id: 'r25_e2e_customer' },
      update: { name: 'R25測試顧客', phone: '0912345678', is_blacklisted: false },
      create: { line_user_id: 'r25_e2e_customer', name: 'R25測試顧客', phone: '0912345678' }
    });

    const plan = await prisma.passPlan.upsert({
      where: { code: 'r25_e2e_punch' },
      update: { pass_type: 'PUNCH_CARD', checkout_effect: 'entry_full', is_active: true },
      create: {
        code: 'r25_e2e_punch',
        name: '計次不限時卡（5次）',
        pass_type: 'PUNCH_CARD',
        price: 3000,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    createdPlanId = plan.id;

    await prisma.userPass.create({
      data: {
        pass_code: `PASS-E2E-${Date.now()}`,
        user_id: customerUser.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    await prisma.promoCode.deleteMany({ where: { code: 'R25E2E100' } });
    const promo = await prisma.promoCode.create({
      data: {
        code: 'R25E2E100',
        name: 'E2E整單折100',
        discount_type: 'fixed_order',
        discount_value: 100,
        target_scope: 'all',
        min_pax: 1,
        min_hours: 1,
        is_active: true
      }
    });
    createdPromoId = promo.id;

    // Customer auth token
    let customerToken = null;
    try {
      const loginRes = await fetch(`${API_BASE}/auth/test-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: customerUser.id, role: 'customer' })
      });
      if (loginRes.ok) {
        const d = await loginRes.json();
        customerToken = d.token;
      }
    } catch {}
    if (!customerToken) {
      if (!process.env.JWT_SECRET?.trim()) {
        throw new Error('需要 JWT_SECRET 或 /api/auth/test-login 以產生測試顧客登入 Token');
      }
      customerToken = jwt.sign(
        { id: customerUser.id, role: 'customer', name: customerUser.name, phone: customerUser.phone },
        process.env.JWT_SECRET.trim(),
        { expiresIn: '1d' }
      );
    }

    const launchOptions = { headless: HEADLESS };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    const browser = await chromium.launch(launchOptions);

    // =========================================================================
    // DESKTOP ADMIN CONTEXT
    // =========================================================================
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const adminPage = await adminContext.newPage();

    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await adminPage.click('button[type="submit"]');
    await adminPage.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    await adminPage.waitForTimeout(300);

    // -------------------------------------------------------------------------
    // STEP 1 + Screenshot 4: Equipment self-service config + SessionsPage self-service toggle
    // -------------------------------------------------------------------------
    await adminPage.goto(`${BASE_URL}/admin/equipment`, { waitUntil: 'networkidle' });
    const selfEqSection = adminPage.locator('[data-testid="equipment-self-section-pegboard_s"]');
    await selfEqSection.waitFor({ state: 'visible', timeout: 10000 });
    const eqEnabledToggle = adminPage.locator('[data-testid="equipment-self-enabled-pegboard_s"]');
    if (!(await eqEnabledToggle.isChecked())) {
      await eqEnabledToggle.check();
    }
    await adminPage.locator('[data-testid="equipment-self-rate-pegboard_s"]').fill('80');
    await adminPage.locator('[data-testid="equipment-self-cap-pegboard_s"]').fill('240');
    await adminPage.locator('[data-testid="equipment-self-stock-pegboard_s"]').fill('2');
    // Save pegboard_s via the save button in its row/card
    const pegCard = adminPage.locator('div', { has: selfEqSection }).filter({ has: adminPage.locator('button:has-text("儲存")') }).last();
    await pegCard.locator('button:has-text("儲存")').click();
    await adminPage.waitForTimeout(500);
    await selfEqSection.scrollIntoViewIfNeeded();
    await adminPage.waitForTimeout(200);
    const shot4 = path.join(SCREENSHOT_DIR, 'round25_shot4_equipment_admin.png');
    await adminPage.screenshot({ path: shot4 });
    console.log(`Saved Screenshot 4: ${shot4}`);

    // Now configure targetDateStr as self-service day in SessionsPage (Step 1)
    await adminPage.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });
    const listDateInput = adminPage.locator(`input[type="date"][value="${todayStr}"]`).or(
      adminPage.locator('input[type="date"]').first()
    );
    await listDateInput.fill(targetDateStr);
    await adminPage.waitForTimeout(400);

    const selfToggle = adminPage.locator('[data-testid="daily-self-service-toggle"]');
    await selfToggle.waitFor({ state: 'attached', timeout: 10000 });
    if (!(await selfToggle.isChecked())) {
      await selfToggle.locator('..').click();
    }
    const allowEqToggle = adminPage.locator('[data-testid="daily-self-allow-equipment-toggle"]');
    await allowEqToggle.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await allowEqToggle.isChecked())) {
      await allowEqToggle.check();
    }
    await adminPage.locator('[data-testid="iron-mode-next"]').click();
    await adminPage.locator('[data-testid="save-daily-self-service-btn"]').click();
    await adminPage.locator(`text=已儲存 ${targetDateStr}`).waitFor({ state: 'visible', timeout: 8000 });
    console.log(`Step 1 passed: configured ${targetDateStr} as self-service day.`);

    // =========================================================================
    // MOBILE CUSTOMER CONTEXT (390x844)
    // =========================================================================
    const customerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2
    });
    await customerContext.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch {}
    }, customerToken);
    const custPage = await customerContext.newPage();

    // -------------------------------------------------------------------------
    // STEP 2 + Screenshot 1: Customer picks targetDateStr -> sees info card -> all-transfer booking
    // -------------------------------------------------------------------------
    await custPage.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    const targetDayBtn = custPage.locator(`button[aria-label*="${tMonthNum} 月 ${tDayNum} 日"]`).first();
    await targetDayBtn.waitFor({ state: 'visible', timeout: 10000 });
    await targetDayBtn.click();

    const infoCard = custPage.locator('[data-testid="self-service-info-card"]');
    await infoCard.waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('text=這天是半自助時段').waitFor({ state: 'visible', timeout: 5000 });
    await custPage.waitForTimeout(300);

    const shot1 = path.join(SCREENSHOT_DIR, 'round25_shot1_booking_info_card.png');
    await custPage.screenshot({ path: shot1 });
    console.log(`Saved Screenshot 1: ${shot1}`);

    // Step 1 -> Step 2 -> Step 3 (keep 1 pax, 0 boards, all transfer)
    await custPage.locator('button:has-text("下一步")').click();
    await custPage.waitForURL('**/booking?step=2', { timeout: 8000 });
    await custPage.locator('button:has-text("下一步")').click();
    await custPage.waitForURL('**/booking?step=3', { timeout: 8000 });

    const submitBtn = custPage.locator('button:has-text("送出預約")');
    await submitBtn.waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await submitBtn.isDisabled(), true, 'Must disable submit until self-service ack checkbox is checked');

    await custPage.locator('[data-testid="self-ack-checkbox"]').check();
    await custPage.locator('[data-testid="self-quote-transfer-amount"]').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.waitForTimeout(200);
    assert.equal(await submitBtn.isEnabled(), true, 'Submit should enable once ack is checked and quote loaded');

    await submitBtn.click();
    await custPage.waitForURL('**/booking?step=done**', { timeout: 12000 });
    await custPage.locator('text=預約已保留，付款後才成立').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('[data-testid="prepay-transfer-card"]').waitFor({ state: 'visible', timeout: 8000 });
    console.log('Step 2 passed: all-transfer booking created cleanly in pending_payment.');

    // -------------------------------------------------------------------------
    // BONUS Screenshot 2: Mobile StepConfirm with 3 pax, 1 pass, 1 smart board, promo
    // -------------------------------------------------------------------------
    await custPage.evaluate(() => sessionStorage.removeItem('shiguang_booking_draft'));
    await custPage.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await custPage.locator(`button[aria-label*="${tMonthNum} 月 ${tDayNum} 日"]`).first().click();
    await custPage.locator('[data-testid="self-service-info-card"]').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('button:has-text("下一步")').click();
    await custPage.waitForURL('**/booking?step=2', { timeout: 8000 });

    // Increase pax from 1 -> 3
    const paxPlusBtn = custPage.locator('button[aria-label="增加人數"]');
    await paxPlusBtn.click();
    await paxPlusBtn.click();

    // Add 1 smart board (小板)
    await custPage.locator('button[aria-label="增加小板"]').first().click();
    await custPage.locator('button:has-text("下一步")').click();
    await custPage.waitForURL('**/booking?step=3', { timeout: 8000 });

    const payCard = custPage.locator('[data-testid="self-payment-card"]');
    await payCard.waitFor({ state: 'visible', timeout: 8000 });

    // Use 1 punch card (+ button inside pass row)
    const passRow = custPage.locator('[data-testid^="self-pass-row-"]').first();
    await passRow.waitFor({ state: 'visible', timeout: 8000 });
    await passRow.locator('button').last().click();

    // Apply promo R25E2E100
    await custPage.locator('input[placeholder="輸入折扣碼"]').fill('R25E2E100');
    await custPage.locator('button:has-text("套用")').click();
    await custPage.locator('text=已套用 R25E2E100').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('text=入場費 用卡 1 位').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.waitForTimeout(300);
    await payCard.scrollIntoViewIfNeeded();
    await custPage.waitForTimeout(200);

    const shot2 = path.join(SCREENSHOT_DIR, 'round25_shot2_confirm_combo.png');
    await custPage.screenshot({ path: shot2 });
    console.log(`Saved Screenshot 2: ${shot2}`);

    // Clear draft so History doesn't keep half-baked draft
    await custPage.evaluate(() => sessionStorage.removeItem('shiguang_booking_draft'));

    // -------------------------------------------------------------------------
    // STEP 3: Customer reports remittance last5 on /history?tab=bookings
    // -------------------------------------------------------------------------
    await custPage.goto(`${BASE_URL}/history?tab=bookings`, { waitUntil: 'networkidle' });
    const last5Input = custPage.locator('[data-testid="prepay-last5-input"]').first();
    await last5Input.waitFor({ state: 'visible', timeout: 8000 });
    await last5Input.fill('54321');
    await custPage.locator('[data-testid="prepay-report-btn"]').first().click();

    await custPage.locator('[data-testid^="list-prepay-reported-"]').first().waitFor({ state: 'visible', timeout: 8000 });
    await custPage.locator('text=已回報，等店員對帳').first().waitFor({ state: 'visible', timeout: 5000 });
    console.log('Step 3 passed: customer reported remittance 54321, status updated to reported_pending_verify.');

    // -------------------------------------------------------------------------
    // STEP 4 + Screenshot 3: Admin reconciles & clicks 確認收款
    // -------------------------------------------------------------------------
    await adminPage.goto(`${BASE_URL}/admin/reservations?tab=prepays`, { waitUntil: 'networkidle' });
    const prepayRow = adminPage.locator('[data-testid^="prepay-row-"]').first();
    await prepayRow.waitFor({ state: 'visible', timeout: 10000 });
    await prepayRow.locator('text=54321').waitFor({ state: 'visible', timeout: 5000 });
    await adminPage.waitForTimeout(300);

    const shot3 = path.join(SCREENSHOT_DIR, 'round25_shot3_admin_prepays.png');
    await adminPage.screenshot({ path: shot3 });
    console.log(`Saved Screenshot 3: ${shot3}`);

    await adminPage.locator('[data-testid^="prepay-verify-btn-"] >> visible=true').first().click();
    await adminPage.locator('[role="dialog"] h4:has-text("確認已收到匯款並入帳")').waitFor({ state: 'visible', timeout: 5000 });
    // Click Confirm button inside ConfirmPanel
    await adminPage.locator('[role="dialog"] button:has-text("確認收款")').click();
    await adminPage.locator('text=目前沒有符合篩選條件的半自助預付紀錄').waitFor({ state: 'visible', timeout: 10000 });
    console.log('Step 4 passed: admin verified prepay booking.');

    // -------------------------------------------------------------------------
    // STEP 5: Customer History updates to 付款已確認
    // -------------------------------------------------------------------------
    await custPage.reload({ waitUntil: 'networkidle' });
    await custPage.locator('[data-testid^="list-prepay-verified-"]').first().waitFor({ state: 'visible', timeout: 10000 });
    await custPage.locator('text=付款已確認').first().waitFor({ state: 'visible', timeout: 5000 });
    console.log('Step 5 passed: customer history now displays verified status.');

    await browser.close();
    console.log('--- Round 25 Playwright Test PASSED ---');
  } finally {
    await cleanOperationalData(prisma).catch(() => {});
    await prisma.oneTimeAccountPool.deleteMany({ where: { account_number: '82288881111' } }).catch(() => {});
    await prisma.session.deleteMany({ where: { session_date: targetDateObj } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: targetDateObj } }).catch(() => {});
    if (createdPromoId) {
      await prisma.promoCode.deleteMany({ where: { id: createdPromoId } }).catch(() => {});
    }
    if (createdPlanId) {
      await prisma.userPass.deleteMany({ where: { plan_id: createdPlanId } }).catch(() => {});
      await prisma.passPlan.deleteMany({ where: { id: createdPlanId } }).catch(() => {});
    }
    if (createdLayoutId) {
      await prisma.seatLayout.deleteMany({ where: { id: createdLayoutId } }).catch(() => {});
    }
    if (savedSmallCfg) {
      await prisma.equipmentConfig.update({
        where: { id: 'pegboard_s' },
        data: {
          visibility_status: savedSmallCfg.visibility_status,
          hourly_rate: savedSmallCfg.hourly_rate,
          daily_cap: savedSmallCfg.daily_cap,
          total_stock: savedSmallCfg.total_stock,
          self_enabled: savedSmallCfg.self_enabled,
          self_hourly_rate: savedSmallCfg.self_hourly_rate,
          self_daily_cap: savedSmallCfg.self_daily_cap,
          self_stock: savedSmallCfg.self_stock
        }
      }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 25 E2E FAILED:', err);
  process.exit(1);
});

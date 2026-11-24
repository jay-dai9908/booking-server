// frontend/tests/round36_void_supplement_closing.spec.js
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

const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString } = await import('../../shared/time.js');

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

async function run() {
  console.log('--- Starting Round 36 Void Lock, Supplement Change, & Shift Closing Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const runId = Date.now().toString().slice(-6);
  const nowMs = Date.now();
  const todayStr = toTaipeiDateString(new Date(nowMs));
  const todayStart = new Date(`${todayStr}T00:00:00+08:00`);
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
  // Use a same-day timestamp guaranteed to be before `now` even right after midnight
  const shift1End = new Date(Math.max(todayStart.getTime() + 60 * 1000, nowMs - 2 * 60 * 60 * 1000));
  const shift2PayAt = new Date(Math.min(nowMs - 5 * 1000, shift1End.getTime() + 60 * 1000));

  const yestDate = new Date(nowMs - 24 * 60 * 60 * 1000);
  const refYesterday = `BK-R36Y-${runId}`;
  const refSupplement = `BK-R36S-${runId}`;
  const createdRefs = [refYesterday, refSupplement];
  const createdClosingIds = [];

  const origGs = await prisma.globalSetting.findFirst();
  const origFloat = origGs?.cash_float_amount;
  if (origGs) {
    await prisma.globalSetting.update({ where: { id: origGs.id }, data: { cash_float_amount: 2000 } });
  }

  const origDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  await prisma.dailySetting.upsert({
    where: { date: todayDate },
    update: { hourly_price: 200, unlimited_price: 800, allow_unlimited: true, is_self_service: false },
    create: { date: todayDate, hourly_price: 200, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
  });

  const existingSession = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '14:00' } }
  });
  const session = existingSession || await prisma.session.create({
    data: { session_date: todayDate, start_time: '14:00', end_time: '16:00', max_capacity: 20 }
  });

  const user = await prisma.user.create({
    data: {
      line_user_id: `r36_e2e_${runId}`,
      name: `R36測試客_${runId}`,
      phone: `09968${runId.slice(-5)}` // check-secrets: fake-data
    }
  });

  // 1. Booking with yesterday cash payment (NT$500) -> can_void = false
  await prisma.reservation.create({
    data: {
      booking_ref: refYesterday,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1-1'],
      status: 'confirmed',
      attendance: 'completed',
      is_paid: true,
      billing_status: 'paid',
      amount_due: 500,
      amount_received: 500,
      total_amount: 500,
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refYesterday, person_no: 1, seat_code: 'A1-1', status: 'active' }
  });
  const yPay = await prisma.payment.create({
    data: {
      payment_no: `R-26Y-${runId}`,
      batch_no: `B-R36Y-${runId}`,
      booking_ref: refYesterday,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 500,
      person_nos: [1],
      breakdown_json: {
        persons: [{ person_no: 1, seat_code: 'A1-1', entry: { mode: 'hourly', hours: 2, amount: 500 }, board: { amount: 0, units: [] }, addons: [], shares: [], promos: [], total: 500 }]
      },
      staff_name: '昨班櫃檯',
      device_label: '櫃檯A',
      created_at: yestDate
    }
  });

  // 2. Booking with paid person 1 + pending_supplement 120 (added_after_payment)
  await prisma.reservation.create({
    data: {
      booking_ref: refSupplement,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1-2'],
      status: 'confirmed',
      attendance: 'checked_in',
      is_paid: true,
      billing_status: 'partial',
      amount_due: 400,
      amount_received: 400,
      total_amount: 520,
      checkout_details: {
        version: 2,
        persons: [{ person_no: 1, mode: 'hourly' }],
        order_addons: [
          { key: 'post_120', name: '補掛配件組', price: 120, qty: 1, added_after_payment: true, include_paid: true, split: { mode: 'even' } }
        ]
      }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refSupplement, person_no: 1, seat_code: 'A1-2', status: 'active' }
  });
  await prisma.payment.create({
    data: {
      payment_no: `R-26S-${runId}`,
      batch_no: `B-R36S-${runId}`,
      booking_ref: refSupplement,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 400,
      person_nos: [1],
      breakdown_json: {
        persons: [{ person_no: 1, seat_code: 'A1-2', entry: { mode: 'hourly', hours: 2, amount: 400 }, board: { amount: 0, units: [] }, addons: [], shares: [], promos: [], total: 400 }]
      },
      staff_name: '早班店員',
      device_label: '櫃檯A',
      created_at: yestDate
    }
  });

  // 3. Seed Shift 1 earlier today (`todayStart` ~ `shift1End`) + a cash payment in Shift 2 (`+200`)
  const shift1 = await prisma.cashClosing.create({
    data: {
      business_date: todayDate,
      period_start_at: todayStart,
      period_end_at: shift1End,
      float_amount: 2000,
      expected_cash: 2300,
      counted_cash: 2300,
      handed_over_amount: 300,
      left_in_drawer: 2000,
      difference: 0,
      totals_json: {
        date: todayStr,
        period: { start_at: todayStart.toISOString(), end_at: shift1End.toISOString() },
        cash_income: 300,
        actual_received: 300,
        handed_over_amount: 300,
        left_in_drawer: 2000,
        by_method: { cash: { count: 1, amount: 300 } }
      },
      staff_name: '早班店員',
      device_label: '櫃檯A',
      created_at: shift1End
    }
  });
  createdClosingIds.push(shift1.id);

  await prisma.payment.create({
    data: {
      payment_no: `R-26C2-${runId}`,
      batch_no: `B-R36C2-${runId}`,
      booking_ref: refYesterday,
      kind: 'supplement',
      status: 'valid',
      method: 'cash',
      amount: 200,
      person_nos: [1],
      breakdown_json: { items: [{ type: 'other', label: '第二班加收', amount: 200 }] },
      staff_name: '晚班店員',
      device_label: '櫃檯A',
      created_at: shift2PayAt
    }
  });

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.locator('aside a[href="/admin/seating"]').waitFor({ state: 'visible', timeout: 10000 });

    // --- Test 1 (Item 2): Grayed-out void button for yesterday's payment -> "改用退款" opens Refund modal ---
    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tab-payments"]:visible').first().click();

    // Select 本月 (or set custom range starting from yesterday in case month just rolled)
    const yestStr = toTaipeiDateString(yestDate);
    if (yestStr.slice(0, 7) === todayStr.slice(0, 7)) {
      await page.locator('button:has-text("本月"):visible').first().click();
    } else {
      await page.locator('input[type="date"]').first().fill(yestStr);
    }

    const voidBtn = page.locator(`[data-testid="accounting-void-btn-${yPay.id}"]`);
    await voidBtn.waitFor({ state: 'visible', timeout: 10000 });
    await voidBtn.click();

    await page.getByText('已跨日或已交班，請用退款').waitFor({ state: 'visible', timeout: 10000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round36_shot1_void_locked_refund.png') });

    await page.getByRole('button', { name: '改用退款' }).click();
    const confirmRefundBtn = page.locator('[data-testid="confirm-refund-btn"]');
    await confirmRefundBtn.waitFor({ state: 'visible', timeout: 10000 });

    // --- Test 2 (Item 3): Pending supplement 120 -> CashPad 200 -> change NT$80 -> after confirm badge disappears ---
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const card = page.locator(`[data-testid="reservation-card-${refSupplement}"]:visible`).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();

    const checkoutBtn = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await checkoutBtn.waitFor({ state: 'visible', timeout: 10000 });
    await checkoutBtn.click();

    const splitBtn = page.locator('button:has-text("分開收款"):visible').first();
    await splitBtn.waitFor({ state: 'visible', timeout: 10000 });
    await splitBtn.click();

    const pendingBadge = page.locator('[data-testid="pending-supplement-badge-1"]');
    await pendingBadge.waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="split-person-supplement-btn"]').first().click();

    const supCashWrap = page.locator('[data-testid="supplement-cashpad"]');
    await supCashWrap.waitFor({ state: 'visible', timeout: 10000 });
    await supCashWrap.locator('[data-testid="cashpad-received-input"]').fill('200');
    await supCashWrap.getByText('NT$80').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round36_shot2_supplement_pending_cash.png') });

    await page.locator('[data-testid="confirm-supplement-btn"]').click();
    await page.waitForTimeout(600);

    // Reopen SplitCollectView -> verify pending_supplement badge is gone!
    const reopenSplit = page.locator('button:has-text("分開收款"):visible').first();
    if (await reopenSplit.isVisible().catch(() => false)) {
      await reopenSplit.click();
    } else {
      await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
      await page.locator(`[data-testid="reservation-card-${refSupplement}"]:visible`).first().click();
      await page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first().click();
      await page.locator('button:has-text("分開收款"):visible').first().click();
    }
    await page.locator('[data-testid="split-person-supplement-btn"]').first().waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-testid="pending-supplement-badge-1"]').count(), 0, 'Pending supplement badge must disappear after collection');

    // --- Test 3 (Item 4): Report uses "本月", switching to Closing tab still keeps todayStr ---
    await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="tab-payments"]:visible').first().click();
    await page.locator('button:has-text("本月"):visible').first().click();
    await page.locator('[data-testid="tab-closing"]:visible').first().click();

    const closingDateInput = page.locator('[data-testid="closing-date-input"]');
    await closingDateInput.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await closingDateInput.inputValue(), todayStr, 'Closing date must stay today even when report filter is 本月');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round36_shot3_closing_date_isolated.png') });

    // --- Test 4 (Item 5): Submit Shift 2 in UI (float 2000 from Shift 1 + 200 cash -> expected 2200) -> history lists 2 shifts ---
    const floatInput = page.locator('[data-testid="closing-float-input"]');
    assert.equal(await floatInput.inputValue(), '2000');
    assert.equal(await floatInput.isDisabled(), true, 'Second shift float should be locked to previous shift left_in_drawer');

    // Shift 2 includes both seeded +200 supplement and Test 2's +120 pending cash supplement -> expected 2320
    await page.locator('[data-testid="closing-counted-wrap"] input').fill('2320');
    await page.locator('[data-testid="closing-handed-wrap"] input').fill('320');
    await page.locator('[data-testid="submit-closing-btn"]').click();

    // Verify 2 shift closings listed cleanly
    const histList = page.locator('[data-testid="closing-history-list"]');
    await histList.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="closing-history-item-"]').length >= 2,
      { timeout: 10000 }
    );
    const itemsCount = await page.locator('[data-testid^="closing-history-item-"]').count();
    assert.ok(itemsCount >= 2, `Expected >= 2 closing history items, got ${itemsCount}`);
    await histList.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round36_shot4_two_shift_closings.png') });

    console.log('✅ Round 36 Void Lock, Supplement Change & Shift Closing Playwright Test PASSED!');
  } finally {
    await browser.close();
    const todayClosings = await prisma.cashClosing.findMany({ where: { business_date: todayDate } }).catch(() => []);
    for (const c of todayClosings) {
      await prisma.printJob.deleteMany({ where: { closing_id: c.id } }).catch(() => {});
      await prisma.cashClosing.delete({ where: { id: c.id } }).catch(() => {});
    }
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (!existingSession) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (origDaily) {
      await prisma.dailySetting.update({ where: { date: todayDate }, data: origDaily }).catch(() => {});
    } else {
      await prisma.dailySetting.delete({ where: { date: todayDate } }).catch(() => {});
    }
    if (origGs && origFloat !== undefined) {
      await prisma.globalSetting.update({ where: { id: origGs.id }, data: { cash_float_amount: origFloat } }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 36 Playwright Test failed:', err);
  process.exit(1);
});

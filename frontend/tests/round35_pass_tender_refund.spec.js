// frontend/tests/round35_pass_tender_refund.spec.js
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
  console.log('--- Starting Round 35 Pass Tender & Refund Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
  const bookingRef = `BK-R35E-${runId}`;

  const origDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  await prisma.dailySetting.upsert({
    where: { date: todayDate },
    update: { hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false },
    create: { date: todayDate, hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
  });

  const existingSession = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '14:00' } }
  });
  const session = existingSession || await prisma.session.create({
    data: { session_date: todayDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
  });

  const user = await prisma.user.create({
    data: {
      line_user_id: `r35_e2e_${runId}`,
      name: `R35測試客_${runId}`,
      phone: `09958${runId.slice(-5)}` // check-secrets: fake-data
    }
  });

  const equip = await prisma.equipmentConfig.create({
    data: {
      id: `r35_e2e_eq_${runId}`,
      name: 'R35智慧大板',
      hourly_rate: 200,
      total_stock: 5,
      min_contiguous_hours: 1,
      visibility_status: 'ACTIVE'
    }
  });

  const plan = await prisma.passPlan.create({
    data: {
      code: `R35_E2E_P_${runId}`,
      name: '暢玩計次卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });

  const userPass = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: plan.id,
      pass_code: `R35E-${runId}`,
      plan_name_snapshot: plan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 5,
      remaining_quota: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: new Date('2099-12-31T00:00:00.000Z')
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      user_id: user.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['A1-1'],
      status: 'confirmed',
      attendance: 'checked_in',
      is_unlimited: true,
      total_amount: 1000,
      checkout_details: {
        version: 2,
        persons: [{ person_no: 1, mode: 'unlimited' }]
      }
    }
  });

  const bp1 = await prisma.bookingPerson.create({
    data: { booking_ref: bookingRef, person_no: 1, seat_code: 'A1-1', status: 'active' }
  });

  await prisma.bookingEquipment.create({
    data: {
      booking_ref: bookingRef,
      equipment_id: equip.id,
      equipment_name_snapshot: equip.name,
      quantity: 1,
      rental_hours: 1,
      unit_rate: 200,
      subtotal_price: 200,
      person_id: bp1.id,
      covered_sessions: [`${session.start_time}-${session.end_time}`]
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

    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const row = page.locator('tr, [data-testid*="reservation"]').filter({ hasText: user.name }).first();
    await row.waitFor({ state: 'visible', timeout: 10000 });
    await row.getByRole('button', { name: '結帳' }).click();

    await page.locator('[data-testid="workbench-collect-btn"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="workbench-collect-btn"]').click();

    await page.locator('[data-testid="pay-method-pass"]').click();
    const passValueEl = page.locator(`[data-testid="pass-tender-value-${userPass.id}"]`);
    await passValueEl.waitFor({ state: 'visible', timeout: 10000 });
    const passValText = await passValueEl.textContent();
    assert.ok(passValText.includes('NT$800'), `Expected pass tender discount NT$800, got: ${passValText}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round35_shot1_pass_tender_sheet.png') });
    await page.getByRole('button', { name: '確認套用折抵' }).click();

    const collectBtn = page.getByRole('button', { name: '確認收款 NT$200' });
    await collectBtn.waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="cashpad-received-input"]').last().fill('300');
    await collectBtn.click();

    const completeView = page.locator('[data-testid="payment-complete-view"]');
    await completeView.waitFor({ state: 'visible', timeout: 10000 });
    const completeText = await completeView.textContent();
    assert.ok(completeText.includes('現金'), `Expected 現金 in complete view: ${completeText}`);
    assert.ok(completeText.includes('找零 NT$100'), `Expected 找零 NT$100 in complete view: ${completeText}`);
    assert.ok(completeText.includes('卡券折抵 NT$800'), `Expected 卡券折抵 NT$800 in complete view: ${completeText}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round35_shot2_pass_payment_complete.png') });

    // Close complete view, reopen collect view -> test pass refund modal
    await completeView.getByRole('button', { name: /完成/ }).first().click();
    await page.waitForTimeout(300);

    // Reopen CheckoutWorkbench -> SplitCollectView
    const row2 = page.locator('tr, [data-testid*="reservation"]').filter({ hasText: user.name }).first();
    await row2.getByRole('button', { name: '結帳' }).click();
    await page.locator('[data-testid="workbench-collect-btn"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid="workbench-collect-btn"]').click();

    await page.locator('[data-testid="split-person-refund-btn"]').first().click();
    await page.locator('[data-testid="refund-method-pass"]').click();
    const roAmount = page.locator('[data-testid="refund-pass-readonly-amount"]');
    await roAmount.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await roAmount.inputValue(), 'NT$800');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round35_shot3_pass_refund.png') });

    await page.getByPlaceholder('請填寫退款原因...').fill('E2E卡券退回測試');
    await page.locator('[data-testid="confirm-refund-btn"]').click();
    await page.waitForTimeout(500);

    const passAfterRefund = await prisma.userPass.findUnique({ where: { id: userPass.id } });
    assert.equal(passAfterRefund.remaining_quota, 3, 'Pass quota should be restored to 3 after UI pass refund');
    console.log('✅ Round 35 Pass Tender & Refund Playwright Test PASSED!');
  } finally {
    await browser.close();
    await prisma.printJob.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.userPass.delete({ where: { id: userPass.id } }).catch(() => {});
    await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    await prisma.equipmentConfig.delete({ where: { id: equip.id } }).catch(() => {});
    if (!existingSession) await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    if (origDaily) {
      await prisma.dailySetting.update({ where: { date: todayDate }, data: origDaily }).catch(() => {});
    } else {
      await prisma.dailySetting.delete({ where: { date: todayDate } }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 35 Playwright Test failed:', err);
  process.exit(1);
});

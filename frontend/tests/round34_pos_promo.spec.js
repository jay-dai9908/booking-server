// frontend/tests/round34_pos_promo.spec.js
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
  console.log('--- Starting Round 34 Item 2 POS Promo Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
  const bookingRef = `BK-R34P-${runId}`;
  const bookingRef600 = `BK-R34Z-${runId}`;
  const quickCode = `R34Q50_${runId}`;
  const quickName = `現場折50_${runId}`;
  const zhe9Code = `R34ZHE9_${runId}`;
  const zhe9Name = `九折體驗_${runId}`;

  await prisma.dailySetting.upsert({
    where: { date: todayDate },
    update: { hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false },
    create: { date: todayDate, hourly_price: 150, unlimited_price: 750, allow_unlimited: true, is_self_service: false }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: todayDate,
        start_time: '14:00'
      }
    },
    update: { end_time: '16:00', max_capacity: 20 },
    create: {
      session_date: todayDate,
      start_time: '14:00',
      end_time: '16:00',
      max_capacity: 20
    }
  });

  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r34p_${runId}`,
      name: '櫃檯優惠測試客',
      phone: `09887${runId.slice(-5)}` // check-secrets: fake-data
    }
  });

  // 1 pax * 2h * 150 = 300
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 1,
      status: 'confirmed',
      assigned_seats: ['A1-1'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      total_amount: 300,
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [{ person_no: 1, seat_code: 'A1-1', mode: 'hourly' }],
        order_addons: [],
        order_promos: []
      }
    }
  });

  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: 'A1-1',
      status: 'active',
      billing_start_at: new Date(),
      timer_started_at: new Date()
    }
  });

  // 2 pax * 2h * 150 = 600 (for Round 34 Item 5 check)
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef600,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A2-1', 'A2-2'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      total_amount: 600,
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [
          { person_no: 1, seat_code: 'A2-1', mode: 'hourly' },
          { person_no: 2, seat_code: 'A2-2', mode: 'hourly' }
        ],
        order_addons: [],
        order_promos: []
      }
    }
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: bookingRef600, person_no: 1, seat_code: 'A2-1', status: 'active', billing_start_at: new Date(), timer_started_at: new Date() },
      { booking_ref: bookingRef600, person_no: 2, seat_code: 'A2-2', status: 'active', billing_start_at: new Date(), timer_started_at: new Date() }
    ]
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // 1. Admin login
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(400);

    // 2. Open /admin/reservations -> reservation card -> checkout workbench
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const card = page.locator(`[data-testid="reservation-card-${bookingRef}"]:visible`).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });
    await card.click();

    const checkoutModalBtn = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await checkoutModalBtn.waitFor({ state: 'visible', timeout: 8000 });
    await checkoutModalBtn.click();

    const amountDueBefore = page.locator('[data-testid="workbench-net-due"]:visible').first();
    await amountDueBefore.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="workbench-net-due"]');
      return el && el.innerText.includes('300');
    }, { timeout: 10000 });

    // 3. Click "新增櫃檯優惠" and create fixed_order $50 quick promo
    await page.locator('[data-testid="add-quick-pos-promo-btn"]:visible').click();
    await page.locator('[data-testid="quick-promo-name-input"]').fill(quickName);
    const codeInput = page.locator('input[placeholder*="POS50"]').first();
    await codeInput.fill(quickCode);
    const numInput = page.locator('input[type="number"][min="1"]').last();
    await numInput.fill('50');
    await page.locator('[data-testid="submit-quick-promo-btn"]').click();

    // 4. Wait for quick promo button and click it
    const qpBtn = page.locator(`button:has-text("${quickName}"):visible`).first();
    await qpBtn.waitFor({ state: 'visible', timeout: 10000 });
    await qpBtn.click();

    // 5. Verify amount due dropped from NT$300 to NT$250 and promo tag appears
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="workbench-net-due"]');
      return el && el.innerText.includes('250');
    }, { timeout: 10000 });

    const dueText = await amountDueBefore.innerText();
    assert.ok(dueText.includes('250'), `Expected NT$250 after $50 quick promo, got ${dueText}`);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round34_shot1_pos_promo.png'),
      fullPage: false
    });
    console.log('✅ Round 34 Item 2 POS Promo Playwright Test PASSED!');

    // 6. Round 34 Item 5: QuickPromoModal percentage two-mode + live conversion hint screenshot
    await page.locator('[data-testid="add-quick-pos-promo-btn"]:visible').click();
    await page.locator('[data-testid="quick-promo-type-percentage-btn"]').click();
    await page.locator('[data-testid="quick-promo-pct-value-input"]').fill('8.5');
    const qHint = await page.locator('[data-testid="quick-promo-pct-conversion-hint"]').innerText();
    assert.ok(qHint.includes('顧客付 85%（8.5 折），600 元折 90 元'), `Unexpected QuickPromo conversion hint: ${qHint}`);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round34_shot3_quick_promo_percent.png'),
      fullPage: false
    });
    await page.getByRole('button', { name: '取消', exact: true }).last().click();
    await page.locator('[data-testid="workbench-close-btn"]:visible').click();
    await page.waitForTimeout(200);

    // 7. Round 34 Item 5: CouponsPage create percentage code using 打 9 折 -> verify card & apply on $600 booking -> $540
    await page.goto(`${BASE_URL}/admin/coupons`, { waitUntil: 'networkidle' });
    await page.locator('button:has-text("新增優惠券"):visible').first().click();
    await page.locator('input[placeholder*="CHECKIN50"]').fill(zhe9Code);
    await page.locator('input[placeholder*="雙人同行"]').fill(zhe9Name);
    await page.locator('[data-testid="coupon-discount-type-select"]').selectOption('percentage');
    await page.locator('[data-testid="coupon-pct-mode-zhe"]').click();
    await page.locator('[data-testid="coupon-pct-value-input"]').fill('9');
    const cHint = await page.locator('[data-testid="coupon-pct-conversion-hint"]').innerText();
    assert.ok(cHint.includes('顧客付 90%（9 折），600 元折 60 元'), `Unexpected Coupons conversion hint: ${cHint}`);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'round34_shot2_coupons_percent.png'),
      fullPage: false
    });
    await page.locator('button:has-text("確認建立優惠券")').click();

    const createdCard = page.locator(`text=${zhe9Code}`).first();
    await createdCard.waitFor({ state: 'visible', timeout: 10000 });
    const cardContainer = createdCard.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    const cardText = await cardContainer.innerText();
    assert.ok(cardText.includes('9 折（折 10%）'), `Expected card text to show "9 折（折 10%）", got: ${cardText}`);

    // Apply zhe9Code on $600 booking in CheckoutWorkbench -> $540
    await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    const card600 = page.locator(`[data-testid="reservation-card-${bookingRef600}"]:visible`).first();
    await card600.waitFor({ state: 'visible', timeout: 10000 });
    await card600.click();
    const openWb600 = page.locator('button:has-text("結帳明細"), button:has-text("前往結帳")').first();
    await openWb600.waitFor({ state: 'visible', timeout: 8000 });
    await openWb600.click();

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="workbench-net-due"]');
      return el && el.innerText.includes('600');
    }, { timeout: 10000 });

    const promoInput600 = page.locator('input[placeholder*="VIP2026"]:visible').first();
    await promoInput600.fill(zhe9Code);
    await page.locator('button:has-text("驗證套用"):visible').first().click();

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="workbench-net-due"]');
      return el && el.innerText.includes('540');
    }, { timeout: 10000 });
    const finalDue600 = await page.locator('[data-testid="workbench-net-due"]:visible').first().innerText();
    assert.ok(finalDue600.includes('540'), `Expected NT$540 on NT$600 booking after 9折 promo, got ${finalDue600}`);
    console.log('✅ Round 34 Item 5 Coupons & QuickPromo Percentage Playwright Test PASSED!');
  } finally {
    await browser.close();
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [bookingRef, bookingRef600] } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [bookingRef, bookingRef600] } } }).catch(() => {});
    await prisma.dailySetting.delete({ where: { date: todayDate } }).catch(() => {});
    await prisma.promoCode.deleteMany({ where: { code: { in: [quickCode, zhe9Code] } } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

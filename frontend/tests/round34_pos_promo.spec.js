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
  const quickCode = `R34Q50_${runId}`;
  const quickName = `現場折50_${runId}`;

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
  } finally {
    await browser.close();
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } }).catch(() => {});
    await prisma.dailySetting.delete({ where: { date: todayDate } }).catch(() => {});
    await prisma.promoCode.deleteMany({ where: { code: quickCode } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

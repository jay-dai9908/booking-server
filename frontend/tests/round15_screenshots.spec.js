import { chromium } from 'playwright';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function takeScreenshots() {
  console.log('--- Capturing Round 15 Screenshots (390x844) ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  await prisma.session.deleteMany({ where: { session_date: todayDate } });
  const session = await prisma.session.create({
    data: {
      session_date: todayDate,
      start_time: '14:00',
      end_time: '16:00',
      max_capacity: 20
    }
  });

  const testRef = `BK-R15-${Date.now().toString().slice(-6)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r15_${Date.now()}`,
      name: '陳小美',
      phone: '0988123456'
    }
  });

  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session_id: session.id,
      user_id: testUser.id,
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['1-1', '1-2'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      is_paid: true,
      paid_persons: 2,
      billing_status: 'paid',
      checkout_details: {
        version: 2,
        rev: 0,
        split_mode: 'proportional',
        persons: [
          { person_no: 1, seat_code: '1-1', mode: 'hourly' },
          { person_no: 2, seat_code: '1-2', mode: 'hourly' }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: testRef, person_no: 1, seat_code: '1-1', status: 'active' },
      { booking_ref: testRef, person_no: 2, seat_code: '1-2', status: 'active' }
    ]
  });

  const p1 = await prisma.payment.create({
    data: {
      payment_no: `R-${Date.now().toString().slice(-4)}-1`,
      batch_no: `B-${Date.now()}`,
      booking_ref: testRef,
      kind: 'charge',
      status: 'valid',
      method: 'line_pay',
      amount: 450,
      person_nos: [1],
      breakdown_json: { customer_name: '陳小美' },
      staff_name: '店長',
      device_label: '櫃檯平板'
    }
  });

  const p2 = await prisma.payment.create({
    data: {
      payment_no: `R-${Date.now().toString().slice(-4)}-2`,
      batch_no: `B-${Date.now()}`,
      booking_ref: testRef,
      kind: 'supplement',
      status: 'valid',
      method: 'cash',
      amount: 150,
      person_nos: [2],
      breakdown_json: { customer_name: '陳小美' },
      staff_name: '店長',
      device_label: '櫃檯平板'
    }
  });

  const p3 = await prisma.payment.create({
    data: {
      payment_no: `R-${Date.now().toString().slice(-4)}-3`,
      batch_no: `B-${Date.now()}`,
      booking_ref: testRef,
      kind: 'charge',
      status: 'voided',
      method: 'cash',
      amount: 300,
      person_nos: [1],
      breakdown_json: { customer_name: '陳小美' },
      staff_name: '店長',
      device_label: '櫃檯平板',
      voided_at: new Date(),
      void_reason: '收錯付款方式'
    }
  });

  await prisma.accountingEvent.create({
    data: {
      booking_ref: testRef,
      event_type: 'payment_void',
      category: 'void',
      summary: `作廢收款 ${p3.payment_no}，金額 NT$300`,
      reason: '收錯付款方式',
      payment_id: p3.id,
      staff_name: '店長',
      device_label: '櫃檯平板',
      before_json: {
        payment_no: p3.payment_no,
        status: 'valid',
        amount: 300,
        method: 'cash'
      },
      after_json: {
        payment_no: p3.payment_no,
        status: 'voided',
        amount: 300,
        method: 'cash',
        void_reason: '收錯付款方式'
      }
    }
  });

  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // 1. Login
  await page.goto(`${BASE_URL}/admin/login`);
  await page.waitForLoadState('networkidle');
  const pwdInput = page.locator('input[type="password"]');
  if (await pwdInput.isVisible()) {
    await pwdInput.fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/admin/sessions');
    await page.waitForLoadState('networkidle');
  }

  // 2. Open Reservations to see Details Modal with 收款紀錄
  await page.goto(`${BASE_URL}/admin/reservations`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Click card
  const card = page.locator(`[data-testid="reservation-card-${testRef}"]`).first();
  await card.click();
  await page.waitForTimeout(1500);

  // Scroll details modal to payments section
  await page.locator('text=收款紀錄').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'screenshot_round15_payments.png' });
  console.log('Saved screenshot_round15_payments.png');

  // Close modal
  await page.locator('button[title="更多操作"]').first().waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Open Accounting Events to see Detail panel
  await page.goto(`${BASE_URL}/admin/accounting`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Switch to events tab
  await page.locator('[data-testid="tab-events"]:visible').click();
  await page.waitForTimeout(1000);

  // Click first event row
  const eventRow = page.locator('tr:has-text("作廢收款")').first();
  await eventRow.click();
  await page.waitForTimeout(1000);

  // Capture event detail panel
  await page.screenshot({ path: 'screenshot_round15_event_detail.png' });
  console.log('Saved screenshot_round15_event_detail.png');

  await browser.close();
  await prisma.$disconnect();
  console.log('--- Round 15 Screenshots Done ---');
}

takeScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});

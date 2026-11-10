import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { toTaipeiDateString } from '../../shared/time.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function main() {
  console.log('Seeding data for Round 14 screenshots...');
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  let session = await prisma.session.findFirst({
    where: { session_date: todayDate }
  });
  if (!session) {
    session = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: '14:00',
        end_time: '16:00',
        max_capacity: 20
      }
    });
  }

  const testRef = `BK-SHOT-${Date.now().toString().slice(-4)}`;
  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_shot_${Date.now()}`,
      name: '林曉美',
      phone: '0988112233',
    }
  });

  // Create partial paid 2-pax reservation with Person 1 paid, and an order addon added after
  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2'],
      attendance: 'checked_in',
      checked_in_at: new Date(),
      is_paid: false,
      paid_persons: 1,
      billing_status: 'partial',
      checkout_details: {
        version: 2,
        rev: 1,
        split_mode: 'proportional',
        shared_items_split_mode: 'unpaid',
        persons: [
          { person_no: 1, seat_code: 'A1-1', mode: 'hourly', entry_hours: 2, addons: [] },
          { person_no: 2, seat_code: 'A1-2', mode: 'hourly', entry_hours: 2, addons: [] }
        ],
        order_addons: [
          {
            id: 'oa-shot-1',
            name: '代燙整單',
            price: 80,
            quantity: 1,
            added_after_payment: true,
            paid_person_no: 1,
            added_at_batch: 2,
            added_at: new Date().toISOString()
          }
        ]
      }
    }
  });

  await prisma.bookingPerson.createMany({
    data: [
      {
        booking_ref: testRef,
        person_no: 1,
        seat_code: 'A1-1',
        status: 'active',
        billing_start_at: new Date(),
        timer_started_at: new Date()
      },
      {
        booking_ref: testRef,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: new Date(),
        timer_started_at: new Date()
      }
    ]
  });

  await prisma.payment.create({
    data: {
      booking_ref: testRef,
      payment_no: `R-SHOT-${Date.now().toString().slice(-4)}`,
      batch_no: `B-SHOT-1`,
      kind: 'charge',
      status: 'valid',
      method: 'cash',
      amount: 300,
      cash_received: 300,
      change_given: 0,
      person_nos: [1],
      staff_name: '門市人員',
      device_label: '櫃檯',
      breakdown_json: {
        persons: [
          {
            person_no: 1,
            seat_code: 'A1-1',
            entry: { amount: 300, hours: 2 },
            board: { amount: 0 },
            addons: [],
            total: 300
          }
        ]
      }
    }
  });

  console.log(`Created reservation ${testRef}`);

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);
  // Viewport 390x844 as required by spec
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  console.log('Logging in to Admin...');
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  const passInput = page.locator('input[type="password"]');
  await passInput.waitFor({ state: 'visible', timeout: 15000 });
  await passInput.fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(500);

  console.log('Navigating to /admin/reservations...');
  await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });

  // Open reservation details
  const card = page.locator(`[data-testid="reservation-card-${testRef}"]`).first();
  await card.waitFor({ state: 'visible', timeout: 10000 });
  await card.click();

  // Open workbench
  const checkoutModalBtn = page.locator('button:has-text("前往結帳"), button:has-text("結帳明細")').first();
  await checkoutModalBtn.waitFor({ state: 'visible', timeout: 5000 });
  await checkoutModalBtn.click();

  // SplitCollectView should auto-open!
  const splitTitle = page.locator('h3:has-text("分開收款"), h2:has-text("分開收款")').first();
  await splitTitle.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1000); // Wait for transitions and data to settle

  const shot1Path = path.resolve(__dirname, '../../screenshot_split_collect.png');
  await page.screenshot({ path: shot1Path });
  console.log(`Screenshot 1 saved to ${shot1Path}`);

  // Now click 「整單共用項目 · 改分攤 ›」
  const sharedBtn = page.locator('button:has-text("整單共用項目 · 改分攤"), button:has-text("整單共同項目 · 改分攤")').first();
  await sharedBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sharedBtn.click();

  // Click on "也分給已付的人" so the delta simulation displays補收 amount clearly
  const includePaidRadio = page.locator('label:has-text("也分給已付的人")').first();
  await includePaidRadio.click();
  await page.waitForTimeout(600);

  const shot2Path = path.resolve(__dirname, '../../screenshot_shared_split_panel.png');
  await page.screenshot({ path: shot2Path });
  console.log(`Screenshot 2 saved to ${shot2Path}`);

  await browser.close();
  await prisma.$disconnect();
  console.log('Finished capturing screenshots successfully!');
}

main().catch(err => {
  console.error('Error capturing screenshots:', err);
  process.exit(1);
});

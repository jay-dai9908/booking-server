import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'tests', 'screenshots');

async function run() {
  console.log('--- Starting Round 33 Permissions Playwright Test ---');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await ensureFreshDbSeeded(prisma);
  await prisma.promoCode.deleteMany({ where: { code: { startsWith: 'R33PROMO' } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { name: { contains: 'R33' } } }).catch(() => {});

  const suffix = Date.now().toString().slice(-6);
  const seatingPassPlain = `R33Seating_${suffix}_Pass!`;
  const accountingPassPlain = `R33Account_${suffix}_Pass!`;
  const sessionsPassPlain = `R33Session_${suffix}_Pass!`;

  const seatingStaff = await prisma.adminUser.create({
    data: {
      password: seatingPassPlain,
      name: `帶位專員R33_${suffix}`,
      permissions: ['seating'],
      is_active: true
    }
  });

  const accountingStaff = await prisma.adminUser.create({
    data: {
      password: accountingPassPlain,
      name: `帳務專員R33_${suffix}`,
      permissions: ['accounting'],
      is_active: true
    }
  });

  const sessionsStaff = await prisma.adminUser.create({
    data: {
      password: sessionsPassPlain,
      name: `時段專員R33_${suffix}`,
      permissions: ['sessions'],
      is_active: true
    }
  });

  // Ensure at least one promo code exists for CouponsPage list verification
  const promoCodeStr = `R33PROMO${suffix}`;
  const seededPromo = await prisma.promoCode.create({
    data: {
      code: promoCodeStr,
      name: 'R33權限測試優惠券',
      description: '提供唯讀權限檢視測試',
      discount_type: 'fixed_order',
      discount_value: 50,
      channel: 'all',
      is_pos_quick_select: true,
      is_active: true
    }
  });

  // Seed today's session and a checked-in reservation with 2 persons (Person 1 paid, Person 2 unpaid)
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);

  let session = await prisma.session.findFirst({
    where: { session_date: todayDate, start_time: '13:00' }
  });
  if (!session) {
    session = await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: '13:00',
        end_time: '15:00',
        max_capacity: 20
      }
    });
  }

  const testUser = await prisma.user.create({
    data: {
      line_user_id: `line_r33_${suffix}`,
      name: 'R33結帳權限顧客',
      phone: `0911${suffix}`
    }
  });

  const testRef = `BK-R33-${suffix}`;
  const now = new Date();
  await prisma.reservation.create({
    data: {
      booking_ref: testRef,
      session: { connect: { id: session.id } },
      user: { connect: { id: testUser.id } },
      pax: 2,
      status: 'confirmed',
      assigned_seats: ['A1-1', 'A1-2'],
      attendance: 'checked_in',
      checked_in_at: now,
      checkout_details: {
        version: 2,
        rev: 1,
        split_mode: 'proportional',
        persons: [
          { person_no: 1, seat_code: 'A1-1', mode: 'hourly', is_paid: true, is_frozen: true },
          { person_no: 2, seat_code: 'A1-2', mode: 'hourly' }
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
        status: 'paid',
        billing_start_at: now,
        timer_started_at: now
      },
      {
        booking_ref: testRef,
        person_no: 2,
        seat_code: 'A1-2',
        status: 'active',
        billing_start_at: now,
        timer_started_at: now
      }
    ]
  });

  const seededPayment = await prisma.payment.create({
    data: {
      payment_no: `PAY-R33-${suffix}`,
      batch_no: `BATCH-R33-${suffix}`,
      booking_ref: testRef,
      kind: 'charge',
      method: 'cash',
      amount: 200,
      cash_received: 200,
      change_given: 0,
      person_nos: [1],
      breakdown_json: {},
      status: 'valid',
      staff_name: '帳務專員R33',
      device_label: 'POS'
    }
  });

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);

  try {
    // =========================================================================
    // Scenario 1: Staff with ONLY ['seating'] opens CheckoutWorkbench
    // =========================================================================
    console.log('Scenario 1: Logging in as seating-only staff...');
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page1 = await ctx1.newPage();

    await page1.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page1.locator('input[type="password"]').first().fill(seatingPassPlain);
    await page1.locator('button[type="submit"]').click();

    await page1.waitForTimeout(1200);
    await page1.waitForLoadState('networkidle');

    // Navigate to /admin/seating and switch to list tab ("名單")
    await page1.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    const listTabBtn = page1.locator('button:has-text("名單"):visible').first();
    await listTabBtn.waitFor({ state: 'visible', timeout: 10000 });
    await listTabBtn.click();

    const card = page1.locator(`[data-booking-ref="${testRef}"]`).first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    await card.locator('button:has-text("結帳")').click();

    await page1.locator('text=每位時數與金額').waitFor({ state: 'visible', timeout: 15000 });

    // Because Person 1 is paid and Person 2 is unpaid, SplitCollectView auto-opens over CheckoutWorkbench
    await page1.locator('text=選擇本次結帳對象').waitFor({ state: 'visible', timeout: 10000 });
    assert.strictEqual(await page1.locator('[data-testid="split-person-refund-btn"]').count(), 0, 'Refund button should be hidden in SplitCollectView');
    assert.strictEqual(await page1.locator('[data-testid="split-more-btn"]').count(), 0, 'More menu (waive/mark-unpaid) should be hidden in SplitCollectView');
    assert.strictEqual(await page1.locator('button:has-text("作廢")').count(), 0, 'Void button should be hidden in SplitCollectView');
    assert.ok((await page1.locator('text=退款與作廢需要帳務或預約權限').count()) >= 2, 'Money permission notice should appear in SplitCollectView');

    // Close SplitCollectView to inspect main CheckoutWorkbench
    await page1.locator('button[aria-label="關閉"]').first().click();
    await page1.locator('text=選擇本次結帳對象').waitFor({ state: 'hidden', timeout: 10000 });

    // 1. Collect button is visible
    const collectBtn = page1.locator('[data-testid="workbench-collect-btn"]:visible').first();
    await collectBtn.waitFor({ state: 'visible', timeout: 10000 });

    // 2. "退款與作廢需要帳務或預約權限" notice is visible
    const moneyPermNotice = page1.locator('text=退款與作廢需要帳務或預約權限').first();
    await moneyPermNotice.waitFor({ state: 'visible', timeout: 10000 });

    // 3. "免收（招待）", "標記未結帳", "新增櫃檯優惠" are NOT visible
    assert.strictEqual(await page1.locator('button:has-text("免收（招待）"):visible').count(), 0, 'Waive button should be hidden for seating-only staff');
    assert.strictEqual(await page1.locator('[data-testid="add-quick-pos-promo-btn"]').count(), 0, 'Add quick promo button should be hidden for seating-only staff');

    // Open desktop more menu in CheckoutWorkbench to verify "標記未結帳" is hidden there too
    await page1.locator('[data-testid="workbench-more-btn-desktop"]').click();
    assert.strictEqual(await page1.locator('[data-testid="workbench-mark-unpaid-btn-desktop"]').count(), 0, 'Mark unpaid button should be hidden in more menu');
    await page1.locator('[data-testid="workbench-more-btn-desktop"]').click();

    // Capture Screenshot 1 on CheckoutWorkbench
    const shot1Path = path.join(SCREENSHOT_DIR, 'round33_shot1_seating_checkout_restricted.png');
    await page1.screenshot({ path: shot1Path, fullPage: false });
    console.log(`Saved screenshot 1: ${shot1Path}`);

    await ctx1.close();
    console.log('Scenario 1 PASS');

    // =========================================================================
    // Scenario 2: Staff with ONLY ['accounting'] opens CouponsPage (/admin/coupons)
    // =========================================================================
    console.log('Scenario 2: Logging in as accounting-only staff...');
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page2 = await ctx2.newPage();

    await page2.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page2.locator('input[type="password"]').first().fill(accountingPassPlain);
    await page2.locator('button[type="submit"]').click();

    await page2.waitForTimeout(1200);
    await page2.waitForLoadState('networkidle');

    await page2.goto(`${BASE_URL}/admin/coupons`, { waitUntil: 'networkidle' });

    // Verify read-only banner and promo list are visible
    const readonlyBanner = page2.locator('[data-testid="coupons-readonly-banner"]');
    await readonlyBanner.waitFor({ state: 'visible', timeout: 10000 });
    const bannerText = await readonlyBanner.innerText();
    assert.ok(bannerText.includes('唯讀：需要卡券與優惠權限才能修改'), `Unexpected banner text: ${bannerText}`);

    await page2.locator(`text=${promoCodeStr}`).first().waitFor({ state: 'visible', timeout: 10000 });

    // Verify "新增優惠券" and edit/delete buttons are hidden
    assert.strictEqual(await page2.locator('button:has-text("新增優惠券")').count(), 0, 'New coupon button should be hidden for accounting-only staff');
    assert.strictEqual(await page2.locator('button[title="編輯優惠券"]').count(), 0, 'Edit coupon button should be hidden for accounting-only staff');
    assert.strictEqual(await page2.locator('button[title="刪除優惠券"]').count(), 0, 'Delete coupon button should be hidden for accounting-only staff');

    const shot2Path = path.join(SCREENSHOT_DIR, 'round33_shot2_coupons_readonly.png');
    await page2.screenshot({ path: shot2Path, fullPage: false });
    console.log(`Saved screenshot 2: ${shot2Path}`);

    await ctx2.close();
    console.log('Scenario 2 PASS');

    // =========================================================================
    // Scenario 3: Staff with ONLY ['sessions'] opens SessionsPage (/admin/sessions)
    // =========================================================================
    console.log('Scenario 3: Logging in as sessions-only staff...');
    const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page3 = await ctx3.newPage();

    await page3.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page3.locator('input[type="password"]').first().fill(sessionsPassPlain);
    await page3.locator('button[type="submit"]').click();

    await page3.waitForTimeout(1200);
    await page3.waitForLoadState('networkidle');

    await page3.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });

    const displayCard = page3.locator('[data-testid="sessions-display-settings-card"]');
    await displayCard.waitFor({ state: 'visible', timeout: 10000 });
    await displayCard.scrollIntoViewIfNeeded();

    // Verify Kiosk card is read-only for sessions-only staff
    await page3.locator('[data-testid="kiosk-settings-readonly-notice"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.strictEqual(await page3.locator('[data-testid="save-kiosk-settings-btn"]').count(), 0, 'Kiosk save button should be hidden for sessions-only staff');

    // Verify LINE button URL input & toggle are disabled/read-only and show notice
    await page3.locator('[data-testid="sessions-line-readonly-notice"]').waitFor({ state: 'visible', timeout: 10000 });
    const lineUrlInput = page3.locator('[data-testid="sessions-line-url-input"]');
    assert.strictEqual(await lineUrlInput.isDisabled(), true, 'LINE URL input should be disabled for sessions-only staff');
    const lineToggle = page3.locator('[data-testid="sessions-line-toggle"]');
    assert.strictEqual(await lineToggle.isDisabled(), true, 'LINE button toggle should be disabled for sessions-only staff');

    // Verify announcement is editable and saves cleanly (200)
    const announcementInput = page3.locator('[data-testid="sessions-announcement-input"]');
    assert.strictEqual(await announcementInput.isDisabled(), false, 'Announcement input should be enabled for sessions-only staff');
    const testAnnouncementText = `歡迎來到拾光製所！R33時段人員公告更新_${suffix}`;
    await announcementInput.fill(testAnnouncementText);

    const [putGlobalResp] = await Promise.all([
      page3.waitForResponse((res) => res.url().includes('/api/daily-settings/global') && res.request().method() === 'PUT'),
      page3.locator('[data-testid="save-display-settings-btn"]').click()
    ]);
    assert.strictEqual(putGlobalResp.status(), 200, `Expected 200 saving display settings for sessions-only staff, got ${putGlobalResp.status()}`);
    await page3.locator('text=顧客端首頁顯示設定已成功更新').waitFor({ state: 'visible', timeout: 10000 });

    const shot3Path = path.join(SCREENSHOT_DIR, 'round33_shot3_sessions_readonly.png');
    await page3.screenshot({ path: shot3Path, fullPage: false });
    console.log(`Saved screenshot 3: ${shot3Path}`);

    await ctx3.close();
    console.log('Scenario 3 PASS');
    console.log('--- Round 33 Permissions Playwright Test PASSED ---');
  } finally {
    await browser.close();
    await prisma.payment.deleteMany({ where: { id: seededPayment.id } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    await prisma.promoCode.deleteMany({ where: { id: seededPromo.id } }).catch(() => {});
    await prisma.adminUser.deleteMany({
      where: { id: { in: [seatingStaff.id, accountingStaff.id, sessionsStaff.id] } }
    }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

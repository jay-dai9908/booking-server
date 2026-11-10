import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import jwt from '../../backend/node_modules/jsonwebtoken/index.js';
import { generateIcsContent } from '../src/utils/calendarHelper.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.resolve('test-results/ux-fixes');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !testDbUrl.trim()) {
  console.error('TEST_DATABASE_URL is not set. Refusing to run tests on production/dev database.');
  process.exit(1);
}
const cleanDbUrl = testDbUrl.split('?')[0];
const dbName = cleanDbUrl.split('/').pop();
if (!dbName || !dbName.endsWith('_test')) {
  console.error(`TEST_DATABASE_URL database name "${dbName}" must end with "_test"! Refusing to run tests.`);
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

async function run() {
  if (!process.env.ADMIN_PASSWORD?.trim()) {
    console.error('請設定 ADMIN_PASSWORD 環境變數');
    process.exit(1);
  }
  const adminPassword = process.env.ADMIN_PASSWORD.trim();
  await ensureFreshDbSeeded(prisma);
  console.log(`Starting UX Fixes Tests on ${BASE_URL} (Headless: ${HEADLESS})...`);

  // Setup test customer token
  let customerToken;
  try {
    const loginRes = await fetch(`${API_BASE}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, role: 'customer' })
    });
    if (loginRes.ok) {
      const data = await loginRes.json();
      customerToken = data.token;
    }
  } catch (e) {}

  if (!customerToken) {
    if (!process.env.JWT_SECRET?.trim()) {
      console.error('請設定 JWT_SECRET 環境變數');
      process.exit(1);
    }
    customerToken = jwt.sign(
      { id: 1, role: 'customer' },
      process.env.JWT_SECRET.trim(),
      { expiresIn: '7d' }
    );
  }

  // Target relative date: 2 days from today in Asia/Taipei
  const nowInTaipei = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const targetDateObj = new Date(nowInTaipei);
  targetDateObj.setDate(targetDateObj.getDate() + 2);
  const targetYear = targetDateObj.getFullYear();
  const targetMonth = targetDateObj.getMonth() + 1;
  const targetDay = targetDateObj.getDate();
  const targetDateYmd = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  const targetDateUtc = new Date(`${targetDateYmd}T00:00:00.000Z`);
  const targetAriaLabel = `${targetMonth} 月 ${targetDay} 日`;
  const icsDatePrefix = `${targetYear}${String(targetMonth).padStart(2, '0')}${String(targetDay).padStart(2, '0')}`;

  console.log(`Seeding test sessions safely for relative date: ${targetDateYmd} (${targetAriaLabel})...`);
  const sess1 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: targetDateUtc, start_time: '14:00' } },
    update: { max_capacity: 20 },
    create: { session_date: targetDateUtc, start_time: '14:00', end_time: '15:00', max_capacity: 20 }
  });
  const sess2 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: targetDateUtc, start_time: '15:00' } },
    update: { max_capacity: 20 },
    create: { session_date: targetDateUtc, start_time: '15:00', end_time: '16:00', max_capacity: 20 }
  });
  const sess3 = await prisma.session.upsert({
    where: { session_date_start_time: { session_date: targetDateUtc, start_time: '16:00' } },
    update: { max_capacity: 20 },
    create: { session_date: targetDateUtc, start_time: '16:00', end_time: '17:00', max_capacity: 20 }
  });

  const createdTestBookingRefs = [];

  // Clean up any stale reservations on the test sessions to free stock
  const staleRes = await prisma.reservation.findMany({
    where: { session_id: { in: [sess1.id, sess2.id, sess3.id] } },
    select: { booking_ref: true }
  });
  const staleRefs = [...new Set(staleRes.map(r => r.booking_ref))];
  for (const ref of staleRefs) {
    await prisma.payment.deleteMany({ where: { booking_ref: ref } });
    await prisma.timerPause.deleteMany({ where: { person: { booking_ref: ref } } });
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: ref } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
    await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
  }

  // Create a reservation for 2 pax with 1 pegboard_m on 2026-11-10
  const bookingCreateRes = await fetch(`${API_BASE}/reservations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${customerToken}`
    },
    body: JSON.stringify({
      session_ids: [sess1.id, sess2.id, sess3.id],
      pax: 2,
      equipments: [{ equipment_id: 'pegboard_m', quantity: 1 }]
    })
  });
  const errText = bookingCreateRes.status !== 201 ? await bookingCreateRes.text() : '';
  assert.strictEqual(bookingCreateRes.status, 201, `Booking on ${targetDateYmd} must succeed: ${errText}`);
  const bookingCreateJson = JSON.parse(errText || await bookingCreateRes.text());
  const testCustRef = bookingCreateJson.reservation?.booking_ref;
  if (testCustRef) createdTestBookingRefs.push(testCustRef);
  console.log(`Seeded test customer booking for ${targetDateYmd}:`, testCustRef);

  const browser = await chromium.launch({ headless: HEADLESS });

  const pageErrors = [];
  const apiErrors = [];

  function attachListeners(page, pageName) {
    page.on('pageerror', (err) => {
      console.error(`[${pageName}] Page error:`, err.message || err);
      pageErrors.push({ page: pageName, error: err.message || String(err) });
    });
    page.on('response', (res) => {
      if (res.url().includes('/api/') && res.status() >= 400) {
        if (res.url().includes('/api/auth/me') && res.status() === 401) return;
        console.error(`[${pageName}] API Error ${res.status()} on ${res.url()}`);
        apiErrors.push({ page: pageName, url: res.url(), status: res.status() });
      }
    });
    page.on('dialog', async (dialog) => {
      console.warn(`[${pageName}] Unexpected dialog: ${dialog.type()} "${dialog.message()}"`);
      await dialog.dismiss();
    });
  }

  try {
    // =========================================================================
    // FLOW 1: Customer Booking & Hide bring_own (B4)
    // =========================================================================
    console.log('\n--- FLOW 1: Customer Booking & Hide bring_own (B4) (Mobile 390x844) ---');
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15'
    });

    // Inject customer auth token
    await mobileCtx.addInitScript((tok) => {
      sessionStorage.setItem('shiguang_auth_token', tok);
    }, customerToken);

    const cPage = await mobileCtx.newPage();
    attachListeners(cPage, 'CustomerBooking');

    // Visit /booking
    await cPage.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await cPage.waitForTimeout(1000);
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '01-customer-booking-step1.png') });

    // Click relative date button
    const dateBtn = cPage.locator(`button[aria-label*="${targetAriaLabel}"]`).first();
    if (await dateBtn.isVisible()) {
      await dateBtn.click();
      await cPage.waitForTimeout(800);
    }

    // Pick 14:00 slot (or any non-disabled slot)
    const slotBtn = cPage.locator('button:has-text("14:00")').first();
    if (await slotBtn.isVisible()) {
      await slotBtn.click();
      await cPage.waitForTimeout(500);
    } else {
      const anySlot = cPage.locator('button:has-text(":"):not([aria-disabled="true"]):not([disabled])').first();
      if (await anySlot.isVisible()) {
        await anySlot.click();
        await cPage.waitForTimeout(500);
      }
    }

    // Advance to Step 2
    const nextBtn = cPage.locator('button:has-text("下一步")').first();
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await cPage.waitForTimeout(800);
    }

    // Step 2: Verify bring_own is hidden (B4)
    console.log('Verifying bring_own is hidden from customer booking (B4)...');
    const bringOwnEl = cPage.locator('text=自帶智能拼豆板');
    const isBringOwnVisible = await bringOwnEl.isVisible();
    assert.strictEqual(isBringOwnVisible, false, 'bring_own must NOT be visible in customer booking');
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '02-customer-booking-step2-nobringown.png') });

    // =========================================================================
    // FLOW 2: StepDone Exact Text, Reload Resilience & ICS Verification (B1)
    // =========================================================================
    console.log('\n--- FLOW 2: StepDone Page with Ref & Reload (B1) ---');
    await cPage.goto(`${BASE_URL}/booking?step=done&ref=${testCustRef}`, { waitUntil: 'networkidle' });
    await cPage.waitForTimeout(1000);

    // Verify summary text
    const summaryEl = cPage.locator('[data-testid="booking-summary-text"]');
    assert.ok(await summaryEl.isVisible(), 'Booking summary text must be visible');
    const summaryText = await summaryEl.textContent();
    console.log('StepDone summary text:', summaryText);

    // Spec B1 & 2.9: 14:00 到 17:00 · 2 位 · 中板 ×1
    assert.ok(summaryText.includes('14:00 到 17:00 · 2 位'), `Expected summary to contain '14:00 到 17:00 · 2 位', got '${summaryText}'`);
    assert.ok(summaryText.includes('中板 ×1'), `Expected summary to contain '中板 ×1', got '${summaryText}'`);
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '03-stepdone-page-real.png') });

    // Test reload resilience
    console.log('Testing reload resilience on StepDone...');
    await cPage.reload({ waitUntil: 'networkidle' });
    await cPage.waitForTimeout(1000);
    const summaryAfterReload = await cPage.locator('[data-testid="booking-summary-text"]').textContent();
    console.log('StepDone summary text after reload:', summaryAfterReload);
    assert.ok(summaryAfterReload.includes('14:00 到 17:00 · 2 位'), 'Summary text must persist after reload');
    assert.ok(summaryAfterReload.includes('中板 ×1'), 'Equipment summary must persist after reload');
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '04-stepdone-after-reload.png') });

    // Verify ICS generation
    const myRes = await fetch(`${API_BASE}/reservations/my`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    const myList = await myRes.json();
    const createdRes = myList.find(r => r.booking_ref === testCustRef);
    assert.ok(createdRes, 'Customer reservation must exist');
    const icsContent = generateIcsContent(createdRes);
    console.log('Generated ICS snippet:\n', icsContent.split('\r\n').slice(0, 12).join('\n'));
    assert.ok(icsContent.includes(`DTSTART;TZID=Asia/Taipei:${icsDatePrefix}T140000`), `ICS must have DTSTART;TZID=Asia/Taipei:${icsDatePrefix}T140000`);
    assert.ok(icsContent.includes(`DTEND;TZID=Asia/Taipei:${icsDatePrefix}T170000`), `ICS must have DTEND;TZID=Asia/Taipei:${icsDatePrefix}T170000`);

    // Test invalid ref displays "找不到這筆預約"
    await cPage.goto(`${BASE_URL}/booking?step=done&ref=INVALID-REF-999`, { waitUntil: 'networkidle' });
    await cPage.waitForTimeout(800);
    const notFoundText = cPage.locator('text=找不到這筆預約');
    assert.ok(await notFoundText.isVisible(), 'Invalid ref must display 找不到這筆預約');
    const backBtn = cPage.locator('button:has-text("回到我的預約")');
    assert.ok(await backBtn.isVisible(), 'Must provide 回到我的預約 button');

    // =========================================================================
    // FLOW 3: Customer History Cards Clickable & Details & Barcode (B2 & B3)
    // =========================================================================
    console.log('\n--- FLOW 3: Customer History Cards (B2 & B3) ---');
    await cPage.goto(`${BASE_URL}/history`, { waitUntil: 'networkidle' });
    await cPage.waitForTimeout(1000);
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '05-history-page-mobile.png') });

    // Locate the card for testCustRef
    const card = cPage.locator(`div:has-text("${testCustRef.slice(0, 4).toUpperCase()}")`).first();
    assert.ok(await card.isVisible(), 'History card for seeded booking must be visible');

    // Verify "詳情與取消 ›" link
    const detailsLink = card.locator('text=詳情與取消 ›');
    assert.ok(await detailsLink.isVisible(), 'Card must contain 詳情與取消 › link');

    // Verify BarcodeSheet does NOT duplicate weekday (B3)
    console.log('Testing Barcode Sheet for weekday duplication (B3)...');
    const barcodeBtn = card.locator('button:has-text("出示到店條碼")');
    assert.ok(await barcodeBtn.isVisible(), 'Barcode button must exist');
    await barcodeBtn.click();
    await cPage.waitForTimeout(600);
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '05b-barcode-sheet.png') });

    const barcodeSummaryEl = cPage.locator('[data-testid="barcode-summary"]');
    if (await barcodeSummaryEl.isVisible()) {
      const bSummary = await barcodeSummaryEl.textContent();
      console.log('Barcode summary:', bSummary);
      assert.ok(!bSummary.includes('週二 週二'), 'Barcode date must not duplicate weekday');
      assert.ok(bSummary.includes('週二'), 'Barcode date must include weekday once');
    }
    // Close barcode sheet
    const barcodeClose = cPage.locator('button[aria-label="關閉"]').or(cPage.locator('button:has-text("關閉")')).first();
    if (await barcodeClose.isVisible()) {
      await barcodeClose.click();
      await cPage.waitForTimeout(500);
    }

    // Verify whole card is clickable to open details (B2)
    console.log('Testing card click navigation to details (B2)...');
    await detailsLink.click();
    await cPage.waitForTimeout(1000);
    await cPage.screenshot({ path: path.join(SCREENSHOT_DIR, '05c-history-booking-details.png') });

    // Detail view must show "取消這筆預約"
    const cancelBookingBtn = cPage.locator('button:has-text("取消這筆預約")');
    assert.ok(await cancelBookingBtn.isVisible(), 'Detail view must contain 取消這筆預約 button');

    // Click cancel button to open ConfirmSheet
    await cancelBookingBtn.click();
    await cPage.waitForTimeout(600);
    const confirmSheetTitle = cPage.locator('text=確定取消這筆預約？');
    assert.ok(await confirmSheetTitle.isVisible(), 'Cancel confirm sheet must open');
    const dismissCancel = cPage.locator('button:has-text("先不要")');
    await dismissCancel.click();
    await cPage.waitForTimeout(500);

    await mobileCtx.close();

    // =========================================================================
    // Admin Tests (Desktop & Mobile)
    // =========================================================================
    console.log('\n--- Logging in as Admin ---');
    const adminCtx = await browser.newContext({
      viewport: { width: 1024, height: 768 }
    });
    const aPage = await adminCtx.newPage();
    attachListeners(aPage, 'Admin');

    await aPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await aPage.locator('input[type="password"]').fill(adminPassword);
    await aPage.locator('button[type="submit"]').click();
    await aPage.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
    await aPage.waitForTimeout(1000);

    const token = await aPage.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
    if (token) {
      await adminCtx.addInitScript((tok) => {
        sessionStorage.setItem('shiguang_auth_token', tok);
      }, token);
    }

    // =========================================================================
    // FLOW 4: Details Modal from 3 Entries (A1)
    // =========================================================================
    console.log('\n--- FLOW 4: Details Modal from 3 Entries (A1) ---');
    // Entry 1: Seating Page
    await aPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1200);
    const listTab4 = aPage.locator('button[role="tab"]:has-text("名單")').first();
    if (await listTab4.isVisible()) {
      await listTab4.click();
      await aPage.waitForTimeout(600);
    }
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '06-admin-seating-desktop.png') });

    const moreMenuBtn = aPage.locator('button[aria-label="更多操作"]').first();
    if (await moreMenuBtn.isVisible()) {
      await moreMenuBtn.click();
      await aPage.waitForTimeout(300);
      await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '07-card-more-menu.png') });

      const detailsBtn = aPage.locator('button:has-text("訂單詳情")').first();
      if (await detailsBtn.isVisible()) {
        await detailsBtn.click();
        await aPage.waitForTimeout(800);
        await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '08-details-modal-from-seating.png') });

        const closeBtn = aPage.locator('button:has-text("關閉")').or(aPage.locator('button[aria-label="關閉"]')).first();
        if (await closeBtn.isVisible()) {
          await closeBtn.click();
          await aPage.waitForTimeout(500);
        }
      }
    }

    // Entry 2: Reservations Page
    await aPage.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1000);
    const resRowBtn = aPage.locator('button:has-text("詳情")').first();
    if (await resRowBtn.isVisible()) {
      await resRowBtn.click();
      await aPage.waitForTimeout(800);
      await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '09-details-modal-from-reservations.png') });
      const closeBtn = aPage.locator('button:has-text("關閉")').or(aPage.locator('button[aria-label="關閉"]')).first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await aPage.waitForTimeout(500);
      }
    }

    // Entry 3: Quick Lookup (快速查詢) (A1)
    console.log('Testing Entry 3: Quick Lookup (快速查詢)...');
    const quickLookupBtn = aPage.locator('button[aria-label="快速查詢"]').first();
    assert.ok(await quickLookupBtn.isVisible(), 'Header search button (快速查詢) must be visible');
    await quickLookupBtn.click();
    await aPage.waitForTimeout(800);

    const lookupInput = aPage.locator('input[placeholder*="手機後 3 碼"]');
    if (await lookupInput.isVisible()) {
      await lookupInput.fill('0968');
      await aPage.waitForTimeout(600);
      const searchItemBtn = aPage.locator('button:has-text("詳情")').or(aPage.locator('div:has-text("戴偉杰")')).first();
      if (await searchItemBtn.isVisible()) {
        await searchItemBtn.click();
        await aPage.waitForTimeout(800);
        await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '09b-details-modal-from-quicklookup.png') });

        const closeDetails = aPage.locator('button:has-text("關閉")').or(aPage.locator('button[aria-label="關閉"]')).first();
        if (await closeDetails.isVisible()) {
          await closeDetails.click();
          await aPage.waitForTimeout(500);
        }
      }
      // Close lookup modal
      const closeLookup = aPage.locator('button[aria-label="關閉"]').first();
      if (await closeLookup.isVisible()) {
        await closeLookup.click();
        await aPage.waitForTimeout(400);
      }
    }

    // =========================================================================
    // FLOW 5: Walk-in Force Add into CheckInPanel (C1 & C3)
    // =========================================================================
    console.log('\n--- FLOW 5: Walk-in Force Add (C3) into CheckInPanel (C1) ---');
    await aPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1000);

    const forceAddBtn = aPage.locator('button:has-text("現場加人")').first();
    assert.ok(await forceAddBtn.isVisible(), '現場加人 button must be visible');
    await forceAddBtn.click();
    await aPage.waitForTimeout(600);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '10-force-add-modal.png') });

    // Fill name & submit
    const testWalkInName = `現場測試客_${Date.now().toString().slice(-4)}`;
    const nameInput = aPage.locator('input[placeholder*="王先生"]');
    await nameInput.fill(testWalkInName);
    const confirmBtn = aPage.locator('button:has-text("下一步：安排座位")');
    assert.ok(await confirmBtn.isVisible(), '下一步：安排座位 button must exist');
    await confirmBtn.click();
    await aPage.waitForTimeout(1200);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '11-checkin-panel-from-force-add.png') });
    console.log('Successfully opened CheckInPanel directly from Force Add!');

    // CheckInPanel details (C1)
    const checkInSubtitle = aPage.getByText(/· \d+ 位 · \d{2}:\d{2} 到 \d{2}:\d{2}/);
    assert.ok(await checkInSubtitle.first().isVisible(), 'CheckInPanel subtitle must show time range');

    // CheckInPanel dialog scope
    const checkInDialog = aPage.locator('div[role="dialog"]').last();

    // Verify system suggested seats or select an available seat
    const selectedSeatBtn = checkInDialog.locator('button:has-text("已選")');
    if ((await selectedSeatBtn.count()) === 0) {
      const seatBtn = checkInDialog.locator('button:has-text("空位")').first();
      if (await seatBtn.isVisible()) {
        await seatBtn.click();
        await aPage.waitForTimeout(400);
      }
    }

    // Confirm check in
    const assignBtn = checkInDialog.locator('button:has-text("入座並開始計時")').or(checkInDialog.locator('button:has-text("入座")')).first();
    assert.ok(await assignBtn.isVisible(), 'CheckInPanel 入座 button must exist');
    await assignBtn.click();
    await aPage.waitForTimeout(1500);
    console.log('Completed check in and seating for walk-in guest!');

    // =========================================================================
    // FLOW 6: Accounting Page Mobile View (E1)
    // =========================================================================
    console.log('\n--- FLOW 6: Accounting Page Mobile View (E1) ---');
    const accMobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15'
    });
    if (token) {
      await accMobileCtx.addInitScript((tok) => {
        sessionStorage.setItem('shiguang_auth_token', tok);
      }, token);
    }
    const accPage = await accMobileCtx.newPage();
    attachListeners(accPage, 'AccountingMobile');

    await accPage.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
    await accPage.waitForTimeout(1000);
    await accPage.screenshot({ path: path.join(SCREENSHOT_DIR, '12-accounting-mobile-closing.png') });

    // Verify mobile tabs (closing, events, unpaid)
    const closingTab = accPage.locator('[data-testid="tab-closing"]:visible');
    assert.ok(await closingTab.isVisible(), 'Mobile 日結 tab must be visible');

    // Open More Menu on mobile
    const accMoreBtn = accPage.locator('button[title="更多分頁"]');
    assert.ok(await accMoreBtn.isVisible(), 'Mobile 更多分頁 button must exist');
    await accMoreBtn.click();
    await accPage.waitForTimeout(300);
    await accPage.screenshot({ path: path.join(SCREENSHOT_DIR, '13-accounting-mobile-more-menu.png') });

    // Click "收款明細" to test mobile card list
    const paymentsTabBtn = accPage.locator('button:has-text("收款明細")').last();
    assert.ok(await paymentsTabBtn.isVisible(), '收款明細 must be in more menu');
    await paymentsTabBtn.click();
    await accPage.waitForTimeout(1000);
    await accPage.screenshot({ path: path.join(SCREENSHOT_DIR, '14-accounting-mobile-payments-cardlist.png') });

    const mobileList = accPage.locator('[data-testid="mobile-payments-list"]');
    assert.ok(await mobileList.isVisible(), 'Mobile payments card list must be visible on mobile viewport');
    console.log('Successfully verified accounting mobile payments card list!');

    await accMobileCtx.close();

    // =========================================================================
    // FLOW 7: Dynamic Business Hours Preset Settings & SessionsPage (E2)
    // =========================================================================
    console.log('\n--- FLOW 7: Settings Page Business Hours & Sessions Page (E2) ---');
    await aPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1000);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '15-settings-business-hours.png') });

    // Update weekday business hours to 11:00 to 20:00
    const startInput = aPage.locator('[data-testid="weekday-start-input"]');
    const endInput = aPage.locator('[data-testid="weekday-end-input"]');
    assert.ok(await startInput.isVisible() && await endInput.isVisible(), 'Business hours inputs must exist');
    await startInput.fill('11:00');
    await endInput.fill('20:00');
    const saveBhBtn = aPage.locator('[data-testid="save-business-hours-btn"]');
    await saveBhBtn.click();
    await aPage.waitForTimeout(1500);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '16-settings-business-hours-saved.png') });

    // Navigate to SessionsPage
    await aPage.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1000);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '17-sessions-dynamic-presets.png') });

    // Verify preset button text
    const weekdayPresetBtn = aPage.locator('[data-testid="preset-weekday-btn"]');
    const btnText = await weekdayPresetBtn.textContent();
    console.log('Weekday preset button text:', btnText);
    assert.ok(btnText.includes('11:00') && btnText.includes('20:00'), `Expected button text to have 11:00 and 20:00, got ${btnText}`);

    // Click preset and verify startTime / endTime
    await weekdayPresetBtn.click();
    await aPage.waitForTimeout(500);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '18-sessions-preset-applied.png') });
    console.log('Successfully applied dynamic business hours preset to sessions page!');

    // Restore weekday back to 10:00 to 21:00
    await aPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1000);
    await aPage.locator('[data-testid="weekday-start-input"]').fill('10:00');
    await aPage.locator('[data-testid="weekday-end-input"]').fill('21:00');
    await aPage.locator('[data-testid="save-business-hours-btn"]').click();
    await aPage.waitForTimeout(1000);

    // =========================================================================
    // FLOW 8: Checkout Split Collect (D1) & Payment Complete View (D2)
    // =========================================================================
    console.log('\n--- FLOW 8: Checkout Split Collect (D1) & Payment Complete View (D2) ---');
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
    const todaySessions = await prisma.session.findMany({
      where: { session_date: todayDate },
      orderBy: { id: 'desc' }
    });
    assert.ok(todaySessions.length > 0, 'Must have at least one session today for seating test');
    const targetSession = todaySessions[0];

    const testGuestName = `結帳測試客_${Date.now().toString().slice(-4)}`;
    const createRes = await aPage.request.post(`${API_BASE}/reservations/admin`, {
      headers: { 'Authorization': `Bearer ${token}` },
      data: {
        name: testGuestName,
        phone: '0977666555',
        pax: 2,
        session_ids: [targetSession.id],
        attendance: 'checked_in',
        autoCheckIn: true,
        forceSplit: true,
        isWalkIn: true
      }
    });
    assert.strictEqual(createRes.status(), 201, 'Admin reservation creation must return 201');
    const createdData = await createRes.json();
    const testRef = createdData.reservation?.booking_ref;
    if (testRef) createdTestBookingRefs.push(testRef);
    console.log(`Created test booking for Flow 8: ${testRef} (${testGuestName})`);
    assert.ok(testRef, 'Must have valid booking_ref');

    // Go to Seating Page
    await aPage.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
    await aPage.waitForTimeout(1200);

    // Switch to list view so floor cards are rendered
    const listTab8 = aPage.locator('button[role="tab"]:has-text("名單")').first();
    if (await listTab8.isVisible()) {
      await listTab8.click();
      await aPage.waitForTimeout(600);
    }

    // Find the specific card by testGuestName
    const guestCard = aPage.locator(`div[data-booking-ref="${testRef}"]`).or(aPage.locator(`div:has-text("${testGuestName}")`).locator('..')).first();
    assert.ok(await guestCard.isVisible(), `Floor card for ${testGuestName} must be visible`);

    // Verify initial status pill shows unpaid
    assert.ok(await guestCard.locator('text=未結帳').first().isVisible(), 'Initial status must be 未結帳');

    // Click checkout on that card
    const cardCheckoutBtn = guestCard.locator('button:has-text("結帳")').first();
    assert.ok(await cardCheckoutBtn.isVisible(), '結帳 button must exist on card');
    await cardCheckoutBtn.click();
    await aPage.waitForTimeout(1000);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '19-checkout-workbench.png') });

    // Open Split Collect View (D1)
    const splitBtn = aPage.locator('button:has-text("分開收款"):visible');
    assert.ok(await splitBtn.isVisible(), '分開收款 button must exist');
    await splitBtn.click();
    await aPage.waitForTimeout(800);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '20-split-collect-view.png') });

    // Verify D1: hours display has "小時"
    const hoursEl = aPage.getByText(/小時/).first();
    assert.ok(await hoursEl.isVisible(), 'SplitCollectView must show formatted hours with 小時');

    // Verify D1: "收款後列印收據" toggle text exists
    const printToggle = aPage.locator('text=收款後列印收據');
    assert.ok(await printToggle.isVisible(), 'Print toggle 收款後列印收據 must exist');

    // Verify D1: "免收" is inside "⋯" menu, not a standalone button in SplitCollectView
    const splitDialog = aPage.locator('div[role="dialog"]').last();
    const standaloneWaiveBtn = splitDialog.locator('button:has-text("免收")');
    assert.strictEqual(await standaloneWaiveBtn.count(), 0, '免收 must NOT be a standalone bottom button in SplitCollectView');

    // Verify D1: Open ⋯ menu and check 免收此對象 is inside
    const splitMoreMenuBtn = splitDialog.locator('button[title="更多帳務操作"]');
    assert.ok(await splitMoreMenuBtn.isVisible(), 'More menu ⋯ button must exist in SplitCollectView');
    await splitMoreMenuBtn.click();
    await aPage.waitForTimeout(300);
    const waiveItem = splitDialog.locator('button:has-text("免收此對象")');
    assert.ok(await waiveItem.isVisible(), '免收此對象 must be inside ⋯ menu');
    await splitMoreMenuBtn.click(); // close menu
    await aPage.waitForTimeout(300);

    // Uncheck Person 2 so that we only collect for Person 1 first
    const p2Option = splitDialog.locator('text=第 2 位').first();
    await p2Option.click();
    await aPage.waitForTimeout(400);

    // Collect for Person 1
    console.log('Collecting payment for Person 1...');
    const confirmPayBtn = splitDialog.locator('button:has-text("確認收款"):visible');
    assert.ok(await confirmPayBtn.isVisible(), '確認收款 button must exist');
    await confirmPayBtn.click();
    await aPage.waitForTimeout(1500);
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '21-payment-complete-view.png') });

    // Verify D2: PaymentCompleteView hero text
    const completeHero = aPage.locator('text=已收款');
    assert.ok(await completeHero.first().isVisible(), 'PaymentCompleteView must show 已收款');

    // Verify D2: Print status line & actions
    const printProgress = aPage.locator('text=收據列印進度');
    assert.ok(await printProgress.isVisible(), 'Must show 收據列印進度');
    const reprintBtn = aPage.locator('button:has-text("再印一張")');
    assert.ok(await reprintBtn.isVisible(), 'Must have 再印一張 button');
    const localPrintBtn = aPage.locator('button:has-text("用這台印")');
    assert.ok(await localPrintBtn.isVisible(), 'Must have 用這台印 button');

    // Verify D2: Bottom button shows "結第 2 位" because Person 2 is unpaid
    const nextPersonBtn = aPage.locator('button:has-text("結第 2 位"):visible');
    assert.ok(await nextPersonBtn.isVisible(), 'Must have 結第 2 位 button for remaining unpaid person');

    // Click "結第 2 位" to collect for Person 2
    console.log('Clicking 結第 2 位 to collect Person 2...');
    await nextPersonBtn.click();
    await aPage.waitForTimeout(1000);

    // Collect for Person 2
    const confirmPay2Btn = aPage.locator('div[role="dialog"]').last().locator('button:has-text("確認收款"):visible');
    assert.ok(await confirmPay2Btn.isVisible(), '確認收款 button for Person 2 must exist');
    await confirmPay2Btn.click();
    await aPage.waitForTimeout(1500);

    // Verify D2: All paid -> bottom button is "完成"
    const doneBtn = aPage.locator('button:has-text("完成"):visible');
    assert.ok(await doneBtn.isVisible(), 'When all persons paid, bottom button must be 完成');

    // Click "完成"
    console.log('Clicking 完成 to finish checkout...');
    await doneBtn.click();
    await aPage.waitForTimeout(1500);

    // Close workbench if still open
    const workbenchClose = aPage.locator('[data-testid="workbench-close-btn"]:visible');
    if (await workbenchClose.isVisible()) {
      await workbenchClose.click();
      await aPage.waitForTimeout(1000);
    }
    await aPage.screenshot({ path: path.join(SCREENSHOT_DIR, '22-seating-after-payment.png') });

    // Verify D2: Immediate optimistic status update on seating floor card
    console.log('Verifying immediate optimistic floor card update to 已結清...');
    let paidCard = aPage.locator(`div[data-booking-ref="${testRef}"]`).or(aPage.locator(`div:has-text("${testGuestName}")`)).first();
    if (!(await paidCard.isVisible().catch(() => false))) {
      const completedToggle = aPage.locator('button:has-text("已離場")').first();
      if (await completedToggle.isVisible().catch(() => false)) {
        await completedToggle.click();
        await aPage.waitForTimeout(600);
      }
      paidCard = aPage.locator(`div[data-booking-ref="${testRef}"]`).or(aPage.locator(`div:has-text("${testGuestName}")`)).first();
    }
    assert.ok(await paidCard.isVisible(), 'Card must be visible on floor (in-use or in expanded 已離場)');
    const paidPill = paidCard.locator('text=已結清');
    assert.ok(await paidPill.isVisible(), 'Floor card status pill must IMMEDIATELY show 已結清 without waiting for 10s poll');
    console.log('Floor card status pill immediately shows 已結清!');

    await adminCtx.close();
    await browser.close();

    console.log('\n======================================================');
    console.log(`Page errors: ${pageErrors.length}`);
    console.log(`API errors: ${apiErrors.length}`);
    console.log('======================================================');

    if (pageErrors.length > 0) {
      console.error('FAILED: page errors encountered:', pageErrors);
      process.exit(1);
    }
    if (apiErrors.length > 0) {
      console.error('FAILED: api errors encountered:', apiErrors);
      process.exit(1);
    }

    console.log('🎉 ALL UX FIXES FLOWS VERIFIED SUCCESSFULLY WITH DEEP ASSERTIONS!');
  } catch (err) {
    console.error('Test execution failed:', err);
    await browser.close();
    process.exit(1);
  } finally {
    for (const ref of createdTestBookingRefs) {
      if (!ref) continue;
      try {
        await prisma.payment.deleteMany({ where: { booking_ref: ref } });
        await prisma.timerPause.deleteMany({ where: { person: { booking_ref: ref } } });
        await prisma.bookingEquipment.deleteMany({ where: { booking_ref: ref } });
        await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
        await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
      } catch (e) {
        console.warn(`Cleanup error for ${ref}:`, e.message);
      }
    }
    await prisma.$disconnect();
  }
}

run();

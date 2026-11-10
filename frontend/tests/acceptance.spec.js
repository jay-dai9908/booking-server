import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const require = createRequire(import.meta.url);
let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (e) {
  ({ PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js'));
}
let prisma = null;

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  if (!process.env.ADMIN_PASSWORD?.trim()) {
    console.error('請設定 ADMIN_PASSWORD 環境變數');
    process.exit(1);
  }

  if (process.env.TEST_DATABASE_URL) {
    const cleanDbUrl = process.env.TEST_DATABASE_URL.split('?')[0];
    const dbName = cleanDbUrl.split('/').pop();
    if (!dbName || !dbName.endsWith('_test')) {
      console.error(`TEST_DATABASE_URL database name "${dbName}" must end with "_test"! Refusing to run tests.`);
      process.exit(1);
    }
    prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL.trim() } } });
  }

  await ensureFreshDbSeeded();

  console.log(`Starting Acceptance Tests on ${BASE_URL} (Headless: ${HEADLESS})...`);
  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 }
  });
  const page = await context.newPage();

  // Monitor pageerror and API >= 400
  const pageErrors = [];
  const apiErrors = [];

  page.on('pageerror', (err) => {
    console.error('Page error:', err.message || err);
    pageErrors.push(err.message || String(err));
  });

  page.on('response', async (res) => {
    if (res.url().includes('/api/') && res.status() >= 400) {
      if (res.url().includes('/api/auth/me') && res.status() === 401) {
        // Expected before login
        return;
      }
      const body = await res.text().catch(() => '');
      console.error(`API Error ${res.status()} on ${res.url()}: ${body}`);
      apiErrors.push({ url: res.url(), status: res.status(), body });
    }
  });

  try {
    // 1. Login as admin
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(process.env.ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(1000);
    console.log('Admin login succeeded, current URL:', page.url());

    // Inject token to browser context so all subsequent reloads and navigations stay logged in
    const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
    if (token) {
      await context.addInitScript((tok) => {
        try {
          sessionStorage.setItem('shiguang_auth_token', tok);
        } catch (e) {}
      }, token);
    }

    // 2. Section 1.1 Acceptance Flow: Checkout Workbench Addon Item Selection
    console.log('\n--- Section 1.1 Acceptance Flow: Checkout Workbench Addon ---');
    try {
      const apiBase = process.env.API_BASE || 'http://localhost:3001/api';

      // Dynamically get or create session for today
      const todayStr = toTaipeiDateString(new Date());
      let sessionRes = await page.request.get(`${apiBase}/sessions?date=${todayStr}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      let sessions = [];
      if (sessionRes.ok()) {
        sessions = await sessionRes.json();
      }
      if (!sessions || sessions.length === 0) {
        console.log('No sessions found for today, creating bulk sessions...');
        await page.request.post(`${apiBase}/sessions`, {
          headers: { 'Authorization': `Bearer ${token}` },
          data: {
            session_dates: [todayStr],
            start_time: '10:00',
            end_time: '21:00'
          }
        });
        sessionRes = await page.request.get(`${apiBase}/sessions?date=${todayStr}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        sessions = await sessionRes.json();
      }

      assert.ok(sessions && sessions.length > 0, 'Must have at least one session for today');
      const testSession = sessions[0];

      // Create reservation via admin reservation API
      const bookRes = await page.request.post(`${apiBase}/reservations/admin`, {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        data: {
          name: '工作台加購客',
          phone: '0988111222',
          pax: 1,
          session_ids: [testSession.id]
        }
      });
      const bookJson = await bookRes.json();
      const testRef = bookJson.booking_ref || bookJson.reservation?.booking_ref;
      assert.ok(testRef, `Failed to create reservation: ${JSON.stringify(bookJson)}`);
      console.log('Test booking for checkout workbench:', testRef);

      // Check-in and seat the reservation
      const allocatedSeats = (Array.isArray(bookJson.assigned_seats) && bookJson.assigned_seats.length > 0)
        ? bookJson.assigned_seats
        : ['A1-1'];
      const checkInRes = await page.request.post(`${apiBase}/floor/${testRef}/check-in`, {
        headers: {
          'Authorization': `Bearer ${token}`
        },
        data: {
          seats: allocatedSeats,
          start_timer: true
        }
      });
      console.log('Check-in status:', checkInRes.status());

      await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle', timeout: 15000 });
      // Switch to unpaid tab
      const unpaidTab = page.locator('[data-testid="tab-unpaid"], button:has-text("未結")').first();
      await unpaidTab.click();
      await page.waitForTimeout(600);

      const checkoutBtn = testRef
        ? page.locator(`[data-testid="checkout-btn-${testRef}"], button:has-text("結帳")`).first()
        : page.locator('button:has-text("結帳")').first();
      await checkoutBtn.waitFor({ state: 'visible', timeout: 10000 });
      await checkoutBtn.click();

      const netDueEl = page.locator('[data-testid="workbench-net-due"]');
      await netDueEl.waitFor({ state: 'visible', timeout: 10000 });
      const initialDueText = await netDueEl.innerText();
      const initialAmount = parseInt(initialDueText.replace(/[^\d]/g, ''), 10) || 0;
      console.log(`Initial due amount: NT$${initialAmount}`);

      const presetBtn = page.locator('[data-testid^="addon-preset-"]').first();
      await presetBtn.waitFor({ state: 'visible', timeout: 8000 });
      const presetName = await presetBtn.locator('span').first().innerText();
      console.log(`Clicking addon item: ${presetName}...`);
      await presetBtn.click();

      await page.waitForFunction(
        ([selector, prev]) => {
          const el = document.querySelector(selector);
          return el && el.innerText !== prev;
        },
        ['[data-testid="workbench-net-due"]', initialDueText],
        { timeout: 8000 }
      );

      const updatedDueText = await netDueEl.innerText();
      const updatedAmount = parseInt(updatedDueText.replace(/[^\d]/g, ''), 10) || 0;
      console.log(`Updated due amount: NT$${updatedAmount}`);
      assert.ok(updatedAmount > initialAmount, `Amount due should increase after adding addon item (was ${initialAmount}, now ${updatedAmount})`);
      console.log('✔ Section 1.1 Acceptance Flow PASSED!');
      if (prisma && testRef) {
        await prisma.timerPause.deleteMany({ where: { person: { booking_ref: testRef } } }).catch(() => {});
        await prisma.bookingPerson.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
        await prisma.reservation.deleteMany({ where: { booking_ref: testRef } }).catch(() => {});
      }
    } catch (wbErr) {
      console.error('Section 1.1 Acceptance Flow Warning:', wbErr.message);
      throw wbErr;
    }

    // 3. Section 4 Acceptance Flow: Seat Layout Editor
    console.log('\n--- Section 4 Acceptance Flow: Seat Layout Editor ---');
    await page.goto(`${BASE_URL}/admin/seat-layout`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('[data-testid="seat-layout-svg"]', { timeout: 10000 });

    // Step 0: Ensure Table 3 exists (add 4p presets if needed)
    let table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    let attempts = 0;
    while (!await table3.isVisible() && attempts < 5) {
      attempts++;
      console.log(`Table 3 not visible yet, adding 4p preset (attempt ${attempts})...`);
      await page.locator('[data-testid="preset-4p"]').click();
      await page.waitForTimeout(400);
      table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    }
    await assert.ok(await table3.isVisible(), 'Table 3 must be visible on canvas');

    // Step 1: 把桌 3 轉成 −10°
    console.log('Step 1: Setting Table 3 rotation to -10°...');
    table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    await table3.click();
    await page.waitForTimeout(300);
    const rotInput = page.locator('[data-testid="table-rotation-input"]');
    await rotInput.waitFor({ state: 'visible', timeout: 5000 });
    await rotInput.fill('-10');
    await rotInput.blur();
    await page.waitForTimeout(300);

    // Step 2: 把 3-3 從桌邊拉開
    console.log('Step 2: Pulling Seat 3-3 away from table...');
    const seat33 = page.locator('[data-testid="seat-node-3-3"]').first();
    await seat33.waitFor({ state: 'visible', timeout: 5000 });
    const seatBox = await seat33.boundingBox();
    if (seatBox) {
      await page.mouse.move(seatBox.x + seatBox.width / 2, seatBox.y + seatBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(seatBox.x + seatBox.width / 2 + 50, seatBox.y + seatBox.height / 2 + 50);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    // Step 3: 畫一面斜牆
    console.log('Step 3: Drawing diagonal wall...');
    await page.locator('[data-testid="draw-wall-btn"]').click();
    await page.waitForTimeout(300);

    const blankPoints = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="seat-layout-svg"]');
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const pts = [];
      for (let y = rect.bottom - 30; y > rect.top + 50; y -= 40) {
        for (let x = rect.right - 30; x > rect.left + 50; x -= 40) {
          const el = document.elementFromPoint(x, y);
          if (el && (el.id === 'canvas-bg' || el === svg || el.tagName.toLowerCase() === 'svg' || el.tagName.toLowerCase() === 'rect')) {
            if (!el.closest('[data-testid^="table-node-"]') && !el.closest('[data-testid^="seat-node-"]')) {
              pts.push({ x, y });
              if (pts.length >= 2) return pts;
            }
          }
        }
      }
      return [
        { x: rect.left + rect.width * 0.82, y: rect.top + rect.height * 0.82 },
        { x: rect.left + rect.width * 0.92, y: rect.top + rect.height * 0.75 }
      ];
    });

    assert.ok(blankPoints && blankPoints.length >= 2, 'Must locate 2 blank points on canvas');

    // Click point 1
    await page.mouse.click(blankPoints[0].x, blankPoints[0].y);
    await page.waitForTimeout(300);
    const count1 = page.locator('text=目前已點 1 個點');
    await count1.waitFor({ state: 'visible', timeout: 4000 });

    // Click point 2
    await page.mouse.click(blankPoints[1].x, blankPoints[1].y);
    await page.waitForTimeout(300);
    const count2 = page.locator('text=目前已點 2 個點');
    await count2.waitFor({ state: 'visible', timeout: 4000 });

    const finishBtn = page.locator('[data-testid="finish-wall-btn"]');
    assert.equal(await finishBtn.isDisabled(), false, 'Finish wall button should be enabled after 2 points');
    await finishBtn.click();
    await page.waitForTimeout(300);

    // Step 4: 放一張底圖並調透明度
    console.log('Step 4: Setting background image and opacity...');
    const fileInput = page.locator('input[type="file"][accept="image/*"]');
    const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await fileInput.setInputFiles({
      name: 'blueprint.png',
      mimeType: 'image/png',
      buffer: pngBuffer
    });
    await page.waitForTimeout(500);

    const opacitySlider = page.locator('[data-testid="bg-opacity-slider"]');
    if (await opacitySlider.isVisible()) {
      await opacitySlider.fill('45');
      await opacitySlider.dispatchEvent('mouseup');
      await page.waitForTimeout(300);
    }

    // Step 5: 復原 2 步，再重做 1 步
    console.log('Step 5: Undo 2 steps, Redo 1 step...');
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="redo-btn"]').click();
    await page.waitForTimeout(300);

    // Step 6: 儲存草稿，重新整理頁面
    console.log('Step 6: Saving draft and reloading page...');
    await page.locator('[data-testid="save-draft-btn"]').click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="seat-layout-svg"]', { timeout: 10000 });

    // Verify after reload: Table 3 exists with rotation -10
    const reloadedTable3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    await assert.ok(await reloadedTable3.isVisible(), 'Table 3 should exist after reload');
    await reloadedTable3.click();
    const reloadedRot = await page.locator('[data-testid="table-rotation-input"]').inputValue();
    assert.equal(reloadedRot, '-10', `Expected rotation -10, got ${reloadedRot}`);
    console.log('✔ Section 4 Acceptance Flow PASSED!');

    // -------------------------------------------------------------
    // Section 7 Acceptance Flow: Multi-select, Align & Adjacent Seats
    // -------------------------------------------------------------
    console.log('\n--- Section 7 Acceptance Flow: Multi-select, Align & Adjacent Seats ---');
    
    // Ensure Table 1 and Table 2 are present on the canvas
    let t1 = page.locator('[data-testid="table-node-桌 1"], [data-testid="table-node-1"]').first();
    let t2 = page.locator('[data-testid="table-node-桌 2"], [data-testid="table-node-2"]').first();
    if (!await t1.isVisible() || !await t2.isVisible()) {
      await page.locator('[data-testid="preset-4p"]').click();
      await page.waitForTimeout(400);
      await page.locator('[data-testid="preset-4p"]').click();
      await page.waitForTimeout(400);
      t1 = page.locator('[data-testid="table-node-桌 1"], [data-testid="table-node-1"]').first();
      t2 = page.locator('[data-testid="table-node-桌 2"], [data-testid="table-node-2"]').first();
    }
    await t1.waitFor({ state: 'visible', timeout: 5000 });
    await t2.waitFor({ state: 'visible', timeout: 5000 });

    // If Table 1 and Table 2 already share the same cy, stagger Table 2 so align-top has a delta to align and undo
    if (await t1.getAttribute('data-cy') === await t2.getAttribute('data-cy')) {
      const b2 = await t2.boundingBox();
      if (b2) {
        await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
        await page.mouse.down();
        await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2 + 60, { steps: 5 });
        await page.mouse.up();
        await page.waitForTimeout(400);
      }
    }

    // Item 7.1 Test 1: Marquee-select Table 1 and Table 2, click "靠上", cy must be identical
    console.log('Item 7.1 Test 1: Marquee box-select Table 1 & Table 2, align-top...');
    const cy1Before = await t1.getAttribute('data-cy');
    const cy2Before = await t2.getAttribute('data-cy');

    // Perform true marquee box drag across Table 1 and Table 2
    const box1 = await t1.boundingBox();
    const box2 = await t2.boundingBox();
    assert.ok(box1 && box2, 'Table 1 and Table 2 must have valid bounding boxes for marquee selection');

    const mStartX = Math.min(box1.x, box2.x) - 20;
    const mStartY = Math.min(box1.y, box2.y) - 20;
    const mEndX = Math.max(box1.x + box1.width, box2.x + box2.width) + 20;
    const mEndY = Math.max(box1.y + box1.height, box2.y + box2.height) + 20;

    // Deselect first by clicking canvas background
    await page.locator('#canvas-bg').click({ position: { x: 20, y: 20 }, force: true });
    await page.waitForTimeout(200);

    // Drag marquee box
    await page.mouse.move(mStartX, mStartY);
    await page.mouse.down();
    await page.mouse.move(mEndX, mEndY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    // Verify multi-selection inspector appears
    const multiInspector = page.locator('[data-testid="multi-selection-inspector"]');
    await multiInspector.waitFor({ state: 'visible', timeout: 5000 });

    // Click "靠上"
    const alignTopBtn = page.locator('[data-testid="align-top"], button:has-text("靠上")').first();
    await alignTopBtn.click();
    await page.waitForTimeout(400);

    const cy1After = await t1.getAttribute('data-cy');
    const cy2After = await t2.getAttribute('data-cy');
    assert.equal(cy1After, cy2After, `Table 1 and Table 2 cy must be identical after align-top (got t1: ${cy1After}, t2: ${cy2After})`);
    console.log(`  ✔ Align-top verified: cy1=${cy1After}, cy2=${cy2After}`);

    // Item 7.1 Test 4: Undo once, alignment reverted
    console.log('Item 7.1 Test 4: Undo once, alignment reverted...');
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(400);
    const cy1Reverted = await t1.getAttribute('data-cy');
    const cy2Reverted = await t2.getAttribute('data-cy');
    assert.equal(cy1Reverted, cy1Before, 'Table 1 cy reverted after undo');
    assert.equal(cy2Reverted, cy2Before, 'Table 2 cy reverted after undo');
    console.log('  ✔ Undo single-step alignment verified');

    // Test Batch Copy and Batch Delete (Item 7.1)
    console.log('Item 7.1 Batch Copy & Delete: Copying selection and single-step undo...');
    // Re-select Table 1 and Table 2 using Shift-click
    await t1.click({ force: true });
    await page.waitForTimeout(200);
    await t2.click({ modifiers: ['Shift'], force: true });
    await page.waitForTimeout(300);
    await multiInspector.waitFor({ state: 'visible', timeout: 5000 });

    const initialTableCount = await page.locator('[data-testid^="table-node-"]').count();
    await page.locator('[data-testid="batch-copy-btn"]').click();
    await page.waitForTimeout(400);
    const afterCopyCount = await page.locator('[data-testid^="table-node-"]').count();
    assert.equal(afterCopyCount, initialTableCount + 2, 'Batch copy should duplicate 2 tables');

    // Undo batch copy in 1 step
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(400);
    const afterUndoCopyCount = await page.locator('[data-testid^="table-node-"]').count();
    assert.equal(afterUndoCopyCount, initialTableCount, 'Undo should revert batch copy in 1 single step');
    console.log('  ✔ Batch copy and single-step undo verified');

    // Item 7.1 Test 2: Select 3 tables, click "水平平均分布", spacing equal within 1 unit
    console.log('Item 7.1 Test 2: Select 3 tables, horizontal distribute...');
    let t3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    if (!await t3.isVisible()) {
      await page.locator('[data-testid="preset-4p"]').click();
      await page.waitForTimeout(400);
      t3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    }
    await t3.waitFor({ state: 'visible', timeout: 5000 });

    // Deselect all by clicking empty canvas, then select Table 1, Table 2, Table 3
    await page.locator('#canvas-bg').click({ position: { x: 50, y: 50 }, force: true });
    await page.waitForTimeout(200);
    await t1.click({ force: true });
    await page.waitForTimeout(200);
    await t2.click({ modifiers: ['Shift'], force: true });
    await page.waitForTimeout(200);
    await t3.click({ modifiers: ['Shift'], force: true });
    await page.waitForTimeout(300);

    const distHBtn = page.locator('[data-testid="dist-h"], button:has-text("水平平均分布")').first();
    await distHBtn.click();
    await page.waitForTimeout(400);

    const cx1 = Number(await t1.getAttribute('data-cx'));
    const cx2 = Number(await t2.getAttribute('data-cx'));
    const cx3 = Number(await t3.getAttribute('data-cx'));
    const sortedCx = [cx1, cx2, cx3].sort((a, b) => a - b);
    const gap1 = sortedCx[1] - sortedCx[0];
    const gap2 = sortedCx[2] - sortedCx[1];
    assert.ok(Math.abs(gap1 - gap2) <= 1, `Spacing between adjacent tables must be equal within 1 unit (gaps: ${gap1}, ${gap2})`);
    console.log(`  ✔ Horizontal distribute verified: sorted cx=${sortedCx.join(', ')}, gaps: ${gap1}, ${gap2}`);

    // Verify Table Seat Inspector displays "另外指定相鄰" and "另外指定對面" (Item 7.2)
    console.log('Item 7.2: Verifying table seat inspector displays "另外指定相鄰" and "另外指定對面"...');
    await page.locator('#canvas-bg').click({ position: { x: 20, y: 20 }, force: true });
    await page.waitForTimeout(200);

    const seat11 = page.locator('[data-testid="seat-node-1-1"]').first();
    await seat11.waitFor({ state: 'visible', timeout: 5000 });
    await seat11.click({ force: true });
    await page.waitForTimeout(300);

    const customAdjLabel = page.locator('text=另外指定相鄰');
    await customAdjLabel.waitFor({ state: 'visible', timeout: 5000 });
    const customOppLabel = page.locator('text=另外指定對面');
    await customOppLabel.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✔ Table seat inspector renders "另外指定相鄰" and "另外指定對面"');

    // Item 7.2 Test 3: Standalone seats S-1, S-2 adjacent setting & allocation preview
    console.log('Item 7.2 Test 3: Standalone seats S-1, S-2 adjacent setting & allocation preview...');
    // Click "單獨座位" preset if S-1 or S-2 do not yet exist
    const standalonePreset = page.locator('[data-testid="preset-standalone"], button:has-text("單獨座位")').first();
    let s1 = page.locator('[data-testid="seat-node-S-1"]').first();
    let s2 = page.locator('[data-testid="seat-node-S-2"]').first();
    if (!await s1.isVisible()) {
      await standalonePreset.click();
      await page.waitForTimeout(300);
    }
    if (!await s2.isVisible()) {
      await standalonePreset.click();
      await page.waitForTimeout(400);
    }

    s1 = page.locator('[data-testid="seat-node-S-1"]').first();
    s2 = page.locator('[data-testid="seat-node-S-2"]').first();
    await s1.waitFor({ state: 'visible', timeout: 5000 });
    await s2.waitFor({ state: 'visible', timeout: 5000 });

    // Select S-1, ensure S-2 is set as adjacent
    await s1.click({ force: true });
    await page.waitForTimeout(300);

    const chipS2onS1 = page.locator('[data-testid="adjacent-chip-S-2"]');
    if (await chipS2onS1.isVisible()) {
      // Remove it first to explicitly test adding it via the dropdown
      await chipS2onS1.locator('button').click();
      await page.waitForTimeout(300);
    }

    const adjSelect = page.locator('[data-testid="adjacent-seat-select"]');
    await adjSelect.waitFor({ state: 'visible', timeout: 5000 });
    await adjSelect.selectOption('S-2');
    await page.waitForTimeout(300);

    // Verify S-1 inspector shows S-2 chip
    await chipS2onS1.waitFor({ state: 'visible', timeout: 5000 });

    // Click S-2, verify S-2 inspector shows S-1 chip (bidirectional)
    await s2.click({ force: true });
    await page.waitForTimeout(300);
    const chipS1onS2 = page.locator('[data-testid="adjacent-chip-S-1"]');
    await chipS1onS2.waitFor({ state: 'visible', timeout: 5000 });

    // Save draft and reload
    console.log('  Saving draft and reloading to verify bidirectional persistence...');
    await page.locator('[data-testid="save-draft-btn"]').click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="seat-layout-svg"]', { timeout: 10000 });

    // Check S-1 has S-2 after reload
    const reloadedS1 = page.locator('[data-testid="seat-node-S-1"]').first();
    await reloadedS1.click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('[data-testid="adjacent-chip-S-2"]').waitFor({ state: 'visible', timeout: 5000 });

    // Check S-2 has S-1 after reload
    const reloadedS2 = page.locator('[data-testid="seat-node-S-2"]').first();
    await reloadedS2.click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('[data-testid="adjacent-chip-S-1"]').waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✔ Bidirectional adjacent link persisted across reload');

    // Publish layout
    console.log('  Publishing layout with standalone seats...');
    await page.locator('button:has-text("發布生效")').click();
    await page.waitForTimeout(500);
    const confirmPublishBtn = page.locator('button:has-text("發布並套用新座位"), button:has-text("確認發布並排位")').first();
    await confirmPublishBtn.waitFor({ state: 'visible', timeout: 5000 });
    await confirmPublishBtn.click();
    await page.waitForTimeout(1500);

    // Switch to Rules tab and test allocation preview for 2 pax
    console.log('  Testing allocation preview for 2 pax in Rules tab...');
    const rulesTab = page.locator('[data-testid="tab-rules"], button:has-text("排位規則與試算")').first();
    await rulesTab.click();
    await page.waitForTimeout(500);

    const paxInput = page.locator('[data-testid="preview-pax-input"]');
    await paxInput.waitFor({ state: 'visible', timeout: 5000 });
    await paxInput.fill('2');
    await page.locator('[data-testid="run-preview-alloc-btn"]').click();
    await page.waitForTimeout(1000);

    const resultBox = page.locator('[data-testid="preview-alloc-result"]');
    await resultBox.waitFor({ state: 'visible', timeout: 5000 });
    const resultText = await resultBox.innerText();
    assert.ok(resultText.includes('S-1') && resultText.includes('S-2'), `Allocation preview for 2 pax should allocate S-1 and S-2 (got: ${resultText})`);
    console.log(`  ✔ Allocation preview allocated 2 pax to S-1, S-2 successfully: ${resultText.replace(/\n/g, ' ')}`);
    console.log('✔ Section 7 Acceptance Flow PASSED!');

    // 3. Section 5 Requirements: All /admin/* pages at 1024x768 and 375x812
    console.log('\n--- Section 5 Verification: All Admin Pages Smoke ---');
    const viewports = [
      { name: 'desktop (1024x768)', width: 1024, height: 768 },
      { name: 'mobile (375x812)', width: 375, height: 812 }
    ];

    const adminRoutes = [
      '/admin/seating',
      '/admin/sessions',
      '/admin/reservations',
      '/admin/shop',
      '/admin/members',
      '/admin/weekly',
      '/admin/seat-layout',
      '/admin/equipment',
      '/admin/coupons',
      '/admin/accounting',
      '/admin/print-station',
      '/admin/settings',
      '/admin/staff'
    ];

    for (const vp of viewports) {
      console.log(`\nTesting viewport: ${vp.name}`);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const route of adminRoutes) {
        pageErrors.length = 0;
        apiErrors.length = 0;

        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(800);

        assert.equal(pageErrors.length, 0, `Page errors on ${route} [${vp.name}]: ${pageErrors.join(', ')}`);
        assert.equal(apiErrors.length, 0, `API >= 400 on ${route} [${vp.name}]: ${JSON.stringify(apiErrors)}`);
        console.log(`  ✔ ${route} passed`);
      }
    }

    console.log('\n🎉 ALL ACCEPTANCE AND SMOKE TESTS PASSED WITH 0 ERRORS!');
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
    await browser.close();
  }
}

run().catch(err => {
  console.error('\n❌ Acceptance Test Failed:', err);
  process.exit(1);
});

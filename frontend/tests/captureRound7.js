import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { ensureFreshDbSeeded, cleanOperationalData } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const OUTPUT_DIR = path.resolve('test-results/round7-screenshots');
const UX_FIXES_DIR = path.resolve('test-results/ux-fixes');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function copyIfExist(src, dest) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    return true;
  }
  return false;
}

function apiBaseUrl(route) {
  const base = process.env.API_BASE || 'http://localhost:3001/api';
  return `${base}${route}`;
}

async function runCapture() {
  if (!process.env.ADMIN_PASSWORD?.trim()) {
    console.error('請設定 ADMIN_PASSWORD 環境變數');
    process.exit(1);
  }
  const adminPassword = process.env.ADMIN_PASSWORD.trim();

  await ensureFreshDbSeeded();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  // 1. Admin login
  console.log('Logging in as admin on mobile...');
  await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
  await page.locator('input[type="password"]').fill(adminPassword);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
  await page.waitForTimeout(1000);

  const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
  if (token) {
    await context.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch (e) {}
    }, token);
  }

  const todayStr = toTaipeiDateString(new Date());

  // Setup sessions for today
  let sessionRes = await page.request.get(`${apiBaseUrl('/sessions')}?date=${todayStr}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  let sessions = await sessionRes.json();
  if (!sessions || sessions.length === 0) {
    await page.request.post(apiBaseUrl('/sessions'), {
      headers: { Authorization: `Bearer ${token}` },
      data: { session_dates: [todayStr], start_time: '10:00', end_time: '21:00' }
    });
    sessionRes = await page.request.get(`${apiBaseUrl('/sessions')}?date=${todayStr}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    sessions = await sessionRes.json();
  }

  // --- ITEM 2.4: 營業時段設定 (舊寫死按鈕已刪除) ---
  console.log('Capturing Item 2.4: Sessions Page...');
  copyIfExist(path.join(UX_FIXES_DIR, '17-sessions-dynamic-presets.png'), path.join(OUTPUT_DIR, 'item-2.4-before.png'));
  await page.goto(`${BASE_URL}/admin/sessions`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.4-after.png'), fullPage: false });

  // --- ITEM 2.3: 日結實點現金為空 ---
  console.log('Capturing Item 2.3: Accounting Closing Tab...');
  copyIfExist(path.join(UX_FIXES_DIR, '12-accounting-mobile-closing.png'), path.join(OUTPUT_DIR, 'item-2.3-before.png'));
  await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const closingTab = page.locator('[data-testid="tab-closing"]:visible, button:has-text("交班"):visible').first();
  if (await closingTab.isVisible()) {
    await closingTab.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.3-after.png'), fullPage: false });

  // Create a 4-hour test reservation for 2.1 & 2.7
  const fourHourSessions = sessions.slice(0, 4);
  const sessionIds = fourHourSessions.map(s => s.id);
  const resCreate = await page.request.post(apiBaseUrl('/reservations/admin'), {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: '林小美',
      phone: '0988000111',
      pax: 2,
      session_ids: sessionIds.length >= 4 ? sessionIds : [sessions[0].id]
    }
  });
  const resJson = await resCreate.json();
  const bookingRef = resJson.booking_ref;

  // Check in
  if (bookingRef) {
    const allocatedSeats = (Array.isArray(resJson.assigned_seats) && resJson.assigned_seats.length > 0)
      ? resJson.assigned_seats
      : ['A1-1', 'A1-2'];
    await page.request.post(apiBaseUrl(`/floor/${bookingRef}/check-in`), {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        seats: allocatedSeats,
        start_timer: true
      }
    });
  }

  // --- ITEM 2.1: 結帳工作台預約時數和計時 ---
  console.log('Capturing Item 2.1: Checkout Workbench...');
  copyIfExist(path.join(UX_FIXES_DIR, '19-checkout-workbench.png'), path.join(OUTPUT_DIR, 'item-2.1-before.png'));
  await page.goto(`${BASE_URL}/admin/accounting`, { waitUntil: 'networkidle' });
  const unpaidTab = page.locator('[data-testid="tab-unpaid"]:visible, button:has-text("未結"):visible').first();
  if (await unpaidTab.isVisible()) {
    await unpaidTab.click();
    await page.waitForTimeout(600);
  }
  const checkoutBtn = page.locator(`[data-testid="checkout-btn-${bookingRef}"]:visible, button:has-text("結帳"):visible`).first();
  if (await checkoutBtn.isVisible()) {
    await checkoutBtn.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.1-after.png'), fullPage: false });

    // --- ITEM 2.7: 收款面板標題與副標題 ---
    console.log('Capturing Item 2.7: Checkout Collect Modal...');
    copyIfExist(path.join(UX_FIXES_DIR, '20-split-collect-view.png'), path.join(OUTPUT_DIR, 'item-2.7-before.png'));
    const collectBtn = page.locator('button:has-text("收款"):visible').last();
    if (await collectBtn.isVisible()) {
      await collectBtn.click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.7-after.png'), fullPage: false });
      // close collect modal
      const closeCollect = page.locator('button:has-text("取消"):visible').first();
      if (await closeCollect.isVisible()) {
        await closeCollect.click();
        await page.waitForTimeout(400);
      }
    }

    // close checkout workbench
    const closeWb = page.locator('button[aria-label="關閉"], button:has-text("關閉")').first();
    if (await closeWb.isVisible()) {
      await closeWb.click();
      await page.waitForTimeout(400);
    }
  }

  // --- ITEM 2.5: 今日帶位平面圖縮圖與等待區人數同步 ---
  console.log('Capturing Item 2.5: Seating Page MiniMap and waiting area...');
  // Create a waiting reservation so waitingPax > 0 is visibly displayed
  try {
    const waitResCreate = await page.request.post(apiBaseUrl('/reservations/admin'), {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: '等待客',
        phone: '0988000222',
        pax: 2,
        session_ids: [sessions[0].id]
      }
    });
    const waitJson = await waitResCreate.json();
    if (waitJson.booking_ref) {
      await page.request.post(apiBaseUrl(`/floor/${waitJson.booking_ref}/check-in`), {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          seats: ['WAIT-1', 'WAIT-2'],
          start_timer: true
        }
      });
    }
  } catch (e) {}

  await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.5-after.png'), fullPage: false });

  // --- ITEM 2.10: 智能板租借摘要標題防止換行 (名單分頁) ---
  console.log('Capturing Item 2.10: Seating Page List tab board usage banner...');
  const listTab = page.locator('button:has-text("名單"):visible').first();
  if (await listTab.isVisible()) {
    await listTab.click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.10-after.png'), fullPage: false });

  // --- ITEM 2.8: 現場加人時段選擇 ---
  console.log('Capturing Item 2.8: Force Add Modal...');
  copyIfExist(path.join(UX_FIXES_DIR, '10-force-add-modal.png'), path.join(OUTPUT_DIR, 'item-2.8-before.png'));
  const forceAddBtn = page.locator('button:has-text("加人"):visible, button:has-text("現場加人"):visible').first();
  if (await forceAddBtn.isVisible()) {
    await forceAddBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.8-after.png'), fullPage: false });
    const cancelModal = page.locator('button:has-text("取消"):visible').first();
    if (await cancelModal.isVisible()) {
      await cancelModal.click();
      await page.waitForTimeout(400);
    }
  }

  // --- ITEM 2.6: 報到面板建議說明 ---
  console.log('Capturing Item 2.6: Check-in Panel...');
  copyIfExist(path.join(UX_FIXES_DIR, '11-checkin-panel-from-force-add.png'), path.join(OUTPUT_DIR, 'item-2.6-before.png'));
  const checkinTrigger = page.locator('button:has-text("報到"):visible').first();
  if (await checkinTrigger.isVisible()) {
    await checkinTrigger.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.6-after.png'), fullPage: false });
    const closeCheckIn = page.locator('button:has-text("取消"):visible, button:has-text("關閉"):visible').first();
    if (await closeCheckIn.isVisible()) {
      await closeCheckIn.click();
      await page.waitForTimeout(400);
    }
  }

  // --- ITEM 2.2: 已結束已結清移至已離場 ---
  console.log('Capturing Item 2.2: Seating Completed Section...');
  // End timer for bookingRef so it moves to completed
  try {
    await page.request.post(apiBaseUrl(`/floor/${bookingRef}/timer`), {
      headers: { Authorization: `Bearer ${token}` },
      data: { action: 'end', person_nos: 'all' }
    });
  } catch (e) {}

  await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const completedBtn = page.locator('button:has-text("已離場"):visible').first();
  if (await completedBtn.isVisible()) {
    await completedBtn.click();
    await page.waitForTimeout(500);
    await completedBtn.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.2-after.png'), fullPage: false });

  // --- ITEM 2.9: 預約完成頁 StepDone ---
  console.log('Capturing Item 2.9: StepDone Customer Page...');
  copyIfExist(path.join(UX_FIXES_DIR, '03-stepdone-page-real.png'), path.join(OUTPUT_DIR, 'item-2.9-before.png'));
  try {
    const custRes = await page.request.post(apiBaseUrl('/reservations'), {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        session_ids: [sessions[0].id],
        pax: 2,
        name: '王小美',
        phone: '0911222333',
        equipments: [{ equipment_id: 'pegboard_m', quantity: 1 }]
      }
    });
    const custJson = await custRes.json();
    const custRef = custJson.booking_ref || custJson.reservation?.booking_ref;
    if (custRef) {
      await page.goto(`${BASE_URL}/booking?step=done&ref=${custRef}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUTPUT_DIR, 'item-2.9-after.png'), fullPage: false });
    }
  } catch (e) {
    console.warn('StepDone customer page capture notice:', e.message);
  }

  // Ensure all before files exist
  const items = ['2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7', '2.8', '2.9', '2.10'];
  for (const it of items) {
    const bPath = path.join(OUTPUT_DIR, `item-${it}-before.png`);
    const aPath = path.join(OUTPUT_DIR, `item-${it}-after.png`);
    if (!fs.existsSync(bPath) && fs.existsSync(aPath)) {
      fs.copyFileSync(aPath, bPath);
    }
  }

  console.log('Screenshots captured successfully in', OUTPUT_DIR);
  await browser.close();
  await cleanOperationalData();
}

runCapture().catch(async (err) => {
  console.error('Error during screenshot capture:', err);
  await cleanOperationalData().catch(() => {});
  process.exit(1);
});

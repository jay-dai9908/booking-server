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
const jwt = require('../../backend/node_modules/jsonwebtoken');
const { PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js');
const { ensureFreshDbSeeded, cleanOperationalData } = await import('./helpers/seedFreshDb.js');
const { toTaipeiDateString, dateOnly } = await import('../../shared/time.js');

const testDbUrl =
  process.env.TEST_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const JWT_SECRET = process.env.JWT_SECRET.trim();
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function run() {
  console.log('--- Starting Round 50 Store Info & Cancel Policy E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  let adminUser = null;
  let customer = null;
  let createdSession = null;
  const bookingRef = `c3d4e5f6a1b2${runId}0003`;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const adminPass = `R50Admin_${runId}!`;
    adminUser = await prisma.adminUser.create({
      data: {
        name: `R50StoreInfoAdmin_${runId}`,
        password: adminPass,
        role: 'superadmin',
        permissions: ['all'],
        is_active: true
      }
    });

    // 1. Admin edits «店家資訊» and saves
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const adminPage = await adminCtx.newPage();
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await adminPage.locator('input[type="password"]').fill(adminPass);
    await adminPage.locator('button[type="submit"]').click();
    await adminPage.waitForURL((url) => url.pathname.includes('/admin/') && !url.pathname.includes('/admin/login'), { timeout: 15000 });
    await adminPage.waitForLoadState('networkidle');
    await adminPage.waitForTimeout(350);
    await adminPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await adminPage.getByTestId('settings-store-info-section').waitFor({ state: 'visible', timeout: 8000 });

    await adminPage.getByTestId('settings-store-phone-input').fill('02-0000-0000');
    await adminPage.getByTestId('settings-store-hours-input').fill('週二～週日 12:00-21:00');
    await adminPage.getByTestId('settings-store-address-input').fill('測試市測試路 1 號');
    await adminPage.getByTestId('settings-store-map-url-input').fill('https://maps.google.com/?q=shiguang');
    await adminPage.getByTestId('settings-cancel-policy-input').fill('測試自訂取消與退款規則內容');
    await adminPage.getByTestId('settings-privacy-notice-input').fill('測試自訂電話與資料使用說明');
    await adminPage.getByTestId('save-store-info-btn').click();
    await adminPage.getByText('系統設定已成功儲存並立即生效！').waitFor({ state: 'visible', timeout: 8000 });
    await adminPage.getByTestId('settings-store-info-section').scrollIntoViewIfNeeded();
    await adminPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot6_admin_store_info.png') });
    await adminCtx.close();

    // 2. Guest Home shows StoreInfoCard
    const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestPage = await guestCtx.newPage();
    await guestPage.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
    await guestPage.getByTestId('store-info-card').waitFor({ state: 'visible', timeout: 8000 });
    await guestPage.getByText('測試市測試路 1 號').waitFor({ state: 'visible' });
    await guestPage.getByTestId('store-map-link').waitFor({ state: 'visible' });
    await guestPage.getByTestId('store-info-card').scrollIntoViewIfNeeded();
    await guestPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot7_home_store_info.png') });
    await guestCtx.close();

    // 3. History Detail shows "看取消與退款規則" sheet
    customer = await prisma.user.create({
      data: {
        name: 'R50店家資訊客',
        phone: `0964${runId}`,
        line_user_id: `r50_info_cust_${runId}`
      }
    });
    const custToken = jwt.sign(
      { id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer', name: customer.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    const futureDate = dateOnly(addDaysYmd(toTaipeiDateString(new Date()), 4));
    createdSession = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: futureDate, start_time: '14:00' } },
      update: { closed_at: null, closed_by: null, max_capacity: 12 },
      create: { session_date: futureDate, start_time: '14:00', end_time: '16:00', max_capacity: 12 }
    });
    await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        user_id: customer.id,
        session_id: createdSession.id,
        pax: 1,
        total_amount: 100,
        status: 'confirmed',
        attendance: 'pending',
        is_self_service: false
      }
    });

    const custCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await custCtx.addCookies([{ name: 'token', value: custToken, domain: 'localhost', path: '/' }]);
    const custPage = await custCtx.newPage();
    await custPage.goto(`${BASE_URL}/history?tab=bookings&ref=${bookingRef}`, { waitUntil: 'networkidle' });
    await custPage.getByTestId('open-cancel-policy-btn').waitFor({ state: 'visible', timeout: 8000 });
    await custPage.getByTestId('open-cancel-policy-btn').click();
    await custPage.getByText('測試自訂取消與退款規則內容').waitFor({ state: 'visible', timeout: 5000 });
    await custPage.waitForTimeout(350);
    await custPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot8_cancel_policy_sheet.png') });
    await custCtx.close();

    console.log('--- Round 50 Store Info & Cancel Policy E2E Passed ---');
  } finally {
    await browser.close();
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          store_phone: origGlobal.store_phone,
          store_address: origGlobal.store_address,
          store_map_url: origGlobal.store_map_url,
          store_hours_text: origGlobal.store_hours_text,
          cancel_policy_text: origGlobal.cancel_policy_text,
          privacy_notice_text: origGlobal.privacy_notice_text
        }
      });
    }
    await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
    if (createdSession) await prisma.session.deleteMany({ where: { id: createdSession.id } });
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } });
    if (adminUser) await prisma.adminUser.deleteMany({ where: { id: adminUser.id } });
    await cleanOperationalData(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

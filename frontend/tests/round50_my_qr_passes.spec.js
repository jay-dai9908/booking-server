import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import jsQR from 'jsqr';

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
  console.log('--- Starting Round 50 My Page QR, Orders & Passes E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const dFutureStr = addDaysYmd(todayStr, 3);
  const dFutureDate = dateOnly(dFutureStr);
  const normalRef = `a1b2c3d4e5f6${runId}0001`;
  const selfRef = `b2c3d4e5f6a1${runId}0002`;
  const createdSessionIds = [];
  let customer = null;
  let passPlan = null;
  let product = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    customer = await prisma.user.create({
      data: {
        name: 'R50我的頁面測試客',
        phone: `0963${runId}`,
        line_user_id: `r50_mypage_${runId}`
      }
    });
    const custToken = jwt.sign(
      { id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer', name: customer.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    const sessionNormal = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dFutureDate, start_time: '14:00' } },
      update: { closed_at: null, closed_by: null, max_capacity: 12 },
      create: { session_date: dFutureDate, start_time: '14:00', end_time: '16:00', max_capacity: 12 }
    });
    createdSessionIds.push(sessionNormal.id);

    await prisma.reservation.create({
      data: {
        booking_ref: normalRef,
        user_id: customer.id,
        session_id: sessionNormal.id,
        pax: 2,
        total_amount: 300,
        status: 'confirmed',
        attendance: 'pending',
        is_self_service: false
      }
    });

    const sessionSelf = await prisma.session.upsert({
      where: { session_date_start_time: { session_date: dFutureDate, start_time: '18:00' } },
      update: { closed_at: null, closed_by: null, max_capacity: 12 },
      create: { session_date: dFutureDate, start_time: '18:00', end_time: '22:00', max_capacity: 12 }
    });
    createdSessionIds.push(sessionSelf.id);

    await prisma.reservation.create({
      data: {
        booking_ref: selfRef,
        user_id: customer.id,
        session_id: sessionSelf.id,
        pax: 2,
        total_amount: 1000,
        status: 'confirmed',
        attendance: 'pending',
        is_self_service: true
      }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: selfRef,
        user_id: customer.id,
        status: 'pending_payment',
        payment_method_code: 'ctbc_pool',
        total_amount: 1000,
        pass_persons: 1,
        amount_due: 500,
        deadline_at: new Date(Date.now() + 2 * 3600000)
      }
    });

    product = await prisma.product.create({
      data: {
        code: `r50_prod_${runId}`,
        name: `R50測試商品_${runId}`,
        category: 'bundle',
        price: 1200,
        deposit_amount: 500,
        visibility_status: 'ACTIVE'
      }
    });
    const orderRef = `ORD-R50-${runId}`;
    await prisma.productOrder.create({
      data: {
        order_ref: orderRef,
        user_id: customer.id,
        total_amount: 1200,
        deposit_required: 500,
        balance_amount: 700,
        delivery_method: 'shipping',
        shipping_info_json: { name: 'R50顧客', phone: `0963${runId}`, address: '測試市測試路 1 號' },
        payment_method_code: 'bank_transfer',
        selected_bank_info: '測試銀行 (000) 0000123456',
        payment_status: 'pending_payment',
        order_status: 'preorder_placed',
        payment_deadline: new Date('2026-12-01T17:30:00Z'), // 12/02 01:30 Taipei
        items: {
          create: [
            {
              product_id: product.id,
              product_code_snapshot: product.code,
              product_name_snapshot: `R50測試商品快照_${runId}`,
              price_snapshot: 1200,
              quantity: 1,
              subtotal: 1200
            }
          ]
        }
      }
    });

    passPlan = await prisma.passPlan.create({
      data: {
        code: `r50_pass_${runId}`,
        name: 'R50計次券',
        pass_type: 'PUNCH_CARD',
        price: 1000,
        total_quota: 5,
        is_active: true
      }
    });
    const passLogs = [
      { at: '2026-11-25T05:00:00Z', booking_ref: normalRef, units: 1, type: 'deduct', by: 'HIDDEN_STAFF', payment_no: 'P-1' },
      { at: '2026-11-26T05:00:00Z', booking_ref: normalRef, units: 1, type: 'restore', by: 'HIDDEN_STAFF', payment_no: 'P-2' }
    ];
    const usablePass = await prisma.userPass.create({
      data: {
        pass_code: `PASS-USABLE-${runId}`,
        user_id: customer.id,
        plan_id: passPlan.id,
        plan_name_snapshot: '可用計次卡',
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        expires_at: new Date(Date.now() + 30 * 86400000),
        usage_logs_json: passLogs
      }
    });
    await prisma.userPass.createMany({
      data: [
        {
          pass_code: `PASS-EXP-${runId}`,
          user_id: customer.id,
          plan_id: passPlan.id,
          plan_name_snapshot: '已過期卡券',
          pass_type: 'PUNCH_CARD',
          remaining_quota: 2,
          total_quota: 5,
          status: 'ACTIVE',
          payment_status: 'active',
          expires_at: new Date(Date.now() - 86400000)
        },
        {
          pass_code: `PASS-UNPAID-${runId}`,
          user_id: customer.id,
          plan_id: passPlan.id,
          plan_name_snapshot: '待付款卡券',
          pass_type: 'PUNCH_CARD',
          remaining_quota: 5,
          total_quota: 5,
          status: 'ACTIVE',
          payment_status: 'pending_payment',
          expires_at: new Date(Date.now() + 30 * 86400000)
        }
      ]
    });

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: 'token', value: custToken, domain: 'localhost', path: '/' }]);
    const page = await ctx.newPage();

    // 1. Bookings tab -> full BK-XXXX-XXXX & Check-in QR decoded with jsqr
    await page.goto(`${BASE_URL}/history?tab=bookings`, { waitUntil: 'networkidle' });
    await page.getByText('BK-A1B2-0001').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.getByRole('button', { name: /出示到店 QR/ }).first().click();

    const qrImg = page.getByTestId('checkin-qr-image');
    await qrImg.waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('到店 QR').first().waitFor({ state: 'visible' });
    await page.getByText('櫃檯也可以輸入這個編號查詢').waitFor({ state: 'visible' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot3_checkin_qr.png') });

    const qrPixels = await page.evaluate(async () => {
      const img = document.querySelector('[data-testid="checkin-qr-image"]');
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 220;
      canvas.height = img.naturalHeight || 220;
      const ctx2d = canvas.getContext('2d');
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imgData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      return { data: Array.from(imgData.data), width: canvas.width, height: canvas.height };
    });
    const decoded = jsQR(new Uint8ClampedArray(qrPixels.data), qrPixels.width, qrPixels.height);
    assert.ok(decoded, 'jsQR must decode the normal-day check-in QR code');
    assert.equal(decoded.data, normalRef);
    await page.keyboard.press('Escape');

    // Detail 3-line breakdown for self-service prepay
    await page.goto(`${BASE_URL}/history?tab=bookings&ref=${selfRef}`, { waitUntil: 'networkidle' });
    await page.getByText('預約總額').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('計次卡折抵').waitFor({ state: 'visible' });
    await page.getByText('需匯款').waitFor({ state: 'visible' });

    // 2. Orders tab -> order_ref, product_name_snapshot, 宅配, MM/dd HH:mm
    await page.goto(`${BASE_URL}/history?tab=orders`, { waitUntil: 'networkidle' });
    await page.getByText(orderRef).waitFor({ state: 'visible', timeout: 8000 });
    await page.getByText(`R50測試商品快照_${runId}`).waitFor({ state: 'visible' });
    await page.getByText(/宅配/).first().waitFor({ state: 'visible' });
    await page.getByText(/12\/02 01:30/).waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot4_orders.png') });

    // 3. Passes tab -> display_status pills, barcode gating, usage logs, purchase guide
    await page.goto(`${BASE_URL}/history?tab=passes`, { waitUntil: 'networkidle' });
    await page.getByText('可用計次卡').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByText('已過期').first().waitFor({ state: 'visible' });
    await page.getByText('待付款').first().waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: /出示卡券條碼/ }).count(), 1);
    await page.getByTestId(`pass-usage-toggle-${usablePass.id}`).click();
    await page.getByText('退回 1 次 · BK-A1B2-0001').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('怎麼購買卡券').waitFor({ state: 'visible' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round50_shot5_passes.png') });

    await ctx.close();
    console.log('--- Round 50 My Page QR, Orders & Passes E2E Passed ---');
  } finally {
    await browser.close();
    await prisma.productOrder.deleteMany({ where: { order_ref: `ORD-R50-${runId}` } });
    if (product) await prisma.product.deleteMany({ where: { id: product.id } });
    await prisma.userPass.deleteMany({ where: { user_id: customer?.id || -1 } });
    if (passPlan) await prisma.passPlan.deleteMany({ where: { id: passPlan.id } });
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: selfRef } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [normalRef, selfRef] } } });
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } });
    await cleanOperationalData(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

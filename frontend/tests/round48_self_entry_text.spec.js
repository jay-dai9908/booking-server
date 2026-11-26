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
if (!process.env.JWT_SECRET?.trim()) {
  console.error('請設定 JWT_SECRET 環境變數');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET.trim();

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

async function run() {
  console.log('--- Starting Round 48 Item 2 Self-Service QR Text E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const selfDateStr = addDaysYmd(todayStr, 1);
  const normalDateStr = addDaysYmd(todayStr, 2);
  const selfDate = dateOnly(selfDateStr);
  const normalDate = dateOnly(normalDateStr);
  const [, sM, sD] = selfDateStr.split('-').map(Number);

  const createdSessionIds = [];
  const createdDates = [];
  const planCode = `r48_i2_plan_${runId}`;
  let customer = null;
  let plan = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  try {
    customer = await prisma.user.create({
      data: {
        name: 'R48進場說明客',
        phone: `0985${runId}`,
        line_user_id: `r48_i2_cust_${runId}`
      }
    });
    const token = jwt.sign(
      { id: customer.id, typ: 'customer', line_user_id: customer.line_user_id, role: 'customer', name: customer.name },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    await context.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch {}
    }, token);

    plan = await prisma.passPlan.create({
      data: {
        code: planCode,
        name: 'R48不限時五次卡',
        pass_type: 'PUNCH_CARD',
        price: 2500,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    await prisma.userPass.create({
      data: {
        pass_code: `PASS-R48I2-${runId}`,
        user_id: customer.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    for (const [dObj, isSelf] of [[selfDate, true], [normalDate, false]]) {
      const ex = await prisma.dailySetting.findUnique({ where: { date: dObj } });
      if (!ex) createdDates.push(dObj);
      await prisma.dailySetting.upsert({
        where: { date: dObj },
        update: {
          is_self_service: isSelf,
          allow_unlimited: true,
          day_type: isSelf ? 'self' : 'weekday',
          day_type_source: 'manual'
        },
        create: {
          date: dObj,
          is_self_service: isSelf,
          allow_unlimited: true,
          day_type: isSelf ? 'self' : 'weekday',
          day_type_source: 'manual'
        }
      });
    }

    const ensureSessions = async (dObj) => {
      const created = [];
      for (const [start_time, end_time] of [['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00'], ['16:00', '17:00']]) {
        let s = await prisma.session.findUnique({ where: { session_date_start_time: { session_date: dObj, start_time } } });
        if (!s) {
          s = await prisma.session.create({ data: { session_date: dObj, start_time, end_time, max_capacity: 12 } });
          createdSessionIds.push(s.id);
        } else if (s.closed_at) {
          await prisma.session.update({ where: { id: s.id }, data: { closed_at: null, closed_by: null } });
        }
        created.push(s);
      }
      return created;
    };
    await ensureSessions(selfDate);
    const normalSessions = await ensureSessions(normalDate);

    // Seed normal booking on day+2
    await prisma.reservation.create({
      data: {
        booking_ref: `R48-I2-N-${runId}`,
        session_id: normalSessions[0].id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed',
        is_self_service: false
      }
    });

    const page = await context.newPage();

    // 1. Book tomorrow's self-service using punch card (all-pass -> verified right away)
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    const dayBtn = page.locator(`button[aria-label*="${sM} 月 ${sD} 日"]`).first();
    await dayBtn.waitFor({ state: 'visible', timeout: 10000 });
    await dayBtn.click();
    await page.locator('[data-testid="self-service-info-card"]').waitFor({ state: 'visible', timeout: 8000 });

    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });

    const plusPassBtn = page.locator('button[aria-label*="增加R48不限時五次卡"]').first();
    await plusPassBtn.waitFor({ state: 'visible', timeout: 8000 });
    await plusPassBtn.click();
    await page.locator('[data-testid="self-ack-checkbox"]').check();
    await page.locator('button:has-text("送出預約")').click();
    await page.waitForURL('**/booking?step=done**', { timeout: 12000 });
    await page.locator('text=截圖無效').first().waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await page.locator('button:has-text("查看到店 QR")').count(), 0, 'Self-service done page must NOT have 查看到店 QR');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot4_self_done_no_barcode.png'), fullPage: true });
    console.log('Shot 4 saved: StepDone self-service without barcode button.');

    // 2. Navigate to /history?tab=bookings
    await page.locator('button:has-text("回到我的預約")').click();
    await page.waitForURL('**/history?tab=bookings', { timeout: 10000 });
    await page.locator('text=當天這裡會出現動態進場 QR').first().waitFor({ state: 'visible', timeout: 8000 });

    // Self-service non-today card has NO 出示到店 QR, while normal booking HAS 出示到店 QR
    const normalBtnCount = await page.locator('button:has-text("出示到店 QR")').count();
    assert.equal(normalBtnCount, 1, 'Exactly the 1 normal booking should show 出示到店 QR');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round48_shot5_history_self_qr_note.png'), fullPage: true });
    console.log('Shot 5 saved: HistoryPage self-service QR note + normal barcode button.');
    console.log('Round 48 Item 2 Self-Service QR Text E2E PASSED!');
  } finally {
    await browser.close();
    await cleanOperationalData(prisma);
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (plan) await prisma.passPlan.deleteMany({ where: { id: plan.id } }).catch(() => {});
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

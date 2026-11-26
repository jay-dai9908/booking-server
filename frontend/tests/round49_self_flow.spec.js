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
  console.log('--- Starting Round 49 Item 3 Self-Service Flow E2E ---');
  await ensureFreshDbSeeded(prisma);
  await cleanOperationalData(prisma);

  const runId = Date.now().toString().slice(-6);
  const todayStr = toTaipeiDateString(new Date());
  const tomorrowStr = addDaysYmd(todayStr, 1);
  const todayDate = dateOnly(todayStr);
  const tomorrowDate = dateOnly(tomorrowStr);
  const [, tM, tD] = todayStr.split('-').map(Number);
  const [, tmM, tmD] = tomorrowStr.split('-').map(Number);

  const createdSessionIds = [];
  const createdDates = [todayDate, tomorrowDate];
  let customer = null;
  let passPlan = null;

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });

  try {
    customer = await prisma.user.create({
      data: {
        name: 'R49半自助流暢客',
        phone: `0986${runId}`,
        line_user_id: `r49_i3_self_${runId}`
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
        if (!sessionStorage.getItem('__r49_self_init')) {
          sessionStorage.setItem('__r49_self_init', '1');
          sessionStorage.removeItem('shiguang_booking_draft');
        }
      } catch {}
    }, token);

    passPlan = await prisma.passPlan.create({
      data: {
        code: `r49_i3_plan_${runId}`,
        name: 'R49半自助卡',
        pass_type: 'PUNCH_CARD',
        price: 1500,
        total_quota: 5,
        checkout_effect: 'entry_full',
        day_restriction: 'ALL',
        is_active: true
      }
    });
    await prisma.userPass.create({
      data: {
        pass_code: `PASS-R49I3-${runId}`,
        user_id: customer.id,
        plan_id: passPlan.id,
        plan_name_snapshot: passPlan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 5,
        status: 'ACTIVE',
        payment_status: 'active',
        day_restriction: 'ALL'
      }
    });

    await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } });
    for (const d of createdDates) {
      await prisma.dailySetting.create({
        data: {
          date: d,
          is_self_service: true,
          self_allow_hourly: false,
          self_allow_equipment: false,
          iron_mode: 'today'
        }
      });
    }

    const ensureRange = async (dObj, startH, endH) => {
      for (let h = startH; h < endH; h++) {
        const start_time = `${String(h).padStart(2, '0')}:00`;
        const end_time = `${String(h + 1).padStart(2, '0')}:00`;
        let s = await prisma.session.findUnique({ where: { session_date_start_time: { session_date: dObj, start_time } } });
        if (!s) {
          s = await prisma.session.create({ data: { session_date: dObj, start_time, end_time, max_capacity: 16 } });
          createdSessionIds.push(s.id);
        } else if (s.closed_at) {
          await prisma.session.update({ where: { id: s.id }, data: { closed_at: null, closed_by: null } });
        }
      }
    };
    await prisma.session.deleteMany({
      where: { session_date: tomorrowDate, start_time: { gte: '19:00' } }
    });
    await ensureRange(tomorrowDate, 10, 19);
    await ensureRange(todayDate, 10, 23);

    const page = await context.newPage();

    // 1. Tomorrow (unlimited-only self-service): NO 預計幾點離開？, NO 改用計時; pick 18:00 -> closing 19:00
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${tmM} 月 ${tmD} 日"]`).first().click();
    await page.locator('[data-testid="self-service-info-card"]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("18:00")').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("18:00")').first().click();
    await page.locator('[data-testid="self-unlimited-closing-line"]').waitFor({ state: 'visible', timeout: 5000 });
    const step1Body = await page.locator('body').innerText();
    assert.equal(step1Body.includes('預計幾點離開？'), false, 'Step 1 must NOT ask leave time for selfUnlimitedOnly');
    assert.equal(await page.locator('button:has-text("改用計時")').count(), 0, 'Must NOT render 改用計時 button');
    assert.ok(step1Body.includes('離開時間：玩到打烊 19:00'));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot7_self_step1_closing.png'), fullPage: true });
    console.log('Shot 7 saved: Step 1 fixedToClose self-service without leave selector.');

    // Go to Step 2 -> Step 3 -> check 18:00 到 19:00 and click blocked submit without checking ack
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=2', { timeout: 8000 });
    await page.locator('button:has-text("下一步")').click();
    await page.waitForURL('**/booking?step=3', { timeout: 8000 });
    const step3Body = await page.locator('body').innerText();
    assert.ok(step3Body.includes('18:00 到 19:00'), 'Step 3 must show arrival-to-close range 18:00 到 19:00');

    // Click disabled-looking 送出預約 without checking ack -> toast + scrolled checkbox
    const submitBtn = page.locator('button:has-text("送出預約")');
    assert.equal(await submitBtn.getAttribute('aria-disabled'), 'true');
    await submitBtn.click({ force: true });
    await page.locator('text=請先勾選「我已經會玩拼豆」').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot9_self_blocked_ack.png'), fullPage: false });
    console.log('Shot 9 saved: Step 3 blockedReason ack scroll & toast.');

    // 2. Today self-service (deadline yesterday 12:00 passed) -> Step 1 shows pass-only deadline banner
    await page.evaluate(() => sessionStorage.removeItem('shiguang_booking_draft'));
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label*="${tM} 月 ${tD} 日"]`).first().click();
    const dlBanner = page.locator('[data-testid="step1-self-deadline-banner"]');
    await dlBanner.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok((await dlBanner.innerText()).includes('只能全員用計次不限時卡預約'));
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'round49_shot8_self_deadline_step1.png'), fullPage: true });
    console.log('Shot 8 saved: Step 1 past deadline banner.');

    console.log('Round 49 Item 3 Self-Service Flow E2E PASSED!');
  } finally {
    await browser.close();
    await cleanOperationalData(prisma);
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } }).catch(() => {});
    }
    if (createdDates.length > 0) {
      await prisma.dailySetting.deleteMany({ where: { date: { in: createdDates } } }).catch(() => {});
    }
    if (passPlan) await prisma.passPlan.deleteMany({ where: { id: passPlan.id } }).catch(() => {});
    if (customer) await prisma.user.deleteMany({ where: { id: customer.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

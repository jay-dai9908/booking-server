import { chromium } from 'playwright';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function capture() {
  console.log('--- Capturing Round 20 Screenshots (Mobile 390x844) ---');
  await ensureFreshDbSeeded(prisma);

  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);

  // Ensure clean normal sessions exist for this week so weekly page demonstrates dynamic range:
  // Earliest 09:00, Latest 22:00 -> Dynamic range 08:00 to 23:00
  const dSun = new Date();
  dSun.setDate(dSun.getDate() - dSun.getDay());
  const dSat = new Date(dSun);
  dSat.setDate(dSat.getDate() + 6);

  await prisma.session.deleteMany({
    where: {
      session_date: {
        gte: dateOnly(toTaipeiDateString(dSun)),
        lte: dateOnly(toTaipeiDateString(dSat))
      }
    }
  });

  for (let offset = 0; offset <= 6; offset++) {
    const d = new Date(dSun);
    d.setDate(d.getDate() + offset);
    const dDate = dateOnly(toTaipeiDateString(d));
    await prisma.session.createMany({
      data: [
        { session_date: dDate, start_time: '09:00', end_time: '12:00', max_capacity: 20 },
        { session_date: dDate, start_time: '13:00', end_time: '17:00', max_capacity: 20 },
        { session_date: dDate, start_time: '18:00', end_time: '22:00', max_capacity: 20 }
      ]
    });
  }

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2
    });
    const page = await context.newPage();
    page.on('console', msg => console.log('[PAGE]', msg.type(), msg.text()));

    // 1. Login as admin
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const pwInput = page.locator('input[type="password"]');
    await pwInput.waitFor({ state: 'visible', timeout: 10000 });
    await pwInput.fill(ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(1000);

    // 2. Screenshot 1: Weekly Overview (/admin/weekly)
    console.log('Navigating to /admin/weekly...');
    await page.goto(`${BASE_URL}/admin/weekly`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Verify weekly content loaded
    await page.waitForSelector('text=選擇日期區間', { timeout: 10000 });
    await page.waitForSelector('table', { timeout: 10000 });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: 'screenshot_round20_weekly_mobile.png',
      fullPage: false
    });
    console.log('Saved screenshot_round20_weekly_mobile.png');

    // 3. Screenshot 2: Cash Closing Discrepancy (/admin/accounting)
    console.log('Navigating to /admin/accounting?tab=closing...');
    await page.goto(`${BASE_URL}/admin/accounting?tab=closing`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Enter counted cash that differs from expected
    // Expected cash is float (default 2000) + cash revenue
    const countedInput = page.locator('input[placeholder="請輸入清點金額"]');
    await countedInput.waitFor({ state: 'visible', timeout: 10000 });
    await countedInput.fill('1900'); // shortfall of 100 if float is 2000
    await page.waitForTimeout(600);

    // Verify error text is visible: "有差額，請先填寫備註"
    const hint = page.locator('text=有差額，請先填寫備註');
    await hint.waitFor({ state: 'visible', timeout: 5000 });

    // Verify "完成交班" button is disabled
    const submitBtn = page.locator('button:has-text("完成交班")');
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    const isDisabled = await submitBtn.isDisabled();
    console.log('Closing submit button disabled state:', isDisabled);

    // Scroll the closing card into view so the discrepancy, warning, and disabled button are centered
    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await page.screenshot({
      path: 'screenshot_round20_accounting_closing_difference_mobile.png',
      fullPage: false
    });
    console.log('Saved screenshot_round20_accounting_closing_difference_mobile.png');

    console.log('Both Round 20 screenshots captured successfully!');
  } finally {
    await browser.close();
    await prisma.$disconnect();
  }
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});

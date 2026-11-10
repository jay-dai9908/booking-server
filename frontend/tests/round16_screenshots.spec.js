import { chromium } from 'playwright';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

async function takeScreenshots() {
  console.log('--- Capturing Round 16 Screenshots ---');
  await ensureFreshDbSeeded(prisma);

  // 1. Ensure a default print station exists
  const existingStation = await prisma.printStation.findFirst({
    where: { is_default: true }
  });
  if (existingStation) {
    await prisma.printStation.update({
      where: { id: existingStation.id },
      data: {
        name: '櫃檯商米',
        is_active: true,
        accepting: true,
        last_seen_at: new Date(),
        printer_state: 'ok',
        printer_message: '正常 · 紙張充足'
      }
    });
  } else {
    await prisma.printStation.create({
      data: {
        name: '櫃檯商米',
        secret_hash: 'dummy_hash',
        is_active: true,
        is_default: true,
        accepting: true,
        last_seen_at: new Date(),
        printer_state: 'ok',
        printer_message: '正常 · 紙張充足'
      }
    });
  }

  // 2. Ensure some sample print jobs for queue display
  const runId = Date.now().toString().slice(-4);
  await prisma.printJob.create({
    data: {
      job_no: `P-R16-${runId}-01`,
      title: '收據單 #101',
      type: 'receipt',
      commands_json: [],
      status: 'printed',
      printed_at: new Date(),
      requested_by_name: '門市人員',
      requested_device: '櫃檯平板'
    }
  });

  await prisma.printJob.create({
    data: {
      job_no: `P-R16-${runId}-02`,
      title: '收據單 #102',
      type: 'receipt',
      commands_json: [],
      status: 'failed',
      error_message: '印表機缺紙',
      requested_by_name: '門市人員',
      requested_device: '櫃檯平板'
    }
  });

  // 3. Launch browser at mobile 390x844
  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/admin/login`);
  await page.waitForLoadState('networkidle');
  const pwdInput = page.locator('input[type="password"]');
  if (await pwdInput.isVisible()) {
    await pwdInput.fill(ADMIN_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/admin/sessions');
    await page.waitForLoadState('networkidle');
  }

  // Screenshot 1: Print Station Page (Mobile 390x844 vertical)
  await page.goto(`${BASE_URL}/admin/print-station`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'screenshot_round16_print_station.png' });
  console.log('Saved screenshot_round16_print_station.png');

  // Screenshot 2: Settings Page Payment Methods Block
  await page.goto(`${BASE_URL}/admin/settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  const pmSection = page.locator('[data-testid="payment-methods-list"]');
  await pmSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  // Take screenshot of the payment methods container / card
  const parentCard = page.locator('div:has(> [data-testid="payment-methods-list"])').first();
  if (await parentCard.isVisible()) {
    await parentCard.screenshot({ path: 'screenshot_round16_payment_methods.png' });
  } else {
    await pmSection.screenshot({ path: 'screenshot_round16_payment_methods.png' });
  }
  console.log('Saved screenshot_round16_payment_methods.png');

  await browser.close();
  await prisma.$disconnect();
  console.log('--- Round 16 Screenshots Done ---');
}

takeScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});

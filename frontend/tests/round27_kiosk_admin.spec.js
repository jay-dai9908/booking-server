import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import prisma from '../../backend/src/prismaClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'http://localhost:5173';
const SCREENSHOT_DIR = path.resolve(__dirname, '../../tests/screenshots');
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  console.log('--- Starting Round 27 Admin Kiosk Playwright Test ---');

  const testPass = `spec_pwd_${Date.now()}`;
  const testStaff = await prisma.adminUser.create({
    data: {
      name: 'Kiosk Spec Admin',
      password: testPass,
      role: 'staff',
      permissions: ['settings'],
      is_active: true
    }
  });

  try {
    // Seed dummy slide and firmware so the UI displays populated content
    await prisma.kioskSlide.deleteMany();
    await prisma.kioskSlide.create({
      data: {
        title: '門市特選豆',
        sort_order: 0,
        duration_sec: 10,
        enabled: true,
        sha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        bytes: Buffer.alloc(768000, 0x11)
      }
    });

    await prisma.kioskFirmware.deleteMany();
    const fw = await prisma.kioskFirmware.create({
      data: {
        version: 'v1.0.4',
        size: 1048576,
        sha256: 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
        bytes: Buffer.alloc(1024, 0xe9),
        note: '穩定版本修復掃碼問題',
        uploaded_by: '店長'
      }
    });

    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { fw_target_id: fw.id, fw_policy: 'idle_only' },
      create: { id: 1, fw_target_id: fw.id, fw_policy: 'idle_only' }
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    const page = await context.newPage();

    console.log('Navigating admin to /admin/login...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(testPass);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    await page.waitForTimeout(500);

    console.log('Navigating admin to /admin/kiosk...');
    await page.goto(`${BASE_URL}/admin/kiosk`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);

    // Verify Carousel Section
    const carouselSec = page.locator('[data-testid="kiosk-carousel-section"]');
    await carouselSec.waitFor({ state: 'visible', timeout: 8000 });
    console.log('Found [data-testid="kiosk-carousel-section"]');

    // Verify Firmware Section
    const fwSec = page.locator('[data-testid="kiosk-firmware-section"]');
    await fwSec.waitFor({ state: 'visible', timeout: 8000 });
    console.log('Found [data-testid="kiosk-firmware-section"]');

    // Verify Alerts Section
    const alertSec = page.locator('[data-testid="kiosk-alerts-section"]');
    await alertSec.waitFor({ state: 'visible', timeout: 8000 });
    console.log('Found [data-testid="kiosk-alerts-section"]');

    // Screenshot 4: Desktop view of Admin Kiosk page
    const shot4 = path.join(SCREENSHOT_DIR, 'round27_shot4_admin_kiosk.png');
    await page.screenshot({ path: shot4, fullPage: true });
    console.log(`Saved Screenshot 4 (Admin Kiosk Carousel, OTA, Alerts): ${shot4}`);

    await browser.close();
    console.log('✅ Round 27 Admin Kiosk Playwright Test PASSED successfully!');
  } finally {
    await prisma.adminUser.delete({ where: { id: testStaff.id } }).catch(() => {});
  }
}

run().catch((err) => {
  console.error('❌ Round 27 Admin Kiosk Playwright Test Failed:', err);
  process.exit(1);
});

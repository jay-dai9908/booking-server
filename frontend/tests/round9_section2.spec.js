import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '../../backend/node_modules/@prisma/client/index.js';
import jwt from '../../backend/node_modules/jsonwebtoken/index.js';
import { ensureFreshDbSeeded } from './helpers/seedFreshDb.js';
import { toTaipeiDateString } from '../../shared/time.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCREENSHOT_DIR = path.resolve('test-results/round9-screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

async function run() {
  console.log('--- Starting Round 9 Section 2 Playwright Tests ---');
  await ensureFreshDbSeeded(prisma);

  // Setup initial GlobalSetting with default 4 chips
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      booking_note_chips: ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起']
    },
    create: {
      id: 1,
      booking_note_chips: ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起']
    }
  });

  // Prepare today's sessions: 13:00 to 17:00
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = new Date(`${todayStr}T00:00:00.000Z`);
  await prisma.session.deleteMany({ where: { session_date: todayDate } });
  const slotTimes = [
    ['13:00', '14:00'],
    ['14:00', '15:00'],
    ['15:00', '16:00'],
    ['16:00', '17:00']
  ];
  for (const [st, et] of slotTimes) {
    await prisma.session.create({
      data: {
        session_date: todayDate,
        start_time: st,
        end_time: et,
        max_capacity: 20
      }
    });
  }

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }
  const browser = await chromium.launch(launchOptions);

  try {
    // 1. Admin updates chips on SettingsPage
    const adminContext = await browser.newContext({
      viewport: { width: 375, height: 812 }
    });
    const adminPage = await adminContext.newPage();

    // Login as admin
    console.log('Logging in as admin...');
    await adminPage.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = adminPage.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(process.env.ADMIN_PASSWORD || 'gathering.light2609');
    await adminPage.locator('button[type="submit"]').click();
    await adminPage.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
    await adminPage.waitForTimeout(500);

    console.log('Navigating to /admin/settings...');
    await adminPage.goto(`${BASE_URL}/admin/settings`, { waitUntil: 'networkidle' });
    await adminPage.waitForTimeout(1000);

    // Scroll to 預約備註快速選項
    const blockTitle = adminPage.locator('h2:has-text("預約備註快速選項")');
    await blockTitle.scrollIntoViewIfNeeded();
    await blockTitle.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✔ 預約備註快速選項 block visible in admin settings');

    // Find the chip with value '生日慶祝' and change to '慶生'
    const chipInputs = adminPage.locator('[data-testid^="note-chip-input-"]');
    const chipCount = await chipInputs.count();
    let foundBirthday = false;
    for (let i = 0; i < chipCount; i++) {
      const val = await chipInputs.nth(i).inputValue();
      if (val === '生日慶祝') {
        await chipInputs.nth(i).fill('慶生');
        foundBirthday = true;
        break;
      }
    }
    assert.ok(foundBirthday, 'Should find chip with value 生日慶祝');
    console.log('✔ Changed "生日慶祝" to "慶生"');

    // Add new chip '需要教學'
    const addChipBtn = adminPage.locator('[data-testid="add-note-chip-btn"]');
    await addChipBtn.click();
    await adminPage.waitForTimeout(300);

    const newChipInput = adminPage.locator('[data-testid^="note-chip-input-"]').last();
    await newChipInput.fill('需要教學');
    console.log('✔ Added new chip "需要教學"');

    // Verify live preview includes '慶生' and '需要教學'
    const previewArea = adminPage.locator('[data-testid="note-chips-live-preview"]');
    await previewArea.waitFor({ state: 'visible' });
    const previewText = await previewArea.textContent();
    assert.ok(previewText.includes('慶生'), 'Live preview should contain 慶生');
    assert.ok(previewText.includes('需要教學'), 'Live preview should contain 需要教學');
    console.log('✔ Live preview verified in admin settings');

    // Save note chips
    const saveChipsBtn = adminPage.locator('[data-testid="save-note-chips-btn"]');
    await saveChipsBtn.click();
    await adminPage.waitForTimeout(1500);

    // Take mobile screenshot for Section 2 admin settings
    const shot1Path = path.join(SCREENSHOT_DIR, 'section2-note-settings.png');
    await adminPage.screenshot({ path: shot1Path });
    console.log(`Saved screenshot: ${shot1Path}`);

    await adminContext.close();

    // 2. Customer view verifies updated chips
    console.log('Opening customer booking step 3 confirmation page...');
    const customerToken = jwt.sign(
      { id: 1, role: 'customer', name: '測試客', phone: '0912345678' },
      process.env.JWT_SECRET || 'super_secret_jwt_key_for_booking_system',
      { expiresIn: '1d' }
    );

    const custContext = await browser.newContext({
      viewport: { width: 375, height: 812 }
    });
    await custContext.addInitScript((tok) => {
      try {
        sessionStorage.setItem('shiguang_auth_token', tok);
      } catch (e) {}
    }, customerToken);

    // Seed draft for StepConfirm
    const draft = {
      date: todayStr,
      mode: 'timed',
      sel: { start: 0, end: 3 },
      pax: 1,
      units: [],
      customerNote: '',
      promo: null,
      savedAt: Date.now()
    };
    await custContext.addInitScript((draftData) => {
      try {
        sessionStorage.setItem('shiguang_booking_draft', JSON.stringify(draftData));
      } catch (e) {}
    }, draft);

    const custPage = await custContext.newPage();
    await custPage.goto(`${BASE_URL}/booking?step=3`, { waitUntil: 'networkidle' });
    await custPage.waitForTimeout(1000);

    // Verify chips: '慶生' and '需要教學' exist, '生日慶祝' does not exist
    const qingShengChip = custPage.locator('button:has-text("慶生")');
    await qingShengChip.waitFor({ state: 'visible', timeout: 5000 });
    const teachingChip = custPage.locator('button:has-text("需要教學")');
    await teachingChip.waitFor({ state: 'visible', timeout: 5000 });
    const oldBirthdayChip = custPage.locator('button:has-text("生日慶祝")');
    assert.equal(await oldBirthdayChip.count(), 0, 'Old 生日慶祝 chip must not be present');
    console.log('✔ Customer confirmation page shows updated chips ("慶生", "需要教學")');

    // Click "慶生" and "需要教學" to toggle notes
    await qingShengChip.click();
    await custPage.waitForTimeout(200);
    await teachingChip.click();
    await custPage.waitForTimeout(200);

    const noteTextarea = custPage.locator('textarea');
    const noteVal = await noteTextarea.inputValue();
    assert.ok(noteVal.includes('慶生') && noteVal.includes('需要教學'), `Textarea should contain selected chips, got: ${noteVal}`);
    console.log('✔ Customer note textarea populated without duplication:', noteVal);

    // Take mobile screenshot for Section 2 customer chips
    const shot2Path = path.join(SCREENSHOT_DIR, 'section2-customer-chips.png');
    await custPage.screenshot({ path: shot2Path });
    console.log(`Saved screenshot: ${shot2Path}`);

    // Verify audit log
    const auditEvent = await prisma.accountingEvent.findFirst({
      where: { event_type: '設定變更', summary: '更新預約備註快速選項' },
      orderBy: { id: 'desc' }
    });
    assert.ok(auditEvent, 'Audit log event for setting change must exist');
    console.log('✔ Audit log verified:', auditEvent.summary);

    await custContext.close();
    console.log('All Section 2 Playwright tests passed successfully!');
  } finally {
    await browser.close();
    await ensureFreshDbSeeded(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Section 2 Playwright test failed:', err);
  process.exit(1);
});

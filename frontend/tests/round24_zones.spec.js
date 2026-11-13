import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureFreshDbSeeded, cleanOperationalData } from './helpers/seedFreshDb.js';
import { toTaipeiDateString, dateOnly } from '../../shared/time.js';

const require = createRequire(import.meta.url);
const testDbUrl = process.env.TEST_DATABASE_URL || 'postgresql://user:password@localhost:5432/booking_db_test?schema=public';
let PrismaClient;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch {
  ({ PrismaClient } = require('../../backend/node_modules/@prisma/client/index.js'));
}
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD?.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const ARTIFACT_DIR = 'C:\\Users\\jayda\\.gemini\\antigravity\\brain\\0fafdb18-5ae0-4501-b130-c9f498355dd3';

async function run() {
  console.log('--- Starting Round 24 Zones Playwright Test ---');
  await ensureFreshDbSeeded(prisma);

  const todayDate = dateOnly(toTaipeiDateString(new Date()));
  const ts = Date.now();
  const layoutPrefix = `R24-Zones-${ts}`;

  const priorLayouts = await prisma.seatLayout.findMany({
    select: { id: true, status: true }
  });
  const createdLayoutIds = [];

  try {
    // Archive existing active/draft layouts so only our test layout loads
    await prisma.seatLayout.updateMany({
      where: { status: { in: ['draft', 'published'] } },
      data: { status: 'archived' }
    });

    const seedLayout = await prisma.seatLayout.create({
      data: {
        name: layoutPrefix,
        status: 'published',
        effective_from: todayDate,
        canvas_w: 1000,
        canvas_h: 625,
        capacity: 12
      }
    });
    createdLayoutIds.push(seedLayout.id);

    const zoneA = await prisma.seatZone.create({
      data: { layout_id: seedLayout.id, name: 'A 區', sort_order: 0 }
    });
    const zoneB = await prisma.seatZone.create({
      data: { layout_id: seedLayout.id, name: 'B 區', sort_order: 1 }
    });

    const t1 = await prisma.seatTable.create({
      data: { layout_id: seedLayout.id, zone_id: zoneA.id, label: '桌 1', shape: 'rect', arrangement: 'two_sides', cx: 180, cy: 200, w: 70, h: 140, rotation: 0, sort_order: 0 }
    });
    const t2 = await prisma.seatTable.create({
      data: { layout_id: seedLayout.id, zone_id: zoneB.id, label: '桌 2', shape: 'rect', arrangement: 'two_sides', cx: 380, cy: 200, w: 70, h: 140, rotation: 0, sort_order: 1 }
    });
    const t3 = await prisma.seatTable.create({
      data: { layout_id: seedLayout.id, zone_id: zoneB.id, label: '桌 3', shape: 'rect', arrangement: 'two_sides', cx: 580, cy: 200, w: 70, h: 140, rotation: 0, sort_order: 2 }
    });

    const seatSpecs = [
      { table: t1, zoneId: zoneA.id, num: 1 },
      { table: t2, zoneId: zoneB.id, num: 2 },
      { table: t3, zoneId: zoneB.id, num: 3 }
    ];
    let sortIdx = 0;
    for (const { table, zoneId, num } of seatSpecs) {
      const coords = [[-45, -35], [-45, 35], [45, -35], [45, 35]];
      for (let i = 0; i < coords.length; i++) {
        await prisma.seat.create({
          data: {
            layout_id: seedLayout.id,
            table_id: table.id,
            zone_id: zoneId,
            code: `${num}-${i + 1}`,
            lx: coords[i][0],
            ly: coords[i][1],
            side_mode: 'auto',
            priority: 'normal',
            is_active: true,
            sort_order: sortIdx++
          }
        });
      }
    }

    const launchOptions = { headless: HEADLESS };
    if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
    }
    const browser = await chromium.launch(launchOptions);

    try {
      const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
      const page = await context.newPage();

      await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
      await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 10000 });
      await page.waitForTimeout(500);

      await page.goto(`${BASE_URL}/admin/seat-layout`, { waitUntil: 'networkidle' });
      await page.locator('[data-testid="seat-layout-svg"]').waitFor({ state: 'visible', timeout: 10000 });

      // Switch to 排位規則與試算 tab -> Add "C 區"
      await page.locator('[data-testid="tab-rules"]').click();
      await page.locator('[data-testid="zone-order-list"]').waitFor({ state: 'visible', timeout: 5000 });

      await page.locator('[data-testid="add-zone-btn"]').click();
      const newZoneInput = page.locator('[data-testid="new-zone-name-input"]');
      await newZoneInput.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await newZoneInput.inputValue(), 'C 區', 'Default next zone name should be C 區');

      await page.waitForTimeout(200);
      const shot1 = path.join(ARTIFACT_DIR, 'round24_zone_adding_desktop.png');
      await page.screenshot({ path: shot1 });
      console.log(`Saved Screenshot 1: ${shot1}`);

      await page.locator('[data-testid="confirm-add-zone-btn"]').click();
      await page.locator('[data-testid="zone-row-C 區"]').waitFor({ state: 'visible', timeout: 5000 });

      // Verify generic 3+ zone wording
      await page.locator('text=前面的區域每桌都有人之後，先用下一區的空桌，最後才排對面').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('text=前面的區域坐滿才排下一區').waitFor({ state: 'visible', timeout: 5000 });

      // Switch back to 平面圖畫布 -> verify toolbar target zone selector shows C 區, and move 桌 3 to C 區
      await page.locator('[data-testid="tab-editor"]').click();
      await page.locator('[data-testid="seat-layout-svg"]').waitFor({ state: 'visible', timeout: 5000 });

      const toolbarZoneOptions = await page.locator('[data-testid="new-table-zone-select"] option').allTextContents();
      assert.ok(toolbarZoneOptions.includes('C 區'), 'Toolbar zone selector should include C 區');

      const table3Node = page.locator('[data-testid="table-node-桌 3"]');
      await table3Node.waitFor({ state: 'visible', timeout: 5000 });
      await table3Node.dispatchEvent('pointerdown', { bubbles: true, button: 0 });
      await page.locator('[data-testid="table-zone-select"]').waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('[data-testid="table-zone-select"]').selectOption({ label: 'C 區' });

      // Save draft
      const [draftCreateOrSave] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/seat-layouts/') && r.request().method() === 'PUT'),
        page.locator('[data-testid="save-draft-btn"]').click()
      ]);
      assert.equal(draftCreateOrSave.status(), 200, 'Save draft should return 200');
      const draftBody = await draftCreateOrSave.json();
      if (draftBody?.layout?.id) createdLayoutIds.push(draftBody.layout.id);

      // Publish
      await page.getByRole('button', { name: '發布生效' }).click();
      await page.getByRole('button', { name: '發布並套用新座位' }).waitFor({ state: 'visible', timeout: 5000 });
      const [pubResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/publish') && r.request().method() === 'POST'),
        page.getByRole('button', { name: '發布並套用新座位' }).click()
      ]);
      assert.equal(pubResp.status(), 200, 'Publish should return 200');
      await page.waitForTimeout(300);

      // Switch to 排位規則與試算 -> verify C 區 · 1 張 4 人桌 & take Screenshot 2
      await page.locator('[data-testid="tab-rules"]').click();
      const rowC = page.locator('[data-testid="zone-row-C 區"]');
      await rowC.waitFor({ state: 'visible', timeout: 5000 });
      const rowCText = await rowC.innerText();
      assert.ok(rowCText.includes('1 張 4 人桌'), `Expected C 區 to show 1 張 4 人桌, got: ${rowCText}`);

      await page.waitForTimeout(250);
      const shot2 = path.join(ARTIFACT_DIR, 'round24_zone_order_published_desktop.png');
      await page.screenshot({ path: shot2 });
      console.log(`Saved Screenshot 2: ${shot2}`);

      // Reorder: move C 區 up (from index 2 -> 1) and click 儲存排位規則
      await rowC.locator('button[title="上移"]').click();
      await page.waitForTimeout(200);
      const [rulesResp] = await Promise.all([
        page.waitForResponse(r => r.url().includes('/rules') && r.request().method() === 'PUT'),
        page.locator('[data-testid="save-rules-btn"]').click()
      ]);
      assert.equal(rulesResp.status(), 200, 'Save rules should return 200');
      await page.waitForTimeout(300);

      // Reload page and verify tables & zone order persisted
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('[data-testid="seat-layout-svg"]').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-testid="tab-rules"]').click();
      await page.locator('[data-testid="zone-order-list"]').waitFor({ state: 'visible', timeout: 5000 });

      const zoneRows = page.locator('[data-testid^="zone-row-"]');
      assert.equal(await zoneRows.count(), 3, 'Should still have 3 zones after reload');
      assert.ok((await zoneRows.nth(0).innerText()).includes('A 區'));
      assert.ok((await zoneRows.nth(0).innerText()).includes('1 張 4 人桌'));
      assert.ok((await zoneRows.nth(1).innerText()).includes('C 區'));
      assert.ok((await zoneRows.nth(1).innerText()).includes('1 張 4 人桌'));
      assert.ok((await zoneRows.nth(2).innerText()).includes('B 區'));
      assert.ok((await zoneRows.nth(2).innerText()).includes('1 張 4 人桌'));

      console.log('--- Round 24 Zones Playwright Test Passed! ---');
    } finally {
      await browser.close();
    }
  } finally {
    const uniqueCreatedIds = [...new Set(createdLayoutIds)];
    if (uniqueCreatedIds.length > 0) {
      await prisma.seat.deleteMany({ where: { layout_id: { in: uniqueCreatedIds } } });
      await prisma.seatTable.deleteMany({ where: { layout_id: { in: uniqueCreatedIds } } });
      await prisma.seatZone.deleteMany({ where: { layout_id: { in: uniqueCreatedIds } } });
      await prisma.seatLayout.deleteMany({ where: { id: { in: uniqueCreatedIds } } });
    }
    for (const prev of priorLayouts) {
      await prisma.seatLayout.update({
        where: { id: prev.id },
        data: { status: prev.status }
      }).catch(() => {});
    }
    await cleanOperationalData(prisma);
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Round 24 Playwright Test Failed:', err);
  process.exit(1);
});

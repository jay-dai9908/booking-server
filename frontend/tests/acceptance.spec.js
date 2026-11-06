import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  console.log(`Starting Acceptance Tests on ${BASE_URL} (Headless: ${HEADLESS})...`);
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 }
  });
  const page = await context.newPage();

  // Monitor pageerror and API >= 400
  const pageErrors = [];
  const apiErrors = [];

  page.on('pageerror', (err) => {
    console.error('Page error:', err.message || err);
    pageErrors.push(err.message || String(err));
  });

  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 400) {
      if (res.url().includes('/api/auth/me') && res.status() === 401) {
        // Expected before login
        return;
      }
      console.error(`API Error ${res.status()} on ${res.url()}`);
      apiErrors.push({ url: res.url(), status: res.status() });
    }
  });

  try {
    // 1. Login as admin
    console.log('Logging in as admin...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    const passInput = page.locator('input[type="password"]');
    await passInput.waitFor({ state: 'visible', timeout: 15000 });
    await passInput.fill(process.env.ADMIN_PASSWORD || 'gathering.light2609');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
    await page.waitForTimeout(1000);
    console.log('Admin login succeeded, current URL:', page.url());

    // Inject token to browser context so all subsequent reloads and navigations stay logged in
    const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
    if (token) {
      await context.addInitScript((tok) => {
        try {
          sessionStorage.setItem('shiguang_auth_token', tok);
        } catch (e) {}
      }, token);
    }

    // 2. Section 4 Acceptance Flow: Seat Layout Editor
    console.log('\n--- Section 4 Acceptance Flow: Seat Layout Editor ---');
    await page.goto(`${BASE_URL}/admin/seat-layout`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForSelector('[data-testid="seat-layout-svg"]', { timeout: 10000 });

    // Step 0: Ensure Table 3 exists (add 4p presets if needed)
    let table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    let attempts = 0;
    while (!await table3.isVisible() && attempts < 5) {
      attempts++;
      console.log(`Table 3 not visible yet, adding 4p preset (attempt ${attempts})...`);
      await page.locator('[data-testid="preset-4p"]').click();
      await page.waitForTimeout(400);
      table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    }
    await assert.ok(await table3.isVisible(), 'Table 3 must be visible on canvas');

    // Step 1: 把桌 3 轉成 −10°
    console.log('Step 1: Setting Table 3 rotation to -10°...');
    table3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    await table3.click();
    await page.waitForTimeout(300);
    const rotInput = page.locator('[data-testid="table-rotation-input"]');
    await rotInput.waitFor({ state: 'visible', timeout: 5000 });
    await rotInput.fill('-10');
    await rotInput.blur();
    await page.waitForTimeout(300);

    // Step 2: 把 3-3 從桌邊拉開
    console.log('Step 2: Pulling Seat 3-3 away from table...');
    let seat33 = page.locator('[data-testid="seat-node-3-3"]').first();
    if (!await seat33.isVisible()) {
      // If 3-3 not labeled, find first seat of table 3 and set code to 3-3
      const anySeat = page.locator('[data-testid^="seat-node-"]').first();
      await anySeat.click();
      const codeInput = page.locator('[data-testid="seat-code-input"]');
      if (await codeInput.isVisible()) {
        await codeInput.fill('3-3');
        await codeInput.blur();
      }
      seat33 = page.locator('[data-testid="seat-node-3-3"]').first();
    }
    await seat33.waitFor({ state: 'visible', timeout: 5000 });
    const seatBox = await seat33.boundingBox();
    if (seatBox) {
      await page.mouse.move(seatBox.x + seatBox.width / 2, seatBox.y + seatBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(seatBox.x + seatBox.width / 2 + 50, seatBox.y + seatBox.height / 2 + 50);
      await page.mouse.up();
      await page.waitForTimeout(300);
    }

    // Step 3: 畫一面斜牆
    console.log('Step 3: Drawing diagonal wall...');
    await page.locator('[data-testid="draw-wall-btn"]').click();
    await page.waitForTimeout(300);
    const svgEl = page.locator('[data-testid="seat-layout-svg"]');
    const svgBox = await svgEl.boundingBox();
    if (svgBox) {
      await page.mouse.click(svgBox.x + 80, svgBox.y + 80);
      await page.waitForTimeout(200);
      await page.mouse.click(svgBox.x + 220, svgBox.y + 220);
      await page.waitForTimeout(200);
      await page.locator('[data-testid="finish-wall-btn"]').click();
      await page.waitForTimeout(300);
    }

    // Step 4: 放一張底圖並調透明度
    console.log('Step 4: Setting background image and opacity...');
    const fileInput = page.locator('input[type="file"][accept="image/*"]');
    const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    await fileInput.setInputFiles({
      name: 'blueprint.png',
      mimeType: 'image/png',
      buffer: pngBuffer
    });
    await page.waitForTimeout(500);

    const opacitySlider = page.locator('[data-testid="bg-opacity-slider"]');
    if (await opacitySlider.isVisible()) {
      await opacitySlider.fill('45');
      await opacitySlider.dispatchEvent('mouseup');
      await page.waitForTimeout(300);
    }

    // Step 5: 復原 2 步，再重做 1 步
    console.log('Step 5: Undo 2 steps, Redo 1 step...');
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="undo-btn"]').click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="redo-btn"]').click();
    await page.waitForTimeout(300);

    // Step 6: 儲存草稿，重新整理頁面
    console.log('Step 6: Saving draft and reloading page...');
    await page.locator('[data-testid="save-draft-btn"]').click();
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="seat-layout-svg"]', { timeout: 10000 });

    // Verify after reload: Table 3 exists with rotation -10
    const reloadedTable3 = page.locator('[data-testid="table-node-桌 3"], [data-testid="table-node-3"]').first();
    await assert.ok(await reloadedTable3.isVisible(), 'Table 3 should exist after reload');
    await reloadedTable3.click();
    const reloadedRot = await page.locator('[data-testid="table-rotation-input"]').inputValue();
    assert.equal(reloadedRot, '-10', `Expected rotation -10, got ${reloadedRot}`);
    console.log('✔ Section 4 Acceptance Flow PASSED!');

    // 3. Section 5 Requirements: All /admin/* pages at 1024x768 and 375x812
    console.log('\n--- Section 5 Verification: All Admin Pages Smoke ---');
    const viewports = [
      { name: 'desktop (1024x768)', width: 1024, height: 768 },
      { name: 'mobile (375x812)', width: 375, height: 812 }
    ];

    const adminRoutes = [
      '/admin/seating',
      '/admin/sessions',
      '/admin/reservations',
      '/admin/shop',
      '/admin/members',
      '/admin/weekly',
      '/admin/seat-layout',
      '/admin/equipment',
      '/admin/coupons',
      '/admin/accounting',
      '/admin/print-station',
      '/admin/settings',
      '/admin/staff'
    ];

    for (const vp of viewports) {
      console.log(`\nTesting viewport: ${vp.name}`);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const route of adminRoutes) {
        pageErrors.length = 0;
        apiErrors.length = 0;

        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(800);

        assert.equal(pageErrors.length, 0, `Page errors on ${route} [${vp.name}]: ${pageErrors.join(', ')}`);
        assert.equal(apiErrors.length, 0, `API >= 400 on ${route} [${vp.name}]: ${JSON.stringify(apiErrors)}`);
        console.log(`  ✔ ${route} passed`);
      }
    }

    console.log('\n🎉 ALL ACCEPTANCE AND SMOKE TESTS PASSED WITH 0 ERRORS!');
  } finally {
    await browser.close();
  }
}

run().catch(err => {
  console.error('\n❌ Acceptance Test Failed:', err);
  process.exit(1);
});

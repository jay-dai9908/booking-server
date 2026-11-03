/**
 * Customer End-to-End Smoke Test (Playwright)
 *
 * Requirements:
 * - Playwright (installed via `npm install --save-dev playwright` or `npx playwright install`)
 *
 * Environment Variables:
 * - BASE_URL: The URL of the customer frontend.
 *             Default: 'http://localhost:5173'
 * - HEADLESS: 'true' (default) or 'false' to run browser in visible mode.
 * - PLAYWRIGHT_CHANNEL: Browser channel to use, e.g. 'chrome', 'msedge'. Default: auto.
 *
 * Usage:
 *   node frontend/scripts/smoke-customer.mjs
 *   BASE_URL=http://localhost:5173 HEADLESS=false node frontend/scripts/smoke-customer.mjs
 */

import { chromium } from 'playwright';
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendDir = path.resolve(__dirname, '..');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';
const PLAYWRIGHT_CHANNEL = process.env.PLAYWRIGHT_CHANNEL || undefined;

// Helper to check if a server is responding
function checkServer(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = http.request(
        {
          hostname: u.hostname,
          port: u.port || 80,
          path: u.pathname,
          method: 'GET',
          timeout: 1000,
        },
        (res) => {
          resolve(true);
        }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

// Generate today & upcoming date strings
function getDates() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;

  // Next weekday
  const nextDay = new Date(now);
  nextDay.setDate(nextDay.getDate() + 1);
  const ny = nextDay.getFullYear();
  const nm = String(nextDay.getMonth() + 1).padStart(2, '0');
  const nd = String(nextDay.getDate()).padStart(2, '0');
  const tomorrowStr = `${ny}-${nm}-${nd}`;

  return { todayStr, tomorrowStr, year: y, month: m };
}

function getUpcomingDates() {
  const now = new Date();
  let weekdayDate = null;
  let saturdayDate = null;

  // Offset starts at 1 so selected dates are in the future (not subject to "past" slot disabling for afternoon/evening test runs)
  for (let offset = 1; offset < 20; offset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const day = d.getDay(); // 0 is Sun, 6 is Sat
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dayNum = String(d.getDate()).padStart(2, '0');
    const dateStr = `${y}-${m}-${dayNum}`;

    if (!weekdayDate && day >= 1 && day <= 5) {
      weekdayDate = dateStr;
    }
    if (!saturdayDate && day === 6) {
      saturdayDate = dateStr;
    }
    if (weekdayDate && saturdayDate) break;
  }
  return { weekdayDate, saturdayDate };
}

const { todayStr, tomorrowStr, year, month } = getDates();

// Standard Mock Data for customer smoke tests
const MOCK_GLOBAL_SETTINGS = {
  id: 1,
  weekday_hourly_price: 100,
  weekday_unlimited_price: 550,
  weekend_hourly_price: 150,
  weekend_unlimited_price: 800,
  equipment_discount_enabled: true,
  equipment_discount_buy_hours: 2,
  equipment_discount_free_hours: 1,
  equipment_discount_stackable: true,
  shop_enabled: true,
  shop_enable_shipping: true,
  shop_shipping_fee: 60,
  official_line_url: 'https://lin.ee/vsZhRW5',
};

const MOCK_EQUIPMENTS = [
  {
    id: 'pegboard_s',
    name: '小板 (52×52)',
    hourly_rate: 100,
    daily_cap: 500,
    total_stock: 5,
    min_contiguous_hours: 2,
    available_qty: 5,
    available_by_session: {
      '12:00': 5,
      '13:00': 5,
      '14:00': 5,
      '15:00': 5,
      '16:00': 5,
      '17:00': 5,
      '18:00': 5,
    },
  },
  {
    id: 'pegboard_m',
    name: '中板 (78×78)',
    hourly_rate: 120,
    daily_cap: 600,
    total_stock: 2,
    min_contiguous_hours: 2,
    available_qty: 2,
    available_by_session: {
      '12:00': 2,
      '13:00': 2,
      '14:00': 2,
      '15:00': 2,
      '16:00': 2,
      '17:00': 2,
      '18:00': 2,
    },
  },
  {
    id: 'pegboard_l',
    name: '大板 (104×104)',
    hourly_rate: 140,
    daily_cap: 700,
    total_stock: 3,
    min_contiguous_hours: 2,
    available_qty: 3,
    available_by_session: {
      '12:00': 3,
      '13:00': 3,
      '14:00': 3,
      '15:00': 3,
      '16:00': 3,
      '17:00': 3,
      '18:00': 3,
    },
  },
];

function generateSessions(dateStr) {
  const hours = [
    ['12:00', '13:00'],
    ['13:00', '14:00'],
    ['14:00', '15:00'],
    ['15:00', '16:00'],
    ['16:00', '17:00'],
    ['17:00', '18:00'],
    ['18:00', '19:00'],
    ['19:00', '20:00'],
    ['20:00', '21:00'],
  ];
  return hours.map(([s, e], idx) => ({
    id: idx + 1,
    session_date: `${dateStr}T00:00:00.000Z`, // ISO format to verify parsing
    start_time: s,
    end_time: e,
    max_capacity: 10,
    remaining_capacity: 8,
  }));
}

async function setupMocks(page, interceptedBookings, authState = { isAuthenticated: false }) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;
    const method = req.method();

    if (pathname.includes('/auth/me')) {
      if (authState.isAuthenticated) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 1,
            role: 'customer',
            name: '測試顧客',
            phone: '0912345678',
            email: 'test@example.com',
          }),
        });
      }
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not authenticated' }),
      });
    }

    if (pathname.includes('/global-settings') || pathname.includes('/daily-settings/global')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_GLOBAL_SETTINGS),
      });
    }

    if (pathname.includes('/sessions')) {
      const qDate = url.searchParams.get('date');
      const startDate = url.searchParams.get('start_date');
      const endDate = url.searchParams.get('end_date');

      if (qDate) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(generateSessions(qDate)),
        });
      }

      if (startDate && endDate) {
        const result = [];
        const [sy, sm, sd] = startDate.split('-').map(Number);
        const [ey, em, ed] = endDate.split('-').map(Number);
        const cur = new Date(sy, sm - 1, sd);
        const end = new Date(ey, em - 1, ed);
        while (cur <= end) {
          const y = cur.getFullYear();
          const m = String(cur.getMonth() + 1).padStart(2, '0');
          const d = String(cur.getDate()).padStart(2, '0');
          const dStr = `${y}-${m}-${d}`;
          result.push(...generateSessions(dStr));
          cur.setDate(cur.getDate() + 1);
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(result),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(generateSessions(todayStr)),
      });
    }

    if (pathname.includes('/equipment/availability')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          equipments: MOCK_EQUIPMENTS,
          allow_exceed_pax: false,
          show_equipment_live_stock: true,
          equipment_discount_enabled: true,
          equipment_discount_buy_hours: 2,
          equipment_discount_free_hours: 1,
          equipment_discount_stackable: true,
        }),
      });
    }

    if (pathname.includes('/reservations') && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      interceptedBookings.push(body);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          booking: {
            booking_ref: 'BK-TEST-1234',
            session_date: body.session_date,
            start_time: '12:00',
            end_time: '18:00',
            pax: body.pax,
            total_amount: 1460,
            equipments: body.equipments || [],
          },
        }),
      });
    }

    if (pathname.includes('/reservations')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    if (pathname.includes('/passes/my')) {
      // 1-9 fix verification: must return 200 OK
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    if (pathname.includes('/shop/products')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 1,
            name: '全配工具組 (限量預購)',
            category: 'bundle',
            price: 1200,
            deposit_amount: 500,
            allow_wish_input: true,
          },
          {
            id: 2,
            name: 'MARD 融合豆（單包）',
            category: 'beads',
            price: 60,
            tier_discount_mode: 'per_color',
          },
          {
            id: 3,
            name: '3D 列印筆',
            category: 'tools_3d',
            price: 450,
          },
        ]),
      });
    }

    if (pathname.includes('/shop/payment-methods')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          payment_methods: [
            {
              code: 'ctbc_pool',
              name: '中信專屬轉帳帳號',
              is_enabled: true,
            },
            {
              code: 'bank_transfer',
              name: '一般銀行匯款',
              is_enabled: true,
              bank_accounts_json: [
                { bank_name: '國泰世華', bank_code: '013', account: '123456789' },
                { bank_name: '台新銀行', bank_code: '812', account: '987654321' },
              ],
            },
          ],
          ctbc_pool_available_count: 5,
          enable_shipping: true,
          shipping_fee: 60,
        }),
      });
    }

    if (pathname.includes('/shop/my-orders')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    return route.continue();
  });
}

async function run() {
  console.log('=== Starting Customer Redesign Smoke Tests ===');

  let previewProcess = null;
  const isServerRunning = await checkServer(BASE_URL);
  if (!isServerRunning) {
    console.log(`Server at ${BASE_URL} not detected. Spawning 'npm run preview' on port 5173...`);
    previewProcess = spawn('npx', ['vite', 'preview', '--port', '5173'], {
      cwd: frontendDir,
      shell: true,
      stdio: 'pipe',
    });

    let started = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkServer(BASE_URL)) {
        started = true;
        break;
      }
    }
    if (!started) {
      throw new Error(`Failed to start preview server on ${BASE_URL}`);
    }
    console.log(`Preview server started at ${BASE_URL}`);
  }

  const launchOpts = {
    headless: HEADLESS,
  };
  if (PLAYWRIGHT_CHANNEL) {
    launchOpts.channel = PLAYWRIGHT_CHANNEL;
  }

  let browser;
  try {
    browser = await chromium.launch(launchOpts);
  } catch (err) {
    console.log(`Launching default chromium failed (${err.message}). Trying chrome channel...`);
    browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
  }

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // Mobile 390x844 specification
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  const page = await context.newPage();
  const interceptedBookings = [];
  const authState = { isAuthenticated: false };
  await setupMocks(page, interceptedBookings, authState);

  const errors = [];
  page.on('pageerror', (err) => {
    errors.push(`[PageError] ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore 401 on /auth/me or unauthenticated resource fetch
      if (text.includes('401')) return;
      errors.push(`[ConsoleError] ${text}`);
    }
  });

  try {
    // -------------------------------------------------------------
    // PART 1: Health check on 8 customer pages (no crashes/errors)
    // -------------------------------------------------------------
    console.log('\n--- Part 1: Checking all 8 customer pages for errors ---');
    const routesToCheck = [
      '/',
      '/preview',
      '/register',
      '/booking',
      '/history',
      '/history?tab=orders',
      '/history?tab=passes',
      '/shop',
    ];

    for (const route of routesToCheck) {
      errors.length = 0;
      const targetUrl = `${BASE_URL}${route}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);

      // Verify no white screen
      const rootText = await page.textContent('#root');
      if (!rootText || rootText.trim().length === 0) {
        throw new Error(`Page rendered blank white screen on route: ${route}`);
      }

      if (errors.length > 0) {
        throw new Error(`Errors occurred on page ${route}:\n${errors.join('\n')}`);
      }
      console.log(`✓ ${route} passed with zero errors`);
    }

    // -------------------------------------------------------------
    // PART 2: Complete booking flow test (Section 4.1)
    // -------------------------------------------------------------
    console.log('\n--- Part 2: Verifying full booking flow (Section 4.1) ---');
    // Set authenticated state for customer booking flow
    authState.isAuthenticated = true;
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    // 1. Date strip is visible with dates
    const dateStrip = page.locator('[role="region"][aria-label="選擇日期"]');
    await dateStrip.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✓ DateStrip is visible');

    // 2. Month Calendar toggle & select
    const expandBtn = page.getByRole('button', { name: /整月/ });
    await expandBtn.click();
    await page.waitForTimeout(300);

    const monthCalendar = page.locator('.grid-cols-7');
    await monthCalendar.waitFor({ state: 'visible', timeout: 3000 });
    console.log('✓ MonthCalendar expanded successfully without crashing');

    // Find and click the upcoming weekday
    const { weekdayDate, saturdayDate } = getUpcomingDates();
    const [wy, wm, wd] = weekdayDate.split('-').map(Number);

    // Click that date in MonthCalendar
    const weekdayCalendarBtn = monthCalendar.locator(`button[aria-label*="${wm} 月 ${wd} 日"]:not([disabled])`).first();
    if (await weekdayCalendarBtn.isVisible()) {
      await weekdayCalendarBtn.click();
    } else {
      const activeDayBtn = monthCalendar.locator('button:not([disabled])').first();
      await activeDayBtn.click();
    }
    await page.waitForTimeout(300);

    // Month calendar collapses automatically
    const isExpandedNow = await monthCalendar.isVisible();
    if (isExpandedNow) {
      throw new Error('Month calendar did not automatically collapse after selecting date');
    }
    console.log('✓ MonthCalendar collapsed automatically after date selection');

    // Also click the specific weekday button in DateStrip to be 100% sure we're on weekday
    const weekdayStripBtn = dateStrip.locator(`button[aria-label*="${wm} 月 ${wd} 日"]:not([disabled])`).first();
    if (await weekdayStripBtn.isVisible()) {
      await weekdayStripBtn.click();
      await page.waitForTimeout(300);
    }

    // 3. Timed mode slot selection (12:00 to 18:00)
    const timedTab = page.getByRole('tab', { name: /計時/ });
    if (await timedTab.isVisible()) {
      await timedTab.click();
    }
    await page.waitForTimeout(200);

    // Select start slot 12:00 (12:00 到 13:00) and end slot 17:00 (17:00 到 18:00, which covers 12:00-18:00)
    const slot12 = page.locator('button[aria-label*="12:00 到 13:00"]').first();
    await slot12.click();
    await page.waitForTimeout(200);

    const slot17 = page.locator('button[aria-label*="17:00 到 18:00"]').first();
    await slot17.click();
    await page.waitForTimeout(300);

    // Verify bottom action bar shows strikethrough price and capped price (NT$600 -> NT$ 550)
    const bottomBar = page.locator('[role="region"][aria-label="結帳與金額列"]');
    await bottomBar.waitFor({ state: 'visible' });
    const bottomBarText = await bottomBar.textContent();
    console.log(`Bottom bar text: ${bottomBarText}`);
    if (!bottomBarText.includes('550')) {
      throw new Error(`Expected capped price NT$ 550 in bottom bar, got: ${bottomBarText}`);
    }
    console.log('✓ Timed mode hourly cap displayed properly (NT$ 550)');

    // 4. Click Next -> Step 2
    const nextBtn1 = bottomBar.getByRole('button', { name: '下一步' });
    await nextBtn1.click();
    await page.waitForURL('**/booking?step=2');
    await page.waitForTimeout(400);
    console.log('✓ Navigated to Step 2');

    // Increase people: 1 -> 2
    const addPaxBtn = page.getByRole('button', { name: '增加人數' });
    await addPaxBtn.click();
    await page.waitForTimeout(200);

    // Add 1 medium pegboard (pegboard_m)
    const addPegboardBtn = page.getByRole('button', { name: '增加中板' });
    await addPegboardBtn.click();
    await page.waitForTimeout(300);

    // Drag start time slider handle to 14:00 (focus handle and press ArrowRight twice)
    const startHandle = page.locator('div[role="slider"][aria-label="第 1 台開始時間"]');
    await startHandle.waitFor({ state: 'visible', timeout: 3000 });
    await startHandle.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);

    // Check bottom bar has NT$ 1,460
    const step2BottomBar = page.locator('[role="region"][aria-label="結帳與金額列"]');
    const step2Text = await step2BottomBar.textContent();
    console.log(`Step 2 bottom text after slider adjust: ${step2Text}`);
    if (!step2Text.includes('1,460') && !step2Text.includes('1460')) {
      throw new Error(`Expected NT$ 1,460 in bottom bar, got: ${step2Text}`);
    }
    console.log('✓ Pegboard time range adjusted to 14:00-18:00 (NT$ 1,460)');

    // Verify stock limit: Add 2nd medium board (total stock is 2)
    await addPegboardBtn.click();
    await page.waitForTimeout(300);
    const pegboardSection = page.locator('text=中板').first().locator('..');
    const pageTextAfter2nd = await page.textContent('main');
    if (!pageTextAfter2nd.includes('已租完')) {
      throw new Error('Expected "已租完" after adding 2nd medium pegboard');
    }
    const isAddDisabled = await addPegboardBtn.isDisabled();
    if (!isAddDisabled) {
      throw new Error('Expected add medium board (+) button to be disabled when stock is exhausted');
    }
    console.log('✓ Pegboard stock limit (2 units max) verified with "已租完" and disabled plus button');

    // Remove 2nd board to return to 1 board as required for Step 3 spec
    const removePegboardBtn = page.getByRole('button', { name: '減少中板' });
    await removePegboardBtn.click();
    await page.waitForTimeout(300);

    // 5. Click Next -> Step 3
    const nextBtn2 = step2BottomBar.getByRole('button', { name: '下一步' });
    await nextBtn2.click();
    await page.waitForURL('**/booking?step=3');
    await page.waitForTimeout(400);
    console.log('✓ Navigated to Step 3');

    // Check 4 discount breakdown lines
    const step3Content = await page.textContent('main');
    if (!step3Content.includes('入場 2 位 × 6 小時') || !step3Content.includes('1,200')) {
      throw new Error(`Missing seat line "入場 2 位 × 6 小時 NT$1,200" in:\n${step3Content}`);
    }
    if (!step3Content.includes('時數封頂') || !step3Content.includes('100')) {
      throw new Error(`Missing cap line "時數封頂（當日不限時暢玩 NT$550）−NT$100" in:\n${step3Content}`);
    }
    if (!step3Content.includes('智能拼豆板 中板 ×1 · 14:00 到 18:00') || !step3Content.includes('480')) {
      throw new Error(`Missing board line "智能拼豆板 中板 ×1 · 14:00 到 18:00 NT$480" in:\n${step3Content}`);
    }
    if (!step3Content.includes('智能板買二送一') || !step3Content.includes('120')) {
      throw new Error(`Missing discount line "智能板買二送一（折抵 1 小時）−NT$120" in:\n${step3Content}`);
    }
    if (!step3Content.includes('共省 NT$220')) {
      throw new Error(`Missing bottom summary "共省 NT$220" in:\n${step3Content}`);
    }
    console.log('✓ Step 3 all 4 pricing lines and "共省 NT$220" verified');

    // 6. Submit booking
    const submitBtn = page.getByRole('button', { name: '送出預約' });
    await submitBtn.click();
    await page.waitForURL('**/booking?step=done');
    await page.waitForTimeout(500);

    // Verify intercepted payload
    if (interceptedBookings.length === 0) {
      throw new Error('Booking submission request was not intercepted');
    }
    const lastBooking = interceptedBookings[interceptedBookings.length - 1];
    console.log('Submitted booking payload:', JSON.stringify(lastBooking, null, 2));

    const eqs = lastBooking.equipments || [];
    const pegM = eqs.find((e) => e.equipment_id === 'pegboard_m');
    if (!pegM || pegM.quantity !== 1 || pegM.rental_hours !== 4 || pegM.start_time !== '14:00') {
      throw new Error(
        `Submitted equipments mismatch: expected [{ equipment_id: 'pegboard_m', quantity: 1, rental_hours: 4, start_time: '14:00' }], got: ${JSON.stringify(
          eqs
        )}`
      );
    }
    console.log('✓ Request body equipments matched spec exactly: [{ equipment_id: "pegboard_m", quantity: 1, rental_hours: 4, start_time: "14:00" }]');

    // 7. Verify StepDone page shows completion
    const doneText = await page.textContent('body');
    if (!doneText.includes('預約完成') && !doneText.includes('BK-TEST-1234')) {
      throw new Error('StepDone did not display booking confirmation');
    }
    console.log('✓ StepDone view displayed confirmation successfully');

    // -------------------------------------------------------------
    // PART 3: Saturday Unlimited Mode Verification (Section 4.1)
    // -------------------------------------------------------------
    console.log('\n--- Part 3: Verifying Saturday Unlimited Mode (Section 4.1) ---');
    await page.goto(`${BASE_URL}/booking`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    // Select Saturday
    const [sy, sm, sd] = saturdayDate.split('-').map(Number);
    const satBtn = page.locator(`button[aria-label*="${sm} 月 ${sd} 日"]:not([disabled])`).first();
    if (await satBtn.isVisible()) {
      await satBtn.click();
    } else {
      // Open month calendar to pick Saturday
      const expandBtn2 = page.getByRole('button', { name: /整月/ });
      await expandBtn2.click();
      await page.waitForTimeout(300);
      const satCalBtn = page.locator('.grid-cols-7').locator(`button[aria-label*="${sm} 月 ${sd} 日"]:not([disabled])`).first();
      await satCalBtn.click();
    }
    await page.waitForTimeout(400);

    // Switch to unlimited mode
    const unlimitedCard = page.locator('button[role="radio"]', { hasText: '當日不限時暢玩' });
    await unlimitedCard.click();
    await page.waitForTimeout(400);

    // Check arrival options: 16:00 and 17:00 disabled
    const arrival16 = page.locator('button[role="radio"]', { hasText: '16:00' }).first();
    const arrival17 = page.locator('button[role="radio"]', { hasText: '17:00' }).first();
    if (!(await arrival16.isDisabled())) {
      throw new Error('Expected Saturday arrival 16:00 to be disabled in unlimited mode');
    }
    if (!(await arrival17.isDisabled())) {
      throw new Error('Expected Saturday arrival 17:00 to be disabled in unlimited mode');
    }
    console.log('✓ Saturday unlimited arrival 16:00 and 17:00 disabled as expected');

    // Select arrival 13:00
    const arrival13 = page.locator('button[role="radio"]', { hasText: '13:00' }).first();
    await arrival13.click();
    await page.waitForTimeout(300);

    // In leave options: 17:00 and 18:00 must be disabled
    const leaveSection = page.locator('text=預計幾點離開？').locator('..');
    const leave17 = leaveSection.locator('button[role="radio"]', { hasText: '17:00' }).first();
    const leave18 = leaveSection.locator('button[role="radio"]', { hasText: '18:00' }).first();
    if (!(await leave17.isDisabled())) {
      throw new Error('Expected leave 17:00 to be disabled when arriving at 13:00 on Saturday');
    }
    if (!(await leave18.isDisabled())) {
      throw new Error('Expected leave 18:00 to be disabled when arriving at 13:00 on Saturday');
    }
    console.log('✓ Saturday unlimited leave 17:00 and 18:00 disabled when arriving at 13:00');

    // Check closing option (玩到打烊 21:00) is checked by default
    const closingOption = leaveSection.locator('button[role="radio"][aria-checked="true"]', { hasText: /21:00/ }).first();
    if (!(await closingOption.isVisible())) {
      throw new Error('Expected "玩到打烊 21:00" to be selected by default');
    }
    console.log('✓ "玩到打烊 21:00" selected by default');

    // Check bottom bar shows NT$ 800
    const satBottomBar = page.locator('[role="region"][aria-label="結帳與金額列"]');
    const satBottomText = await satBottomBar.textContent();
    console.log(`Saturday bottom bar text: ${satBottomText}`);
    if (!satBottomText.includes('800')) {
      throw new Error(`Expected Saturday unlimited price NT$ 800 in bottom bar, got: ${satBottomText}`);
    }
    console.log('✓ Saturday unlimited price NT$ 800 verified');

    console.log('\n=== ALL CUSTOMER SMOKE TESTS PASSED SUCCESSFULLY! ===\n');
  } finally {
    if (browser) await browser.close();
    if (previewProcess && previewProcess.pid) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(previewProcess.pid), '/f', '/t'], { stdio: 'ignore' });
        } else {
          previewProcess.kill();
        }
      } catch (e) {}
    }
  }
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Smoke Test Failed:', err);
    process.exit(1);
  });

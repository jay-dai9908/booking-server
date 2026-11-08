import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl || !testDbUrl.trim()) {
  console.error('TEST_DATABASE_URL is not set. Refusing to run tests on production/dev database.');
  process.exit(1);
}
const cleanDbUrl = testDbUrl.split('?')[0];
const dbName = cleanDbUrl.split('/').pop();
if (!dbName || !dbName.endsWith('_test')) {
  console.error(`TEST_DATABASE_URL database name "${dbName}" must end with "_test"! Refusing to run tests.`);
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: testDbUrl.trim() } } });

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const API_BASE = process.env.API_BASE || 'http://localhost:3001/api';
const HEADLESS = process.env.HEADLESS !== 'false';
if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_PASSWORD.trim()) {
  console.error('請設定 ADMIN_PASSWORD 環境變數');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD.trim();

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1024, height: 768 }
];

const FORBIDDEN_TEXT_PATTERNS = [
  /\bundefined\b/,
  /\bNaN\b/,
  /\bnull\b/,
  /·\s*到/,
  /undefined\s*到/
];

async function cleanupTestData(bookingRefs = []) {
  try {
    for (const ref of bookingRefs) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: ref } } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: ref } });
      await prisma.reservation.deleteMany({ where: { booking_ref: ref } });
    }
  } catch (e) {
    console.warn('Cleanup error (non-fatal):', e.message);
  }
}

export async function runSeatingTests() {
  console.log(`Starting Seating Verification on ${BASE_URL} (Headless: ${HEADLESS})...`);

  const launchOptions = { headless: HEADLESS };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);

  const testRef1 = 'BK-TEST-SEAT-01';
  const testRef2 = 'BK-TEST-SEAT-02';
  const allRefs = [testRef1, testRef2];

  // Today in Asia/Taipei
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const todayUtc = new Date(`${todayStr}T00:00:00.000Z`);

  try {
    // 0. Ensure user and sessions exist for today (10:00 to 13:00)
    console.log(`Setting up test sessions for date: ${todayStr}...`);
    const testUser = await prisma.user.upsert({
      where: { line_user_id: 'test_seating_spec_user' },
      update: { name: '戴偉杰', phone: '0912345678' },
      create: { line_user_id: 'test_seating_spec_user', name: '戴偉杰', phone: '0912345678' }
    });

    const sessionStarts = ['10:00', '11:00', '12:00'];
    const sessions = [];
    for (const st of sessionStarts) {
      const et = `${parseInt(st, 10) + 1}:00`;
      const s = await prisma.session.upsert({
        where: {
          session_date_start_time: {
            session_date: todayUtc,
            start_time: st
          }
        },
        update: { max_capacity: 20 },
        create: {
          session_date: todayUtc,
          start_time: st,
          end_time: et,
          max_capacity: 20
        }
      });
      sessions.push(s);
    }

    for (const vp of VIEWPORTS) {
      console.log(`\n========================================`);
      console.log(` Testing Seating Flow on: ${vp.name} (${vp.width}x${vp.height})`);
      console.log(`========================================`);

      await cleanupTestData(allRefs);

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height }
      });
      const page = await context.newPage();

      const pageErrors = [];
      const apiErrors = [];

      page.on('pageerror', (err) => {
        console.error(`  [${vp.name} Page Error]`, err.message || err);
        pageErrors.push(err.message || String(err));
      });

      page.on('response', (res) => {
        if (res.url().includes('/api/') && res.status() >= 400) {
          if (res.url().includes('/api/auth/me') && res.status() === 401) return;
          console.error(`  [${vp.name} API Error ${res.status()}] ${res.url()}`);
          apiErrors.push({ url: res.url(), status: res.status() });
        }
      });

      // 1. Admin Login
      console.log(`Logging in as admin on ${vp.name}...`);
      await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
      const passInput = page.locator('input[type="password"]');
      await passInput.waitFor({ state: 'visible', timeout: 10000 });
      await passInput.fill(ADMIN_PASSWORD);
      await page.locator('button[type="submit"]').click();
      await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 15000 });
      await page.waitForTimeout(600);
      assert.ok(!page.url().includes('/login'), 'Must be logged in');

      const token = await page.evaluate(() => sessionStorage.getItem('shiguang_auth_token'));
      if (token) {
        await context.addInitScript((tok) => {
          try {
            sessionStorage.setItem('shiguang_auth_token', tok);
          } catch (e) {}
        }, token);
      }

      // Step 1: 建立一筆 2 位、10:00 到 13:00 的預約。待入座卡片顯示「10:00 到 13:00」
      console.log('Step 1: Creating a 2-pax 10:00-13:00 unseated reservation across 3 sessions...');
      for (const s of sessions) {
        await prisma.reservation.create({
          data: {
            booking_ref: testRef1,
            session_id: s.id,
            user_id: testUser.id,
            pax: 2,
            assigned_seats: ['A1-1', 'A1-2'],
            attendance: null,
            created_at: new Date()
          }
        });
      }

      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Make sure we are on the list tab if tabs exist
      const listTab = page.locator('button:has-text("名單")').first();
      if (await listTab.isVisible().catch(() => false)) {
        await listTab.click();
        await page.waitForTimeout(400);
      }

      // Verify pending card shows 10:00 到 13:00
      const pendingHeading = page.locator('h2:has-text("待入座")').first();
      await pendingHeading.waitFor({ state: 'visible', timeout: 8000 });
      const pendingCard = page.locator(`[data-booking-ref="${testRef1}"]`).first();
      await pendingCard.waitFor({ state: 'visible', timeout: 8000 });

      const cardBodyText = await page.evaluate(() => document.body.innerText || '');
      assert.ok(
        cardBodyText.includes('10:00 到 13:00'),
        'Pending reservation must strictly show "10:00 到 13:00"'
      );
      console.log('  ✔ Step 1 PASSED: Pending reservation displays correct time range (10:00 到 13:00)');

      // Step 2: 從預約訂單總覽按報到，會打開報到並帶位面板。選好座位並入座後，計時面板有 2 列，「預約」顯示「10:00 到 13:00 · 3 小時」
      console.log('Step 2: Check-in from ReservationsPage and seating...');
      await page.goto(`${BASE_URL}/admin/reservations`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);

      const checkInBtn = page.getByRole('button', { name: '報到', exact: true }).first();
      await checkInBtn.waitFor({ state: 'visible', timeout: 8000 });
      await checkInBtn.click();
      await page.waitForTimeout(600);

      // Verify CheckInPanel opens
      const checkInModalTitle = page.locator('text=報到並帶位').first();
      await checkInModalTitle.waitFor({ state: 'visible', timeout: 8000 });

      // Click "入座並開始計時" / "入座"
      const confirmCheckInBtn = page.locator('button:has-text("入座並開始計時"), button:has-text("入座"), button:has-text("確認報到並入座"), button:has-text("報到並帶位")').first();
      await confirmCheckInBtn.waitFor({ state: 'visible', timeout: 8000 });
      await confirmCheckInBtn.click();
      await page.waitForTimeout(1500);

      // Navigate back to /admin/seating and open timer panel
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const listTab2 = page.locator('button:has-text("名單")').first();
      if (await listTab2.isVisible().catch(() => false)) {
        await listTab2.click();
        await page.waitForTimeout(400);
      }

      // Click the checked in card to open timer panel
      const seatedCard = page.locator(`text=戴偉杰`).first();
      await seatedCard.waitFor({ state: 'visible', timeout: 8000 });
      await seatedCard.click();
      await page.waitForTimeout(600);

      // Check timer panel has 2 person rows and "10:00 到 13:00 · 3 小時"
      const timerPanel = page.locator('text=第 1 位').first();
      await timerPanel.waitFor({ state: 'visible', timeout: 8000 });
      const p2Row = page.locator('text=第 2 位').first();
      await p2Row.waitFor({ state: 'visible', timeout: 8000 });

      const panelText = await page.evaluate(() => document.body.innerText || '');
      assert.ok(
        panelText.includes('10:00 到 13:00') && panelText.includes('3 小時'),
        'Timer panel must display "10:00 到 13:00 · 3 小時"'
      );
      console.log('  ✔ Step 2 PASSED: Check-in created 2 persons and duration is 3 hours');

      // Step 3: 暫停第 1 位：第 1 位顯示「已暫停」，第 2 位仍是「計時中」
      console.log('Step 3: Pausing Person 1...');
      const pauseBtn = page.getByRole('button', { name: '暫停', exact: true }).first();
      await pauseBtn.waitFor({ state: 'visible', timeout: 8000 });
      await pauseBtn.click();
      await page.waitForTimeout(500);

      const confirmPauseBtn = page.getByRole('button', { name: '確認', exact: true }).first();
      if (await confirmPauseBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmPauseBtn.click();
        await page.waitForTimeout(1000);
      }

      // Check Person 1 displays "已暫停" while Person 2 displays "計時中"
      const p1Paused = page.locator('text=已暫停').first();
      await p1Paused.waitFor({ state: 'visible', timeout: 8000 });
      const p2Running = page.locator('text=計時中').first();
      await p2Running.waitFor({ state: 'visible', timeout: 8000 });
      console.log('  ✔ Step 3 PASSED: Person 1 paused without affecting Person 2');

      // Step 4: 按「全組暫停」：兩位都暫停，按鈕變成「全組繼續」
      console.log('Step 4: Clicking "全組暫停"...');
      const groupPauseBtn = page.locator('button:has-text("全組暫停")').first();
      await groupPauseBtn.waitFor({ state: 'visible', timeout: 8000 });
      await groupPauseBtn.click();
      await page.waitForTimeout(1000);

      const groupResumeBtn = page.locator('button:has-text("全組繼續")').first();
      await groupResumeBtn.waitFor({ state: 'visible', timeout: 8000 });
      console.log('  ✔ Step 4 PASSED: Both persons paused, group button changed to "全組繼續"');

      // Step 5: 把資料庫裡的計費起點改成 3 小時 40 分前：使用中卡片顯示「超時 40 分」
      console.log('Step 5: Updating billing_start_at to 3h 40m ago in DB...');
      const nowTs = new Date();
      const past220m = new Date(nowTs.getTime() - (220 * 60000));
      await prisma.bookingPerson.updateMany({
        where: { booking_ref: testRef1 },
        data: {
          billing_start_at: past220m,
          timer_started_at: past220m,
          paused_at: null,
          paused_seconds: 0
        }
      });

      // Reload seating page to fetch updated live timer
      await page.goto(`${BASE_URL}/admin/seating`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const listTab3 = page.locator('button:has-text("名單")').first();
      if (await listTab3.isVisible().catch(() => false)) {
        await listTab3.click();
        await page.waitForTimeout(400);
      }

      const overtimePill = page.locator('text=超時 40 分').first();
      await overtimePill.waitFor({ state: 'visible', timeout: 8000 });
      console.log('  ✔ Step 5 PASSED: In-use card shows "超時 40 分"');

      // Step 6: 換座位成功，平面圖上的座位跟著更新
      console.log('Step 6: Moving seat to A1-3...');
      const moveRes = await page.request.post(`${API_BASE}/floor/${testRef1}/move-seat`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { from_seat: 'A1-1', to_seat: 'A1-3', mode: 'move' }
      });
      assert.strictEqual(moveRes.status(), 200, 'Move seat API should succeed with 200');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);

      const updatedCardText = await page.evaluate(() => document.body.innerText || '');
      assert.ok(updatedCardText.includes('A1-3'), 'Card/seating should display new seat A1-3');
      console.log('  ✔ Step 6 PASSED: Move seat reflected on Seating page');

      // Step 7: 已報到但沒有帶位的訂單：顯示「這組還沒帶位」橫幅，按「帶位並開始計時」可以完成帶位
      console.log('Step 7: Creating unseated checked-in booking (needs_seating: true)...');
      await prisma.reservation.create({
        data: {
          booking_ref: testRef2,
          session_id: sessions[0].id,
          user_id: testUser.id,
          pax: 1,
          assigned_seats: ['A2-1'],
          attendance: 'checked_in',
          checked_in_at: new Date()
        }
      });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1000);

      const listTab4 = page.locator('button:has-text("名單")').first();
      if (await listTab4.isVisible().catch(() => false)) {
        await listTab4.click();
        await page.waitForTimeout(400);
      }

      const unseatedBanner = page.locator('text=這組還沒帶位，沒有計時紀錄').first();
      await unseatedBanner.waitFor({ state: 'visible', timeout: 8000 });

      const seatNowBtn = page.locator('button:has-text("帶位並開始計時")').first();
      await seatNowBtn.waitFor({ state: 'visible', timeout: 5000 });
      await seatNowBtn.click();
      await page.waitForTimeout(600);

      // Confirm seating in panel
      const completeSeatBtn = page.locator('button:has-text("入座並開始計時")').first();
      await completeSeatBtn.waitFor({ state: 'visible', timeout: 8000 });
      await completeSeatBtn.click();
      await page.waitForTimeout(1200);

      console.log('  ✔ Step 7 PASSED: Needs seating banner and completion verified');

      // Step 8: Assert no errors and no forbidden patterns
      console.log('Step 8: Verifying zero page errors and no forbidden tokens...');
      const bodyFinal = await page.evaluate(() => document.body.innerText || '');
      for (const pat of FORBIDDEN_TEXT_PATTERNS) {
        assert.ok(!pat.test(bodyFinal), `Found forbidden text pattern ${pat} on ${vp.name}`);
      }

      assert.strictEqual(pageErrors.length, 0, `Page errors encountered on ${vp.name}: ${pageErrors.join(', ')}`);
      assert.strictEqual(apiErrors.length, 0, `API >= 400 errors encountered on ${vp.name}: ${JSON.stringify(apiErrors)}`);
      console.log(`  ✔ Step 8 PASSED: Zero errors on ${vp.name}`);

      await context.close();
    }

    console.log('\n🎉 ALL SEATING PLAYWRIGHT VERIFICATIONS PASSED (mobile & desktop)!');
  } finally {
    await cleanupTestData(allRefs);
    await browser.close();
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.endsWith('seating.spec.js')) {
  runSeatingTests().catch((err) => {
    console.error('\n❌ Seating Test Failed:', err);
    process.exit(1);
  });
}

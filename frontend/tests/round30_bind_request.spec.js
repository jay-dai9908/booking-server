import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import assert from 'node:assert/strict';
import prisma from '../../backend/src/prismaClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
  ? path.resolve(process.env.SCREENSHOT_DIR)
  : path.resolve(__dirname, 'screenshots');
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  console.log('--- Starting Round 30 Item 2 Bind Request Playwright Test ---');
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const suffix = `${Date.now()}`;
  const testPass = `r30_bind_pwd_${suffix}`;
  const testPhone = '0900000099';
  const bookingRef = `R30BIND-${suffix}`;
  const passCode = `PASS-R30-${suffix}`;
  const planCode = `R30_PLAN_${suffix}`;

  const testStaff = await prisma.adminUser.create({
    data: {
      name: 'R30 Bind Spec Staff',
      password: testPass,
      role: 'staff',
      permissions: ['members', 'reservations'],
      is_active: true
    }
  });

  let manualUser = null;
  let newUser = null;
  let session = null;
  let plan = null;
  let userPass = null;
  let reservation = null;
  let bindReq = null;

  try {
    // Clean any stale leftover test phone records first
    await prisma.memberBindRequest.deleteMany({ where: { phone: testPhone } }).catch(() => {});

    manualUser = await prisma.user.create({
      data: {
        line_user_id: `manual_r30_spec_${suffix}`,
        name: '林櫃檯代建',
        phone: testPhone,
        is_blacklisted: true,
        notes: '舊櫃檯備註'
      }
    });

    newUser = await prisma.user.create({
      data: {
        line_user_id: `U_r30_spec_new_${suffix}`,
        name: '林小美',
        phone: testPhone,
        line_display_name: 'XiaoMei LINE'
      }
    });

    const futureDate = new Date(Date.now() + 3 * 86400000);
    const futureDateOnly = new Date(futureDate.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    session = await prisma.session.upsert({
      where: {
        session_date_start_time: {
          session_date: futureDateOnly,
          start_time: '14:00'
        }
      },
      update: {},
      create: {
        session_date: futureDateOnly,
        start_time: '14:00',
        end_time: '15:00',
        max_capacity: 20
      }
    });

    reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: session.id,
        user_id: manualUser.id,
        pax: 2,
        status: 'confirmed',
        total_amount: 300
      }
    });

    plan = await prisma.passPlan.create({
      data: {
        code: planCode,
        name: '十次拼豆卡',
        pass_type: 'PUNCH_CARD',
        price: 1200,
        total_quota: 10,
        valid_days: 90,
        is_active: true
      }
    });

    const expiresAt = new Date(Date.now() + 60 * 86400000);
    userPass = await prisma.userPass.create({
      data: {
        pass_code: passCode,
        user_id: manualUser.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        remaining_quota: 3,
        total_quota: 10,
        expires_at: expiresAt,
        status: 'ACTIVE'
      }
    });

    bindReq = await prisma.memberBindRequest.create({
      data: {
        new_user_id: newUser.id,
        manual_user_id: manualUser.id,
        phone: testPhone,
        status: 'pending',
        pass_summary: [
          {
            user_pass_id: userPass.id,
            plan_name: plan.name,
            remaining: 3,
            expires_at: expiresAt.toISOString()
          }
        ]
      }
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();

    console.log('1. Logging in to /admin/login...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(testPass);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);

    console.log('2. Opening /admin/members...');
    await page.goto(`${BASE_URL}/admin/members`, { waitUntil: 'networkidle' });

    const banner = page.locator('[data-testid="pending-bind-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 8000 });
    const bannerText = await banner.innerText();
    assert.ok(bannerText.includes('帳號綁定申請待確認'), `Expected pending bind banner text, got: ${bannerText}`);
    assert.ok(bannerText.includes('有 1 筆帳號綁定申請待確認') || /有 \d+ 筆帳號綁定申請待確認/.test(bannerText), `Unexpected banner count: ${bannerText}`);

    // Click filter button to show only members with pending bind request
    await banner.locator('button', { hasText: '只看待確認會員' }).click();
    await page.waitForTimeout(400);

    // Click into newUser row
    const memberRow = page.locator('tbody tr', { hasText: '林小美' }).first();
    await memberRow.waitFor({ state: 'visible', timeout: 8000 });
    await memberRow.click();

    // Verify yellow bind request card & red pass/blacklist warnings
    const card = page.locator('[data-testid="bind-request-card"]');
    await card.waitFor({ state: 'visible', timeout: 8000 });
    await page.waitForTimeout(500);
    const cardText = await card.innerText();
    assert.ok(cardText.includes('LINE 帳號綁定申請'), `Missing card header: ${cardText}`);
    assert.ok(cardText.includes('林小美') && cardText.includes('XiaoMei LINE'), `Missing new user info: ${cardText}`);
    assert.ok(cardText.includes('林櫃檯代建'), `Missing manual user info: ${cardText}`);
    assert.ok(cardText.includes('舊帳號有卡券：十次拼豆卡 剩 3 次'), `Missing red pass warning: ${cardText}`);
    assert.ok(cardText.includes('舊帳號在黑名單，合併後新帳號也會列入'), `Missing red blacklist warning: ${cardText}`);

    const shotPath = path.join(SCREENSHOT_DIR, 'round30_shot1_bind_request.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    console.log(`Saved screenshot: ${shotPath}`);

    // Approve merge via ConfirmPanel
    await card.locator('button', { hasText: '核准合併' }).click();
    const confirmDialog = page.locator('[role="dialog"]', { hasText: '確認核准帳號合併' });
    await confirmDialog.waitFor({ state: 'visible', timeout: 5000 });
    const dialogText = await confirmDialog.innerText();
    assert.ok(dialogText.includes('請先向客人確認身分（例如看 LINE 頭像或預約紀錄）'), `Missing identity reminder: ${dialogText}`);

    await confirmDialog.locator('button', { hasText: '確認核准合併' }).click();

    // Card should disappear and reservations tab should now show the merged reservation
    await card.waitFor({ state: 'detached', timeout: 8000 });
    const resTabBtn = page.locator('button', { hasText: '歷史預約紀錄 (1)' });
    await resTabBtn.waitFor({ state: 'visible', timeout: 8000 });

    // Also verify merged manual user view shows "已併入 #<newUser.id>" link
    await page.goto(`${BASE_URL}/admin/members?userId=${manualUser.id}`, { waitUntil: 'networkidle' });
    const mergedLink = page.locator('[data-testid="merged-into-link"]');
    await mergedLink.waitFor({ state: 'visible', timeout: 8000 });
    const mergedLinkText = await mergedLink.innerText();
    assert.equal(mergedLinkText.trim(), `已併入 #${newUser.id}`);

    await browser.close();
    console.log('✅ Round 30 Item 2 Bind Request Playwright Test PASSED!');
  } finally {
    await prisma.accountingEvent.deleteMany({ where: { event_type: 'member_merged' } }).catch(() => {});
    if (bindReq) await prisma.memberBindRequest.delete({ where: { id: bindReq.id } }).catch(() => {});
    if (userPass) await prisma.userPass.delete({ where: { id: userPass.id } }).catch(() => {});
    if (plan) await prisma.passPlan.delete({ where: { id: plan.id } }).catch(() => {});
    if (reservation) await prisma.reservation.delete({ where: { id: reservation.id } }).catch(() => {});
    if (manualUser) await prisma.user.delete({ where: { id: manualUser.id } }).catch(() => {});
    if (newUser) await prisma.user.delete({ where: { id: newUser.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: testStaff.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 30 Item 2 Bind Request Playwright Test Failed:', err);
  process.exit(1);
});

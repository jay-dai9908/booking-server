import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import prisma from '../../backend/src/prismaClient.js';

const BASE_URL = process.env.BASE_URL || 'http://localhost:5173';
const HEADLESS = process.env.HEADLESS !== 'false';

async function run() {
  console.log('--- Starting Round 30 Item 4 Admin-on-/history Isolation Playwright Test ---');

  const suffix = `${Date.now()}`;
  const testPass = `r30_item4_pwd_${suffix}`;
  const secretCustomerName = `SECRET_CUST_${suffix}`;
  const bookingRef = `R30ISO-${suffix}`;

  const testStaff = await prisma.adminUser.create({
    data: {
      name: 'R30 Item4 Spec Staff',
      password: testPass,
      role: 'staff',
      permissions: [],
      is_active: true
    }
  });

  let customer = null;
  let session = null;
  let reservation = null;

  try {
    customer = await prisma.user.create({
      data: {
        line_user_id: `U_r30_iso_${suffix}`,
        name: secretCustomerName,
        phone: '0900000088'
      }
    });

    const futureDate = new Date(Date.now() + 2 * 86400000);
    const futureDateOnly = new Date(futureDate.toISOString().slice(0, 10) + 'T00:00:00.000Z');
    session = await prisma.session.upsert({
      where: {
        session_date_start_time: {
          session_date: futureDateOnly,
          start_time: '15:00'
        }
      },
      update: {},
      create: {
        session_date: futureDateOnly,
        start_time: '15:00',
        end_time: '16:00',
        max_capacity: 20
      }
    });

    reservation = await prisma.reservation.create({
      data: {
        booking_ref: bookingRef,
        session_id: session.id,
        user_id: customer.id,
        pax: 1,
        status: 'confirmed'
      }
    });

    const browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    console.log('1. Logging in as staff...');
    await page.goto(`${BASE_URL}/admin/login`, { waitUntil: 'networkidle' });
    await page.locator('input[type="password"]').fill(testPass);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname === '/admin/sessions', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(200);

    console.log('2. Navigating to customer /history in same browser...');
    await page.goto(`${BASE_URL}/history`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    const currentPath = new URL(page.url()).pathname;
    const bodyText = await page.locator('body').innerText();
    assert.ok(!bodyText.includes(secretCustomerName), 'Customer name leaked on /history!');
    assert.ok(!bodyText.includes(bookingRef), 'Customer booking_ref leaked on /history!');
    assert.ok(!bodyText.includes('0900000088'), 'Customer phone leaked on /history!');
    assert.ok(
      currentPath === '/' || bodyText.includes('登入') || bodyText.includes('顧客'),
      `Expected redirect to customer login or error prompt, got path=${currentPath}`
    );

    const apiResult = await page.evaluate(async () => {
      const token = sessionStorage.getItem('shiguang_auth_token');
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch('http://localhost:3001/api/reservations/my', {
        credentials: 'include',
        headers
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, json };
    });
    assert.equal(apiResult.status, 403, `Expected 403 CUSTOMER_ONLY, got ${apiResult.status}`);
    assert.equal(apiResult.json?.code, 'CUSTOMER_ONLY');

    await browser.close();
    console.log('✅ Round 30 Item 4 Admin-on-/history Isolation Playwright Test PASSED!');
  } finally {
    if (reservation) await prisma.reservation.delete({ where: { id: reservation.id } }).catch(() => {});
    if (customer) await prisma.user.delete({ where: { id: customer.id } }).catch(() => {});
    await prisma.adminUser.delete({ where: { id: testStaff.id } }).catch(() => {});
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('❌ Round 30 Item 4 Admin-on-/history Isolation Playwright Test Failed:', err);
  process.exit(1);
});

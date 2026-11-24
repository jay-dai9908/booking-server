import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import authRoutes from '../src/routes/auth.js';
import billingRoutes from '../src/routes/billing.js';
import passRoutes from '../src/routes/passes.js';
import { validatePassUsage, deductPass, restorePass } from '../src/services/billing/passTender.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/passes', passRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

test('Round 35 Item 4: unified use_date limits, restore subtraction, manual/POS parity, target person check, multi-pass cap, and entry_full unit=1', async (t) => {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const todayStr = toTaipeiDateString(new Date());
  const todayDate = dateOnly(todayStr);
  const dec04 = dateOnly('2099-12-04');
  const dec05 = dateOnly('2099-12-05');

  const refToday = `R35-I4-TD-${runId}`;
  const refBadTarget = `R35-I4-BT-${runId}`;
  const refMulti = `R35-I4-ML-${runId}`;
  const refUnits2 = `R35-I4-U2-${runId}`;
  const createdRefs = [refToday, refBadTarget, refMulti, refUnits2];

  let srv = null;
  let user = null;
  let adminUser = null;
  let sessToday = null;
  let dailyToday = null;
  let dailyDec05 = null;
  let equip = null;
  const createdPlanIds = [];
  const createdPassIds = [];
  let createdLayoutId = null;

  t.after(async () => {
    if (srv) await srv.close().catch(() => {});
    await prisma.printJob.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingEquipment.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
    if (sessToday?.id) await prisma.session.delete({ where: { id: sessToday.id } }).catch(() => {});
    if (dailyToday === 'created') await prisma.dailySetting.delete({ where: { date: todayDate } }).catch(() => {});
    if (dailyDec05 === 'created') await prisma.dailySetting.delete({ where: { date: dec05 } }).catch(() => {});
    if (equip?.id) await prisma.equipmentConfig.delete({ where: { id: equip.id } }).catch(() => {});
    if (createdPassIds.length) await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } }).catch(() => {});
    if (createdPlanIds.length) await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } }).catch(() => {});
    if (user?.id) await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    if (adminUser?.id) await prisma.adminUser.delete({ where: { id: adminUser.id } }).catch(() => {});
    await cleanupTestPublishedLayout(prisma, createdLayoutId);
  });

  createdLayoutId = await ensureTestPublishedLayout(prisma);
  srv = await startLocalApp();

  user = await prisma.user.create({
    data: {
      line_user_id: `r35_i4_user_${runId}`,
      name: 'R35限額客',
      phone: `09954${String(Date.now()).slice(-5)}` // check-secrets: fake-data
    }
  });
  const adminPass = `r35_i4_adm_${runId}`;
  adminUser = await prisma.adminUser.create({
    data: {
      password: adminPass,
      name: `R35店員_${runId}`,
      role: 'superadmin',
      permissions: ['all'],
      is_active: true
    }
  });
  const loginRes = await fetch(`${srv.baseUrl}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPass })
  });
  assert.equal(loginRes.status, 200);
  const { token: adminToken } = await loginRes.json();

  const existingTodayDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  if (!existingTodayDaily) {
    await prisma.dailySetting.create({
      data: { date: todayDate, hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
    });
    dailyToday = 'created';
  }
  const existingDec05Daily = await prisma.dailySetting.findUnique({ where: { date: dec05 } });
  if (!existingDec05Daily) {
    await prisma.dailySetting.create({
      data: { date: dec05, hourly_price: 150, unlimited_price: 800, allow_unlimited: true, is_self_service: false }
    });
    dailyDec05 = 'created';
  }

  sessToday = await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '13:00' } }
  });
  if (!sessToday) {
    sessToday = await prisma.session.create({
      data: { session_date: todayDate, start_time: '13:00', end_time: '14:00', max_capacity: 20 }
    });
  } else {
    sessToday = null;
  }
  const sessRow = sessToday || await prisma.session.findUnique({
    where: { session_date_start_time: { session_date: todayDate, start_time: '13:00' } }
  });

  equip = await prisma.equipmentConfig.create({
    data: {
      id: `r35_i4_eq_${runId}`,
      name: 'R35大板',
      hourly_rate: 200,
      total_stock: 5,
      min_contiguous_hours: 1,
      visibility_status: 'ACTIVE'
    }
  });

  const timePlan = await prisma.passPlan.create({
    data: {
      code: `R35_I4_T_${runId}`,
      name: '時數限額卡',
      pass_type: 'TIME_PASS',
      price: 600,
      total_quota: 20,
      valid_days: 90,
      max_hours_per_day: 3,
      checkout_effect: 'entry_hours',
      checkout_scope: 'entry'
    }
  });
  const entryPlan = await prisma.passPlan.create({
    data: {
      code: `R35_I4_E_${runId}`,
      name: '計次入場卡',
      pass_type: 'PUNCH_CARD',
      price: 500,
      total_quota: 10,
      valid_days: 90,
      checkout_effect: 'entry_full',
      checkout_scope: 'entry'
    }
  });
  const fixedPlan = await prisma.passPlan.create({
    data: {
      code: `R35_I4_F_${runId}`,
      name: '全額折500券',
      pass_type: 'VISIT_PACK',
      price: 400,
      total_quota: 5,
      valid_days: 90,
      checkout_effect: 'fixed_amount',
      checkout_scope: 'all',
      checkout_value: 500
    }
  });
  createdPlanIds.push(timePlan.id, entryPlan.id, fixedPlan.id);

  // 1 & 2. use_date scoping: deduct 3h on dec05 while running on dec04 -> dec05 blocked, dec04 allowed; restore -> dec05 allowed again
  const timePassFuture = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: timePlan.id,
      pass_code: `R35I4T1-${runId}`,
      plan_name_snapshot: timePlan.name,
      pass_type: 'TIME_PASS',
      total_quota: 20,
      remaining_quota: 20,
      max_hours_per_day: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(timePassFuture.id);

  const afterHold = await prisma.$transaction((tx) =>
    deductPass(tx, {
      user_pass_id: timePassFuture.id,
      units: 3,
      booking_ref: `BK-DEC05-${runId}`,
      staff_name: 'tester',
      source: 'self_service_prepay',
      date: dec05
    })
  );
  assert.equal(validatePassUsage(afterHold, { date: dec05, units: 1 }).usable, false);
  assert.equal(validatePassUsage(afterHold, { date: dec04, units: 1 }).usable, true);

  const afterRestore = await prisma.$transaction((tx) =>
    restorePass(tx, {
      user_pass_id: timePassFuture.id,
      units: 3,
      booking_ref: `BK-DEC05-${runId}`,
      staff_name: 'tester'
    })
  );
  assert.equal(validatePassUsage(afterRestore, { date: dec05, units: 3 }).usable, true);

  // 3. POS deduct 3h today -> manual redeem 1h today is blocked by unified validatePassUsage
  const timePassToday = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: timePlan.id,
      pass_code: `R35I4T2-${runId}`,
      plan_name_snapshot: timePlan.name,
      pass_type: 'TIME_PASS',
      total_quota: 20,
      remaining_quota: 20,
      max_hours_per_day: 3,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(timePassToday.id);

  await prisma.reservation.create({
    data: {
      booking_ref: refToday,
      user_id: user.id,
      session_id: sessRow.id,
      pax: 1,
      assigned_seats: ['A1'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly', hours_override: 3 }] }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refToday, person_no: 1, seat_code: 'A1', status: 'active' }
  });
  const colToday = await fetch(`${srv.baseUrl}/api/billing/${refToday}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      pass_tenders: [{ user_pass_id: timePassToday.id, person_no: 1, units: 3 }],
      print: false
    })
  });
  assert.equal(colToday.status, 200);

  const manualBlocked = await fetch(`${srv.baseUrl}/api/passes/admin/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ user_pass_id: timePassToday.id, deduct_amount: 1 })
  });
  assert.equal(manualBlocked.status, 422);

  // 4. person_nos: [1, 2] with pass_tender person_no: 3 -> 422
  const entryPass = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: entryPlan.id,
      pass_code: `R35I4E-${runId}`,
      plan_name_snapshot: entryPlan.name,
      pass_type: 'PUNCH_CARD',
      total_quota: 10,
      remaining_quota: 10,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  const fixedPass = await prisma.userPass.create({
    data: {
      user_id: user.id,
      plan_id: fixedPlan.id,
      pass_code: `R35I4F-${runId}`,
      plan_name_snapshot: fixedPlan.name,
      pass_type: 'VISIT_PACK',
      total_quota: 5,
      remaining_quota: 5,
      payment_status: 'active',
      status: 'ACTIVE',
      expires_at: dateOnly('2099-12-31')
    }
  });
  createdPassIds.push(entryPass.id, fixedPass.id);

  await prisma.reservation.create({
    data: {
      booking_ref: refBadTarget,
      user_id: user.id,
      session_id: sessRow.id,
      pax: 2,
      assigned_seats: ['A2', 'A3'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }, { person_no: 2, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.createMany({
    data: [
      { booking_ref: refBadTarget, person_no: 1, seat_code: 'A2', status: 'active' },
      { booking_ref: refBadTarget, person_no: 2, seat_code: 'A3', status: 'active' }
    ]
  });
  const badTargetRes = await fetch(`${srv.baseUrl}/api/billing/${refBadTarget}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1, 2],
      method: 'cash',
      pass_tenders: [{ user_pass_id: entryPass.id, person_no: 3, units: 1 }],
      print: false
    })
  });
  assert.equal(badTargetRes.status, 422);

  // 5. Multi-pass per person cap: total 1000 (entry 800 + board 200); entry_full (800) + fixed_amount 500 (all) -> second discounts 200
  await prisma.reservation.create({
    data: {
      booking_ref: refMulti,
      user_id: user.id,
      session_id: sessRow.id,
      pax: 1,
      assigned_seats: ['A4'],
      status: 'confirmed',
      is_unlimited: true,
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'unlimited' }] }
    }
  });
  const bpMulti = await prisma.bookingPerson.create({
    data: { booking_ref: refMulti, person_no: 1, seat_code: 'A4', status: 'active' }
  });
  await prisma.bookingEquipment.create({
    data: {
      booking_ref: refMulti,
      equipment_id: equip.id,
      equipment_name_snapshot: equip.name,
      quantity: 1,
      rental_hours: 1,
      unit_rate: 200,
      subtotal_price: 200,
      person_id: bpMulti.id,
      covered_sessions: ['13:00-14:00']
    }
  });
  const multiCol = await fetch(`${srv.baseUrl}/api/billing/${refMulti}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      pass_tenders: [
        { user_pass_id: entryPass.id, person_no: 1, units: 1 },
        { user_pass_id: fixedPass.id, person_no: 1, units: 1 }
      ],
      print: false
    })
  });
  assert.equal(multiCol.status, 200);
  const multiData = await multiCol.json();
  const passPayments = multiData.payments.filter((p) => p.method === 'pass');
  assert.equal(passPayments.length, 2);
  assert.deepEqual(passPayments.map((p) => p.amount).sort((a, b) => b - a), [800, 200]);

  // 6. entry_full with units: 2 -> only deducts 1
  const beforeQuota = (await prisma.userPass.findUnique({ where: { id: entryPass.id } })).remaining_quota;
  await prisma.reservation.create({
    data: {
      booking_ref: refUnits2,
      user_id: user.id,
      session_id: sessRow.id,
      pax: 1,
      assigned_seats: ['A5'],
      status: 'confirmed',
      checkout_details: { version: 2, persons: [{ person_no: 1, mode: 'hourly' }] }
    }
  });
  await prisma.bookingPerson.create({
    data: { booking_ref: refUnits2, person_no: 1, seat_code: 'A5', status: 'active' }
  });
  const u2Col = await fetch(`${srv.baseUrl}/api/billing/${refUnits2}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      person_nos: [1],
      method: 'cash',
      pass_tenders: [{ user_pass_id: entryPass.id, person_no: 1, units: 2 }],
      print: false
    })
  });
  assert.equal(u2Col.status, 200);
  const afterQuota = (await prisma.userPass.findUnique({ where: { id: entryPass.id } })).remaining_quota;
  assert.equal(beforeQuota - afterQuota, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { runMidnightJob } from '../src/cronJobs.js';
import { runCronOnce } from '../src/services/cron/cronLock.js';
import { checkKioskOfflineAlerts } from '../src/services/kiosk/alertService.js';

test('Round 46 Item 4: midnight no_show skips paid/partial/verified bookings and CronRun lock prevents duplicate runs', async () => {
  const ts = Date.now();
  const todayStr = toTaipeiDateString(new Date());
  const yestStr = toTaipeiDateString(new Date(Date.now() - 86400000));
  const yestDate = dateOnly(yestStr);
  const todayDate = dateOnly(todayStr);

  const origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  const origTodayDaily = await prisma.dailySetting.findUnique({ where: { date: todayDate } });
  const origActiveDevices = await prisma.kioskDevice.findMany({ where: { is_active: true }, select: { id: true } });

  const createdUserIds = [];
  const createdSessionIds = [];
  const createdRefs = [];
  const createdCronJobs = [];
  const createdDeviceIds = [];

  try {
    const cust = await prisma.user.create({
      data: {
        line_user_id: `U_R46_I4_${ts}`,
        name: 'R46排程測試顧客',
        phone: '0944555666'
      }
    });
    createdUserIds.push(cust.id);

    let sPast = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: yestDate, start_time: '14:00' } }
    });
    if (!sPast) {
      sPast = await prisma.session.create({
        data: { session_date: yestDate, start_time: '14:00', end_time: '15:00', max_capacity: 16 }
      });
      createdSessionIds.push(sPast.id);
    }

    const refA = `R46I4-A-${crypto.randomUUID().slice(0, 6)}`;
    const refB = `R46I4-B-${crypto.randomUUID().slice(0, 6)}`;
    const refC = `R46I4-C-${crypto.randomUUID().slice(0, 6)}`;
    const refD = `R46I4-D-${crypto.randomUUID().slice(0, 6)}`;
    const refE = `R46I4-E-${crypto.randomUUID().slice(0, 6)}`;
    createdRefs.push(refA, refB, refC, refD, refE);

    // A: unpaid
    await prisma.reservation.create({
      data: { booking_ref: refA, session_id: sPast.id, user_id: cust.id, pax: 1, status: 'confirmed', attendance: null, is_paid: false, billing_status: 'unpaid' }
    });
    // B: paid
    await prisma.reservation.create({
      data: { booking_ref: refB, session_id: sPast.id, user_id: cust.id, pax: 1, status: 'confirmed', attendance: null, is_paid: true, billing_status: 'paid' }
    });
    // C: partial
    await prisma.reservation.create({
      data: { booking_ref: refC, session_id: sPast.id, user_id: cust.id, pax: 2, status: 'confirmed', attendance: null, is_paid: false, billing_status: 'partial' }
    });
    // D: self-service verified
    await prisma.reservation.create({
      data: { booking_ref: refD, session_id: sPast.id, user_id: cust.id, pax: 1, status: 'confirmed', attendance: null, is_paid: true, billing_status: 'paid', is_self_service: true }
    });
    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refD,
        user_id: cust.id,
        payment_method_code: 'ctbc_pool',
        status: 'verified',
        total_amount: 550,
        amount_due: 550,
        deadline_at: new Date(Date.now() - 86400000)
      }
    });
    // E: checked_in from yesterday -> should still become completed (Round 41)
    await prisma.reservation.create({
      data: { booking_ref: refE, session_id: sPast.id, user_id: cust.id, pax: 1, status: 'confirmed', attendance: 'checked_in' }
    });

    const beforeMidnight = new Date();
    await runMidnightJob(new Date());

    const rowA = await prisma.reservation.findFirst({ where: { booking_ref: refA } });
    const rowB = await prisma.reservation.findFirst({ where: { booking_ref: refB } });
    const rowC = await prisma.reservation.findFirst({ where: { booking_ref: refC } });
    const rowD = await prisma.reservation.findFirst({ where: { booking_ref: refD } });
    const rowE = await prisma.reservation.findFirst({ where: { booking_ref: refE } });

    assert.equal(rowA.attendance, 'no_show');
    assert.equal(rowB.attendance, null);
    assert.equal(rowC.attendance, null);
    assert.equal(rowD.attendance, null);
    assert.equal(rowE.attendance, 'completed');

    const skipEvents = await prisma.accountingEvent.findMany({
      where: {
        event_type: 'no_show_skipped_paid',
        booking_ref: { in: [refB, refC, refD] },
        created_at: { gte: beforeMidnight }
      }
    });
    assert.equal(skipEvents.length, 3);

    // 2) Concurrent runCronOnce -> executes fn only once
    const jobDone = `r46_test_done_${ts}`;
    createdCronJobs.push(jobDone);
    let execCount = 0;
    const [r1, r2] = await Promise.all([
      runCronOnce(jobDone, '2026-11-23', async () => {
        execCount++;
        await new Promise((r) => setTimeout(r, 30));
        return { processed: 1 };
      }),
      runCronOnce(jobDone, '2026-11-23', async () => {
        execCount++;
        return { processed: 2 };
      })
    ]);
    assert.equal(execCount, 1);
    assert.equal([r1.skipped, r2.skipped].filter(Boolean).length, 1);

    const cronDoneRows = await prisma.cronRun.findMany({
      where: { job: jobDone, run_key: '2026-11-23' }
    });
    assert.equal(cronDoneRows.length, 1);
    assert.equal(cronDoneRows[0].status, 'done');

    // 3) Failing fn -> status 'failed' with error message in result_json
    const jobFail = `r46_test_fail_${ts}`;
    createdCronJobs.push(jobFail);
    await assert.rejects(
      () => runCronOnce(jobFail, '2026-11-23', async () => {
        throw new Error('模擬排程失敗訊息');
      }),
      /模擬排程失敗訊息/
    );
    const cronFailRow = await prisma.cronRun.findUnique({
      where: { job_run_key: { job: jobFail, run_key: '2026-11-23' } }
    });
    assert.equal(cronFailRow.status, 'failed');
    assert.ok(String(cronFailRow.result_json?.error || '').includes('模擬排程失敗訊息'));

    // 4) Kiosk offline alert deduplicated by CronRun lock
    let sToday = await prisma.session.findUnique({
      where: { session_date_start_time: { session_date: todayDate, start_time: '00:00' } }
    });
    if (!sToday) {
      sToday = await prisma.session.create({
        data: { session_date: todayDate, start_time: '00:00', end_time: '23:59', max_capacity: 16 }
      });
      createdSessionIds.push(sToday.id);
    }

    await prisma.dailySetting.upsert({
      where: { date: todayDate },
      update: { is_self_service: true },
      create: { date: todayDate, is_self_service: true }
    });
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { alert_user_ids: [cust.id], after_close_minutes: 60 },
      create: { id: 1, alert_user_ids: [cust.id], after_close_minutes: 60 }
    });

    // Clear other active devices temporarily or reuse unique active device
    await prisma.kioskDevice.updateMany({ where: { is_active: true }, data: { is_active: false } });
    const dev = await prisma.kioskDevice.create({
      data: {
        name: 'R46測試報到機',
        key_wrapped: `wrapped-${ts}`,
        is_active: true,
        last_seen_at: new Date(Date.now() - 25 * 60 * 1000), // 25 min ago -> offline
        offline_alerted_at: null
      }
    });
    createdDeviceIds.push(dev.id);

    let pushCalls = 0;
    const mockPush = async () => { pushCalls++; };
    const alertJob = `r46_kiosk_alert_${ts}`;
    createdCronJobs.push(alertJob);
    const fixedNow = new Date(`${todayStr}T12:00:00+08:00`);

    await runCronOnce(alertJob, `${todayStr}T12:00`, () => checkKioskOfflineAlerts(prisma, fixedNow, { pushFn: mockPush }));
    await runCronOnce(alertJob, `${todayStr}T12:00`, () => checkKioskOfflineAlerts(prisma, fixedNow, { pushFn: mockPush }));
    assert.equal(pushCalls, 1);
  } finally {
    if (createdCronJobs.length > 0) {
      await prisma.cronRun.deleteMany({ where: { job: { in: createdCronJobs } } });
    }
    if (createdDeviceIds.length > 0) {
      await prisma.kioskDevice.deleteMany({ where: { id: { in: createdDeviceIds } } });
    }
    if (origActiveDevices.length > 0) {
      await prisma.kioskDevice.updateMany({
        where: { id: { in: origActiveDevices.map((d) => d.id) } },
        data: { is_active: true }
      });
    }
    if (createdRefs.length > 0) {
      await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    if (origTodayDaily) {
      await prisma.dailySetting.update({
        where: { date: todayDate },
        data: { is_self_service: origTodayDaily.is_self_service }
      });
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: todayDate } });
    }
    if (origKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          alert_user_ids: origKiosk.alert_user_ids,
          after_close_minutes: origKiosk.after_close_minutes
        }
      });
    }
  }
});

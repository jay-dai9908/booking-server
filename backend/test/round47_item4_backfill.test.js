import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { runBackfillDayTypes } from '../scripts/backfill-day-types.mjs';

const execFileAsync = promisify(execFile);

test('Round 47 Item 4: backfill-day-types dry-run/apply/idempotency + snapshot-bills & compare-bill-snapshots exact parity', async () => {
  const runId = Date.now();
  const tmpDir = os.tmpdir();
  const beforeFile = path.join(tmpDir, `r47-snap-before-${runId}.json`);
  const afterFile = path.join(tmpDir, `r47-snap-after-${runId}.json`);
  const badFile = path.join(tmpDir, `r47-snap-bad-${runId}.json`);

  const dWed = '2026-10-07';
  const dSpecial = '2026-10-08';
  const dNoSetting = '2026-10-09';
  const dSat = '2026-10-10';
  const dSelf = '2026-10-11';
  const dNoSess = '2026-10-12';
  const dManual = '2026-10-13';
  const allDates = [dWed, dSpecial, dNoSetting, dSat, dSelf, dNoSess, dManual].map(dateOnly);

  const prevGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const createdSessionIds = [];
  const createdRefs = [];
  const passPlanCode = `R47I4_PLAN_${runId}`;
  const passCode = `R47I4PASS${String(runId).slice(-4)}`;
  let userId = null;

  try {
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: {
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      },
      create: {
        id: 1,
        weekday_hourly_price: 150,
        weekday_unlimited_price: 750,
        weekend_hourly_price: 180,
        weekend_unlimited_price: 1100
      }
    });

    await prisma.dailySetting.deleteMany({ where: { date: { in: allDates } } });

    const ensureSession = async (dStr, start = '13:00', end = '15:00') => {
      const dObj = dateOnly(dStr);
      const ex = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date: dObj, start_time: start } }
      });
      if (ex) return ex;
      const s = await prisma.session.create({
        data: { session_date: dObj, start_time: start, end_time: end, max_capacity: 16 }
      });
      createdSessionIds.push(s.id);
      return s;
    };

    const [sWed, sSpecial, sNoSetting, sSat, sSelf, sManual] = await Promise.all([
      ensureSession(dWed),
      ensureSession(dSpecial),
      ensureSession(dNoSetting),
      ensureSession(dSat),
      ensureSession(dSelf),
      ensureSession(dManual)
    ]);

    await prisma.dailySetting.createMany({
      data: [
        { date: dateOnly(dSpecial), hourly_price: 120, unlimited_price: 600 },
        { date: dateOnly(dSelf), is_self_service: true },
        { date: dateOnly(dManual), day_type: 'holiday', day_type_source: 'manual' }
      ]
    });

    const user = await prisma.user.create({
      data: { name: `R47I4顧客-${runId}`, phone: `0966${String(runId).slice(-6)}`, line_user_id: `U_R47I4_${runId}` }
    });
    userId = user.id;

    const plan = await prisma.passPlan.create({
      data: { code: passPlanCode, name: 'R47I4九宮格卡', pass_type: 'PUNCH_CARD', price: 1000, total_quota: 5, is_active: true }
    });
    const pass = await prisma.userPass.create({
      data: {
        user_id: user.id,
        plan_id: plan.id,
        pass_code: passCode,
        plan_name_snapshot: plan.name,
        pass_type: 'PUNCH_CARD',
        total_quota: 5,
        remaining_quota: 4,
        payment_status: 'active',
        status: 'ACTIVE',
        expires_at: dateOnly('2099-12-31')
      }
    });

    const refPaidSnap = `R47I4-PAID-${runId}`;
    const refLegacyUnpaid = `R47I4-LEG-${runId}`;
    const refPartial = `R47I4-PART-${runId}`;
    const refSpecial = `R47I4-SPEC-${runId}`;
    const refSelf = `R47I4-SELF-${runId}`;
    const refManual = `R47I4-MAN-${runId}`;
    createdRefs.push(refPaidSnap, refLegacyUnpaid, refPartial, refSpecial, refSelf, refManual);

    await prisma.reservation.createMany({
      data: [
        {
          booking_ref: refPaidSnap,
          session_id: sWed.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_paid: true,
          billing_status: 'paid',
          amount_due: 300,
          amount_received: 300,
          pricing_snapshot: { hourly: 150, unlimited: 750, allow_unlimited: true, is_weekend: false }
        },
        {
          booking_ref: refLegacyUnpaid,
          session_id: sNoSetting.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_paid: false,
          billing_status: 'unpaid',
          pricing_snapshot: null
        },
        {
          booking_ref: refPartial,
          session_id: sSat.id,
          user_id: user.id,
          pax: 2,
          status: 'confirmed',
          is_paid: false,
          billing_status: 'partial',
          amount_received: 180,
          pricing_snapshot: { hourly: 180, unlimited: 1100, allow_unlimited: true, is_weekend: true }
        },
        {
          booking_ref: refSpecial,
          session_id: sSpecial.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_paid: false,
          billing_status: 'unpaid',
          pricing_snapshot: null
        },
        {
          booking_ref: refSelf,
          session_id: sSelf.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_self_service: true,
          is_paid: true,
          billing_status: 'paid',
          amount_due: 1100,
          amount_received: 1100
        },
        {
          booking_ref: refManual,
          session_id: sManual.id,
          user_id: user.id,
          pax: 1,
          status: 'confirmed',
          is_paid: false,
          billing_status: 'unpaid'
        }
      ]
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refSelf,
        user_id: user.id,
        total_amount: 1100,
        amount_due: 1100,
        status: 'verified',
        pricing_snapshot: { hourly: 180, unlimited: 1100, allow_unlimited: true, is_weekend: true },
        deadline_at: new Date('2026-10-10T12:00:00+08:00')
      }
    });

    await prisma.payment.createMany({
      data: [
        {
          payment_no: `PAY-R47I4-1-${runId}`,
          batch_no: `B-R47I4-1-${runId}`,
          booking_ref: refPaidSnap,
          method: 'cash',
          kind: 'charge',
          amount: 300,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          created_at: new Date('2026-10-07T15:00:00+08:00')
        },
        {
          payment_no: `PAY-R47I4-2-${runId}`,
          batch_no: `B-R47I4-2-${runId}`,
          booking_ref: refPartial,
          method: 'linepay',
          kind: 'charge',
          amount: 200,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          created_at: new Date('2026-10-10T15:00:00+08:00')
        },
        {
          payment_no: `PAY-R47I4-3-${runId}`,
          batch_no: `B-R47I4-3-${runId}`,
          booking_ref: refPartial,
          method: 'linepay',
          kind: 'refund',
          amount: 20,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          created_at: new Date('2026-10-10T16:00:00+08:00')
        },
        {
          payment_no: `PAY-R47I4-4-${runId}`,
          batch_no: `B-R47I4-4-${runId}`,
          booking_ref: refSelf,
          method: 'transfer',
          kind: 'charge',
          amount: 1100,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          created_at: new Date('2026-10-11T11:00:00+08:00')
        },
        {
          payment_no: `PAY-R47I4-5-${runId}`,
          batch_no: `B-R47I4-5-${runId}`,
          booking_ref: refPaidSnap,
          method: 'pass',
          kind: 'charge',
          amount: 0,
          status: 'valid',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          pass_json: [{ user_pass_id: pass.id, units: 1, pass_code: passCode }],
          created_at: new Date('2026-10-07T15:05:00+08:00')
        },
        {
          payment_no: `PAY-R47I4-6-${runId}`,
          batch_no: `B-R47I4-6-${runId}`,
          booking_ref: refPaidSnap,
          method: 'cash',
          kind: 'charge',
          amount: 99,
          status: 'voided',
          staff_name: 'tester',
          device_label: '測試',
          breakdown_json: {},
          created_at: new Date('2026-10-07T14:50:00+08:00')
        }
      ]
    });

    // 1. Before snapshot
    await execFileAsync('node', ['scripts/snapshot-bills.mjs', '--from', dWed, '--to', dManual, '--out', beforeFile], {
      cwd: path.resolve(process.cwd())
    });

    // 2. Dry-run does not modify DB
    const dryRes = await runBackfillDayTypes({ client: prisma, from: dWed, to: dManual, apply: false });
    assert.equal(dryRes.mode, 'dry-run');
    assert.equal(dryRes.skipCount, 1); // dManual skipped
    const noSettingBeforeApply = await prisma.dailySetting.findUnique({ where: { date: dateOnly(dNoSetting) } });
    assert.equal(noSettingBeforeApply, null);

    // 3. Apply
    const applyRes = await runBackfillDayTypes({ client: prisma, from: dWed, to: dManual, apply: true });
    assert.equal(applyRes.appliedCount, 6);

    // Verify all 7 dates have expected day_type & source & prices untouched
    const rowsAfter = await prisma.dailySetting.findMany({ where: { date: { in: allDates } } });
    const byD = new Map(rowsAfter.map((r) => [r.date.toISOString().slice(0, 10), r]));
    assert.equal(byD.get(dWed).day_type, 'weekday');
    assert.equal(byD.get(dSpecial).day_type, 'weekday');
    assert.equal(byD.get(dSpecial).hourly_price, 120);
    assert.equal(byD.get(dNoSetting).day_type, 'weekday');
    assert.equal(byD.get(dNoSetting).day_type_source, 'migrated');
    assert.equal(byD.get(dSat).day_type, 'holiday');
    assert.equal(byD.get(dSelf).day_type, 'self');
    assert.equal(byD.get(dNoSess).day_type, 'closed');
    assert.equal(byD.get(dManual).day_type, 'holiday');
    assert.equal(byD.get(dManual).day_type_source, 'manual');

    // 4. Second apply writes 0
    const secondApply = await runBackfillDayTypes({ client: prisma, from: dWed, to: dManual, apply: true });
    assert.equal(secondApply.appliedCount, 0);

    // 5. After snapshot + compare === 完全相同
    await execFileAsync('node', ['scripts/snapshot-bills.mjs', '--from', dWed, '--to', dManual, '--out', afterFile], {
      cwd: path.resolve(process.cwd())
    });
    const cmpOk = await execFileAsync('node', ['scripts/compare-bill-snapshots.mjs', beforeFile, afterFile], {
      cwd: path.resolve(process.cwd())
    });
    assert.equal(cmpOk.stdout.trim(), '完全相同');

    // 6. Mutate one amount_due -> compare prints diff & exits 1
    const mutated = JSON.parse(await fs.readFile(afterFile, 'utf8'));
    mutated.bookings[0].amount_due += 100;
    await fs.writeFile(badFile, JSON.stringify(mutated, null, 2), 'utf8');
    let exitedOne = false;
    try {
      await execFileAsync('node', ['scripts/compare-bill-snapshots.mjs', beforeFile, badFile], {
        cwd: path.resolve(process.cwd())
      });
    } catch (err) {
      exitedOne = err.code === 1 && err.stdout.includes(mutated.bookings[0].booking_ref);
    }
    assert.equal(exitedOne, true);
  } finally {
    await fs.rm(beforeFile, { force: true }).catch(() => {});
    await fs.rm(afterFile, { force: true }).catch(() => {});
    await fs.rm(badFile, { force: true }).catch(() => {});
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.payment.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } });
    await prisma.userPass.deleteMany({ where: { pass_code: passCode } });
    await prisma.passPlan.deleteMany({ where: { code: passPlanCode } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    if (createdSessionIds.length > 0) await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: allDates } } });
    if (prevGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          weekday_hourly_price: prevGlobal.weekday_hourly_price,
          weekday_unlimited_price: prevGlobal.weekday_unlimited_price,
          weekend_hourly_price: prevGlobal.weekend_hourly_price,
          weekend_unlimited_price: prevGlobal.weekend_unlimited_price
        }
      });
    }
  }
});

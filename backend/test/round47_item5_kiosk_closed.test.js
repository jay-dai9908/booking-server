import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { buildSevenDaysSchedule } from '../src/services/kiosk/syncService.js';
import { processKioskAccess } from '../src/services/kiosk/accessService.js';
import { qrKeyFrom, qrCodeFor } from '../src/services/kiosk/sgk1.js';

test('Round 47 Item 5: Closed day kiosk sync mode=closed and access always open_door=false (ENDED for bookings, NOT_FOUND otherwise)', async () => {
  const runId = Date.now();
  const dSelfStr = '2026-12-02';
  const dNormStr = '2026-12-03';
  const dSelfObj = dateOnly(dSelfStr);
  const dNormObj = dateOnly(dNormStr);
  const nowSelf = new Date('2026-12-02T13:00:00+08:00');
  const nowNorm = new Date('2026-12-03T13:00:00+08:00');

  const phoneP = `0955${String(runId).slice(-6)}`;
  const phoneQ = `0956${String(runId).slice(-6)}`;
  const refP = crypto.randomUUID();
  const refQ = crypto.randomUUID();

  const createdSessionIds = [];
  const createdUserIds = [];

  try {
    await prisma.dailySetting.deleteMany({ where: { date: { in: [dSelfObj, dNormObj] } } });

    const ensureSession = async (dObj, start, end) => {
      const ex = await prisma.session.findUnique({
        where: { session_date_start_time: { session_date: dObj, start_time: start } }
      });
      if (ex) {
        if (ex.closed_at) {
          return prisma.session.update({ where: { id: ex.id }, data: { closed_at: null, closed_by: null } });
        }
        return ex;
      }
      const s = await prisma.session.create({
        data: { session_date: dObj, start_time: start, end_time: end, max_capacity: 16 }
      });
      createdSessionIds.push(s.id);
      return s;
    };

    const [sSelf1, sSelf2, sNorm1] = await Promise.all([
      ensureSession(dSelfObj, '13:00', '14:00'),
      ensureSession(dSelfObj, '14:00', '15:00'),
      ensureSession(dNormObj, '13:00', '14:00')
    ]);

    await prisma.dailySetting.createMany({
      data: [
        { date: dSelfObj, is_self_service: true },
        { date: dNormObj, is_self_service: false }
      ]
    });

    const [userP, userQ] = await Promise.all([
      prisma.user.create({ data: { name: `R47P顧客-${runId}`, phone: phoneP, line_user_id: `U_R47P_${runId}` } }),
      prisma.user.create({ data: { name: `R47Q顧客-${runId}`, phone: phoneQ, line_user_id: `U_R47Q_${runId}` } })
    ]);
    createdUserIds.push(userP.id, userQ.id);

    await prisma.reservation.createMany({
      data: [
        {
          booking_ref: refP,
          session_id: sSelf1.id,
          user_id: userP.id,
          pax: 2,
          status: 'confirmed',
          is_self_service: true,
          billing_status: 'paid',
          is_paid: true
        },
        {
          booking_ref: refP,
          session_id: sSelf2.id,
          user_id: userP.id,
          pax: 2,
          status: 'confirmed',
          is_self_service: true,
          billing_status: 'paid',
          is_paid: true
        },
        {
          booking_ref: refQ,
          session_id: sNorm1.id,
          user_id: userQ.id,
          pax: 1,
          status: 'confirmed',
          is_self_service: false
        }
      ]
    });

    await prisma.bookingPrepay.create({
      data: {
        booking_ref: refP,
        user_id: userP.id,
        total_amount: 1600,
        amount_due: 1600,
        status: 'verified',
        deadline_at: new Date('2026-12-01T12:00:00+08:00')
      }
    });

    // 1. Before closing 12/02: sync returns mode: 'self'
    const schedBefore = await buildSevenDaysSchedule(prisma, nowSelf);
    const dayBefore = schedBefore.find((d) => d.date === dSelfStr);
    assert.equal(dayBefore.mode, 'self');

    // 2. Set 12/02 to closed (preserving is_self_service = true, not cancelling P)
    await prisma.dailySetting.update({
      where: { date: dSelfObj },
      data: { day_type: 'closed', day_type_source: 'manual', closed_note: '緊急公休' }
    });

    const schedClosed = await buildSevenDaysSchedule(prisma, nowSelf);
    const dayClosed = schedClosed.find((d) => d.date === dSelfStr);
    assert.equal(dayClosed.mode, 'closed');
    assert.equal(dayClosed.open, null);
    assert.equal(dayClosed.close, null);

    // 3. 12/02 13:00 access with P's valid QR -> ENDED, open_door: false, booking present, no check-in
    const qrKey = qrKeyFrom(process.env.JWT_SECRET);
    const validQrP = qrCodeFor(qrKey, refP, Math.floor(nowSelf.getTime() / 1000)).code;
    let notifyCalls = 0;
    const notifyFn = async () => {
      notifyCalls += 1;
    };

    const qrRes = await processKioskAccess(prisma, {
      method: 'qr',
      payload: validQrP,
      now: nowSelf,
      notifyFn
    });
    assert.equal(qrRes.result, 'ENDED');
    assert.equal(qrRes.open_door, false);
    assert.ok(qrRes.booking);
    assert.equal(qrRes.booking.seats, undefined);
    assert.equal(notifyCalls, 0);

    const pRows = await prisma.reservation.findMany({ where: { booking_ref: refP } });
    assert.ok(pRows.every((r) => r.attendance === null && r.checked_in_at === null));
    const bpCount = await prisma.bookingPerson.count({ where: { booking_ref: refP } });
    assert.equal(bpCount, 0);
    const accessLogs = await prisma.kioskAccessLog.findMany({ where: { booking_ref: refP, result: 'ENDED' } });
    assert.equal(accessLogs.length, 1);

    // 4. 12/02 13:00 access with P's phone -> ENDED, open_door: false
    const phoneRes = await processKioskAccess(prisma, {
      method: 'phone',
      payload: phoneP,
      now: nowSelf,
      notifyFn
    });
    assert.equal(phoneRes.result, 'ENDED');
    assert.equal(phoneRes.open_door, false);

    // 5. Malformed QR -> NOT_FOUND, open_door: false
    const badQrRes = await processKioskAccess(prisma, {
      method: 'qr',
      payload: 'BAD-FORMAT-QR',
      now: nowSelf,
      notifyFn
    });
    assert.equal(badQrRes.result, 'NOT_FOUND');
    assert.equal(badQrRes.open_door, false);

    // 6. Normal day 12/03 set closed with confirmed booking Q -> ENDED (not NORMAL_DAY)
    await prisma.dailySetting.update({
      where: { date: dNormObj },
      data: { day_type: 'closed', day_type_source: 'manual' }
    });
    const validQrQ = qrCodeFor(qrKey, refQ, Math.floor(nowNorm.getTime() / 1000)).code;
    const normClosedRes = await processKioskAccess(prisma, {
      method: 'qr',
      payload: validQrQ,
      now: nowNorm,
      notifyFn
    });
    assert.equal(normClosedRes.result, 'ENDED');
    assert.equal(normClosedRes.open_door, false);

    // 7. Reopen 12/02 to auto -> P's QR succeeds with FIRST_CHECKIN & open_door: true
    await prisma.dailySetting.update({
      where: { date: dSelfObj },
      data: { day_type: null, closed_note: null, day_type_source: 'manual' }
    });
    const reopenRes = await processKioskAccess(prisma, {
      method: 'qr',
      payload: validQrP,
      now: nowSelf,
      notifyFn
    });
    assert.equal(reopenRes.result, 'FIRST_CHECKIN');
    assert.equal(reopenRes.open_door, true);
  } finally {
    await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: { in: [refP, refQ] } } });
    await prisma.kioskAccessLog.deleteMany({ where: { booking_ref: null, result: 'NOT_FOUND', at: nowSelf } });
    await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: [refP, refQ] } } });
    await prisma.bookingPrepay.deleteMany({ where: { booking_ref: { in: [refP, refQ] } } });
    await prisma.reservation.deleteMany({ where: { booking_ref: { in: [refP, refQ] } } });
    if (createdUserIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    if (createdSessionIds.length > 0) await prisma.session.deleteMany({ where: { id: { in: createdSessionIds } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: [dSelfObj, dNormObj] } } });
  }
});

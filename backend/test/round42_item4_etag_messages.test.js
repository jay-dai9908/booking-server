import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { getLive, checkIn, handleTimer } from '../src/controllers/floorController.js';
import { adminCreateReservation, extendReservation } from '../src/controllers/reservationController.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMockReqRes({ body = {}, params = {}, query = {}, headers = {}, user = { id: 1, name: 'R42店員' } } = {}) {
  const req = { body, params, query, headers, user, ip: '127.0.0.1' };
  let statusCode = 200;
  let bodyData = null;
  let ended = false;
  const resHeaders = {};
  const res = {
    status(c) { statusCode = c; return res; },
    setHeader(k, v) { resHeaders[k.toLowerCase()] = v; return res; },
    getHeader(k) { return resHeaders[k.toLowerCase()]; },
    json(d) { bodyData = d; return res; },
    end() { ended = true; return res; },
    getStatusCode() { return statusCode; },
    getBody() { return bodyData; },
    isEnded() { return ended; },
    getHeaders() { return resHeaders; }
  };
  return { req, res };
}

test('Round 42 Item 4: getLive ETag excludes server_now, sets X-Server-Now on 304, and reservation errors are Chinese with codes', async () => {
  const ts = Date.now();
  const dStr = '2099-11-26';
  const d = dateOnly(dStr);
  let layoutId = null;
  let prevGlobalLayoutEnabled = null;
  let createdGlobal = false;
  const createdRefs = [];

  try {
    const existingGs = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (existingGs) {
      prevGlobalLayoutEnabled = existingGs.seat_layout_enabled;
      if (!existingGs.seat_layout_enabled) {
        await prisma.globalSetting.update({ where: { id: 1 }, data: { seat_layout_enabled: true } });
      }
    } else {
      await prisma.globalSetting.create({ data: { id: 1, seat_layout_enabled: true } });
      createdGlobal = true;
    }

    layoutId = await ensureTestPublishedLayout(prisma, {
      name: `R42 Item4 Layout ${ts}`,
      effectiveFrom: dStr,
      effectiveDate: dStr,
      codePrefix: 'A1-',
      seatCount: 1,
      alwaysCreate: true
    });

    await prisma.dailySetting.deleteMany({ where: { date: d } });
    await prisma.dailySetting.create({
      data: { date: d, allow_unlimited: true, hourly_price: 200, unlimited_price: 600 }
    });
    await prisma.session.deleteMany({ where: { session_date: d } });
    const s14 = await prisma.session.create({
      data: { session_date: d, start_time: '14:00', end_time: '15:00', max_capacity: 10 }
    });

    // 1. Seed 1 checked-in guest occupying the sole physical seat A1-1
    const firstRes = createMockReqRes({
      body: {
        name: 'R42先入座',
        pax: 1,
        session_ids: [s14.id],
        isWalkIn: true,
        autoCheckIn: true
      }
    });
    await adminCreateReservation(firstRes.req, firstRes.res);
    assert.equal(firstRes.res.getStatusCode(), 201);
    const firstRef = firstRes.res.getBody().reservation.booking_ref;
    createdRefs.push(firstRef);

    const ciRes = createMockReqRes({
      params: { booking_ref: firstRef },
      body: { seats: ['A1-1'], start_timer: true }
    });
    await checkIn(ciRes.req, ciRes.res);
    assert.equal(ciRes.res.getStatusCode(), 200);

    // Align timer timestamps with test virtual date 2099-11-26T14:00:00+08:00 so elapsed diff stays invariant across :00 -> :15
    await prisma.bookingPerson.updateMany({
      where: { booking_ref: firstRef },
      data: {
        billing_start_at: new Date(`${dStr}T14:00:00+08:00`),
        timer_started_at: new Date(`${dStr}T14:00:00+08:00`)
      }
    });

    // 2. Call getLive twice without DB changes -> 2nd returns 304 + X-Server-Now
    const live1 = createMockReqRes({ query: { date: dStr, now: `${dStr}T14:10:00+08:00` } });
    await getLive(live1.req, live1.res);
    assert.equal(live1.res.getStatusCode(), 200);
    const etag1 = live1.res.getHeader('etag');
    assert.ok(etag1, 'ETag header must be set on 200');
    assert.ok(live1.res.getHeader('x-server-now'), 'X-Server-Now header must be set on 200');

    const live2 = createMockReqRes({
      query: { date: dStr, now: `${dStr}T14:10:15+08:00` },
      headers: { 'if-none-match': etag1 }
    });
    await getLive(live2.req, live2.res);
    assert.equal(live2.res.getStatusCode(), 304, 'Unchanged floor state with different server_now should return 304');
    assert.equal(live2.res.getHeader('x-server-now'), new Date(`${dStr}T14:10:15+08:00`).toISOString());

    // 3. Toggle pause state on a person -> getLive returns 200
    const pauseRes = createMockReqRes({
      params: { booking_ref: firstRef },
      body: { action: 'pause', person_nos: [1], reason: '測試暫停' }
    });
    await handleTimer(pauseRes.req, pauseRes.res);
    assert.equal(pauseRes.res.getStatusCode(), 200);

    const live3 = createMockReqRes({
      query: { date: dStr, now: `${dStr}T14:11:10+08:00` },
      headers: { 'if-none-match': etag1 }
    });
    await getLive(live3.req, live3.res);
    assert.equal(live3.res.getStatusCode(), 200, 'Paused state change must invalidate ETag and return 200');

    // 4. adminCreateReservation without name -> 400 NAME_REQUIRED
    const noName = createMockReqRes({
      body: { name: '   ', pax: 1, session_ids: [s14.id] }
    });
    await adminCreateReservation(noName.req, noName.res);
    assert.equal(noName.res.getStatusCode(), 400);
    assert.equal(noName.res.getBody()?.code, 'NAME_REQUIRED');
    assert.equal(noName.res.getBody()?.error, '請輸入顧客姓名');

    // 5. Only 1 physical seat (occupied) -> walk-in 2 pax -> 400 INSUFFICIENT_SEATS; retry isForceWait: true -> 201 WAIT-n
    const fullFail = createMockReqRes({
      body: { name: 'R42客滿', pax: 2, session_ids: [s14.id], isWalkIn: true, forceSplit: true }
    });
    await adminCreateReservation(fullFail.req, fullFail.res);
    assert.equal(fullFail.res.getStatusCode(), 400);
    assert.equal(fullFail.res.getBody()?.code, 'INSUFFICIENT_SEATS');
    assert.equal(fullFail.res.getBody()?.error, '所選時段的座位不夠');

    const waitOk = createMockReqRes({
      body: { name: 'R42候位', pax: 2, session_ids: [s14.id], isWalkIn: true, isForceWait: true }
    });
    await adminCreateReservation(waitOk.req, waitOk.res);
    assert.equal(waitOk.res.getStatusCode(), 201);
    const waitRef = waitOk.res.getBody()?.reservation?.booking_ref;
    createdRefs.push(waitRef);
    const waitSeats = waitOk.res.getBody()?.reservation?.assigned_seats || [];
    assert.equal(waitSeats.length, 2);
    assert.ok(waitSeats.every(s => String(s).startsWith('WAIT-')), `Expected WAIT-n seats, got ${waitSeats}`);

    // Extend when empty sessions -> SESSIONS_REQUIRED
    const extEmpty = createMockReqRes({ params: { booking_ref: firstRef }, body: { session_ids: [] } });
    await extendReservation(extEmpty.req, extEmpty.res);
    assert.equal(extEmpty.res.getStatusCode(), 400);
    assert.equal(extEmpty.res.getBody()?.code, 'SESSIONS_REQUIRED');
  } finally {
    if (createdRefs.length > 0) {
      await prisma.timerPause.deleteMany({ where: { person: { booking_ref: { in: createdRefs } } } }).catch(() => {});
      await prisma.seatHold.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      const resUsers = await prisma.reservation.findMany({ where: { booking_ref: { in: createdRefs } }, select: { user_id: true } }).catch(() => []);
      const userIdsToDel = [...new Set(resUsers.map(r => r.user_id).filter(Boolean))];
      await prisma.reservation.deleteMany({ where: { booking_ref: { in: createdRefs } } }).catch(() => {});
      if (userIdsToDel.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIdsToDel } } }).catch(() => {});
      }
    }
    await prisma.session.deleteMany({ where: { session_date: d } }).catch(() => {});
    await prisma.dailySetting.deleteMany({ where: { date: d } }).catch(() => {});
    if (layoutId) await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
    if (createdGlobal) {
      await prisma.globalSetting.deleteMany({ where: { id: 1 } }).catch(() => {});
    } else if (prevGlobalLayoutEnabled !== null && prevGlobalLayoutEnabled !== true) {
      await prisma.globalSetting.update({ where: { id: 1 }, data: { seat_layout_enabled: prevGlobalLayoutEnabled } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
});

test('Round 42 Item 4: adminCreateReservation and extendReservation contain no English error strings', () => {
  const ctrlPath = path.resolve(__dirname, '../src/controllers/reservationController.js');
  const src = fs.readFileSync(ctrlPath, 'utf8');

  const extractFnBlock = (fnName) => {
    const startIdx = src.indexOf(`export const ${fnName} =`);
    assert.ok(startIdx >= 0, `Could not find ${fnName}`);
    const nextExportIdx = src.indexOf('\nexport const ', startIdx + 20);
    return nextExportIdx > startIdx ? src.slice(startIdx, nextExportIdx) : src.slice(startIdx);
  };

  const englishErrorRegex = /error\s*:\s*['"`][A-Za-z]/;
  for (const fnName of ['adminCreateReservation', 'extendReservation']) {
    const block = extractFnBlock(fnName);
    const match = block.match(englishErrorRegex);
    assert.equal(match, null, `Found English error string in ${fnName}: ${match?.[0]}`);
  }
});

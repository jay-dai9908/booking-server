import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly } from '../../shared/time.js';
import { ensureTestPublishedLayout, cleanupTestPublishedLayout } from './helpers/seedTestLayout.js';
import { adminCreateReservation } from '../src/controllers/reservationController.js';
import { collectPayment } from '../src/services/billing/billService.js';
import { claimNextJob, queuePrintJob } from '../src/services/print/printService.js';
import { localClaimJobHandler, reportLocalJob } from '../src/controllers/printController.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { id: 1, name: 'R38店員' } } = {}) {
  const req = {
    body,
    params,
    query,
    user,
    headers: { 'x-device-label': 'R38櫃檯平板' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let bodyData = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(d) { bodyData = d; return res; },
    getStatusCode() { return statusCode; },
    getBody() { return bodyData; }
  };
  return { req, res };
}

test('Round 38 Item 5: local-claim exclusive lock prevents print station double print and guards /local reporting', async () => {
  const ts = Date.now();
  const testDateStr = '2099-10-15';
  const testDate = dateOnly(testDateStr);
  let bookingRef = null;
  let user = null;
  let session = null;
  let station = null;
  let layoutId = null;
  let savedGlobal = null;
  const createdJobIds = [];

  try {
    savedGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { print_enabled: true, auto_print_receipt: true, auto_print_summary: false },
      create: { id: 1, print_enabled: true, auto_print_receipt: true, auto_print_summary: false }
    });

    layoutId = await ensureTestPublishedLayout(prisma, {
      name: 'R38 Item5 Layout',
      effectiveFrom: '2020-01-01',
      effectiveDate: testDateStr,
      codePrefix: 'D',
      seatCount: 8
    });

    await prisma.session.deleteMany({ where: { session_date: testDate } });
    session = await prisma.session.create({
      data: { session_date: testDate, start_time: '14:00', end_time: '16:00', max_capacity: 10 }
    });

    user = await prisma.user.create({
      data: { line_user_id: `manual_r38_5_${ts}`, name: 'R38列印客', phone: `0985${String(ts).slice(-6)}` }
    });

    station = await prisma.printStation.create({
      data: {
        name: `R38站_${ts}`,
        secret_hash: `hash_${ts}`,
        is_active: true,
        is_default: false,
        accepting: true
      }
    });

    // Clear any leftover queued jobs from prior tests so claimNextJob only sees our jobs
    const { req: crReq, res: crRes } = createMockReqRes({
      body: {
        session_ids: [session.id],
        pax: 1,
        name: user.name,
        phone: user.phone,
        isForceWait: true
      }
    });
    await adminCreateReservation(crReq, crRes);
    assert.equal(crRes.getStatusCode(), 201);
    bookingRef = crRes.getBody().reservation.booking_ref;

    const colRes = await collectPayment(
      bookingRef,
      {
        client_batch_id: `r38-5-${ts}`,
        person_nos: [1],
        method: 'cash',
        print: true
      },
      { id: 1, name: 'R38店員' },
      { device_label: 'R38櫃檯平板' }
    );
    assert.ok(colRes.print_jobs.length >= 1);
    const job1 = colRes.print_jobs[0];
    createdJobIds.push(job1.id);
    const pay1 = colRes.payments[0];
    assert.equal(job1.status, 'queued');

    // 1. Call local-claim on queued job1 -> 200
    {
      const { req, res } = createMockReqRes({ params: { id: String(job1.id) } });
      await localClaimJobHandler(req, res);
      assert.equal(res.getStatusCode(), 200);
      assert.equal(res.getBody().job.status, 'claimed');
      assert.match(res.getBody().job.printed_by, /^local:/);
    }

    // 2. Station polls claimNextJob(station.id, 0) -> MUST NOT steal locally claimed job1
    const stationPoll = await claimNextJob(station.id, 0);
    assert.ok(!stationPoll || stationPoll.id !== job1.id, 'Station must not claim a locally claimed job');

    // 3. Report local print succeeded -> job becomes printed & payment receipt_status becomes printed
    {
      const { req, res } = createMockReqRes({
        params: { id: String(job1.id) },
        body: { result: 'printed', via: 'browser' }
      });
      await reportLocalJob(req, res);
      assert.equal(res.getStatusCode(), 200);
      assert.equal(res.getBody().job.status, 'printed');
      assert.match(res.getBody().job.printed_by, /^local:/);

      const dbPay = await prisma.payment.findUnique({ where: { id: pay1.id } });
      assert.equal(dbPay.receipt_status, 'printed');
    }

    // 4. Duplicate local-claim on already printed job1 -> 409
    {
      const { req, res } = createMockReqRes({ params: { id: String(job1.id) } });
      await localClaimJobHandler(req, res);
      assert.equal(res.getStatusCode(), 409);
      assert.match(res.getBody().error, /列印站已經在印或已印出/);
    }

    // 5. Station claims a queued job2 first -> local-claim on job2 returns 409
    const job2 = await queuePrintJob({
      type: 'receipt',
      booking_ref: bookingRef,
      payment_id: pay1.id,
      user: { id: 1, name: 'R38店員' },
      device: { device_label: 'R38櫃檯' },
      reprint_of_id: job1.id
    });
    createdJobIds.push(job2.id);

    const stationGrabbed = await claimNextJob(station.id, 0);
    assert.ok(stationGrabbed && stationGrabbed.id === job2.id);

    {
      const { req, res } = createMockReqRes({ params: { id: String(job2.id) } });
      await localClaimJobHandler(req, res);
      assert.equal(res.getStatusCode(), 409);
    }

    // 6. Calling /local without prior local-claim on a queued or station-claimed job -> 409
    const job3 = await queuePrintJob({
      type: 'receipt',
      booking_ref: bookingRef,
      payment_id: pay1.id,
      user: { id: 1, name: 'R38店員' },
      device: { device_label: 'R38櫃檯' },
      reprint_of_id: job1.id
    });
    createdJobIds.push(job3.id);

    {
      const { req, res } = createMockReqRes({
        params: { id: String(job3.id) },
        body: { result: 'printed', via: 'browser' }
      });
      await reportLocalJob(req, res);
      assert.equal(res.getStatusCode(), 409);
    }
    {
      const { req, res } = createMockReqRes({
        params: { id: String(job2.id) },
        body: { result: 'printed', via: 'browser' }
      });
      await reportLocalJob(req, res);
      assert.equal(res.getStatusCode(), 409);
    }
  } finally {
    if (createdJobIds.length) {
      await prisma.printJob.deleteMany({ where: { id: { in: createdJobIds } } });
    }
    if (bookingRef) {
      await prisma.payment.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.bookingPerson.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.bookingEquipment.deleteMany({ where: { booking_ref: bookingRef } });
      await prisma.reservation.deleteMany({ where: { booking_ref: bookingRef } });
    }
    if (session) await prisma.session.deleteMany({ where: { id: session.id } });
    if (station) await prisma.printStation.deleteMany({ where: { id: station.id } });
    if (user) await prisma.user.deleteMany({ where: { id: user.id } });
    if (layoutId) await cleanupTestPublishedLayout(prisma, layoutId).catch(() => {});
    if (savedGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          print_enabled: savedGlobal.print_enabled,
          auto_print_receipt: savedGlobal.auto_print_receipt,
          auto_print_summary: savedGlobal.auto_print_summary
        }
      }).catch(() => {});
    }
  }
});

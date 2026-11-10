import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { updateGlobalSetting } from '../src/controllers/dailySettingController.js';
import { postCollect } from '../src/controllers/billingController.js';
import {
  createJob,
  retryJob,
  reportLocalJob,
  testStation,
  stationClaim,
  stationHeartbeat
} from '../src/controllers/printController.js';
import { dateOnly } from '../../shared/time.js';

function createMockReqRes({ params = {}, query = {}, body = {}, user = { name: '店長測試員', id: 1 }, printStation = null } = {}) {
  const req = {
    params,
    query,
    body,
    user,
    printStation,
    headers: { 'user-agent': 'NodeTestAgent' },
    ip: '127.0.0.1'
  };
  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    }
  };

  return { req, res };
}

test('Round 18b Item 4: Master print_enabled switch in global settings', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef1 = `R18B4-${runId}-01`;
  const bookingRef2 = `R18B4-${runId}-02`;
  const sessionDate = dateOnly('2026-11-21');
  const jobNo1 = `P-R18B4-${runId}-01`;
  const jobNo2 = `P-R18B4-${runId}-02`;

  const origSetting = await prisma.globalSetting.findFirst();
  const origPrintEnabled = origSetting?.print_enabled ?? true;

  const testUser = await prisma.user.upsert({
    where: { line_user_id: `user_r18b4_${runId}` },
    update: {},
    create: {
      line_user_id: `user_r18b4_${runId}`,
      name: '列印開關測試員',
      phone: '0912111222'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '15:00'
      }
    },
    update: {},
    create: {
      session_date: sessionDate,
      start_time: '15:00',
      end_time: '17:00',
      max_capacity: 16
    }
  });

  const cleanup = async () => {
    // Restore globalSetting print_enabled
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { print_enabled: origPrintEnabled },
      create: { id: 1, print_enabled: origPrintEnabled }
    }).catch(() => {});

    await prisma.printStation.deleteMany({
      where: { name: '測試站' }
    }).catch(() => {});

    await prisma.printJob.deleteMany({
      where: { job_no: { in: [jobNo1, jobNo2] } }
    }).catch(() => {});

    await prisma.printJob.deleteMany({
      where: { booking_ref: { startsWith: `R18B4-${runId}` } }
    }).catch(() => {});

    await prisma.payment.deleteMany({
      where: { booking_ref: { startsWith: `R18B4-${runId}` } }
    }).catch(() => {});

    await prisma.bookingPerson.deleteMany({
      where: { booking_ref: { startsWith: `R18B4-${runId}` } }
    }).catch(() => {});

    await prisma.reservation.deleteMany({
      where: { user_id: testUser.id }
    }).catch(() => {});

    await prisma.user.delete({
      where: { id: testUser.id }
    }).catch(() => {});
  };

  t.after(cleanup);

  // Setup Reservation 1
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef1,
      user_id: testUser.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['1-1'],
      status: 'confirmed'
    }
  });
  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef1,
      person_no: 1,
      seat_code: '1-1',
      status: 'active'
    }
  });

  // Setup Reservation 2
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef2,
      user_id: testUser.id,
      session_id: session.id,
      pax: 1,
      assigned_seats: ['1-2'],
      status: 'confirmed'
    }
  });
  await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef2,
      person_no: 1,
      seat_code: '1-2',
      status: 'active'
    }
  });

  await t.test('1. 關閉時選擇取消佇列，等待中/已領取的單變成 cancelled，異動紀錄多一筆', async () => {
    // Create queued and claimed test jobs
    const qJob = await prisma.printJob.create({
      data: {
        job_no: jobNo1,
        title: '佇列中單據',
        type: 'receipt',
        commands_json: [],
        status: 'queued',
        requested_by_name: '系統',
        requested_device: 'POS-01'
      }
    });

    const cJob = await prisma.printJob.create({
      data: {
        job_no: jobNo2,
        title: '已領取單據',
        type: 'receipt',
        commands_json: [],
        status: 'claimed',
        claimed_at: new Date(),
        requested_by_name: '系統',
        requested_device: 'POS-01'
      }
    });

    const { req, res } = createMockReqRes({
      body: {
        print_enabled: false,
        cancel_pending_jobs: true
      }
    });

    await updateGlobalSetting(req, res);
    assert.equal(res.getStatusCode(), 200);

    // Verify jobs are cancelled
    const updatedQ = await prisma.printJob.findUnique({ where: { id: qJob.id } });
    const updatedC = await prisma.printJob.findUnique({ where: { id: cJob.id } });
    assert.equal(updatedQ.status, 'cancelled', 'queued job 應變為 cancelled');
    assert.equal(updatedC.status, 'cancelled', 'claimed job 應變為 cancelled');

    // Verify accounting event was created
    const event = await prisma.accountingEvent.findFirst({
      where: { event_type: 'print_jobs_cancelled' },
      orderBy: { id: 'desc' }
    });
    assert.ok(event, '應有一筆 print_jobs_cancelled 異動紀錄');
    assert.ok(event.summary.includes('關閉列印'), '異動紀錄 summary 應包含說明');
  });

  await t.test('2. 關閉後收款成功，沒有新的列印單；claim 回 null；POST /print/jobs 回 409', async () => {
    // Verify print is disabled
    const setting = await prisma.globalSetting.findFirst();
    assert.equal(setting.print_enabled, false, 'globalSetting.print_enabled 應為 false');

    // 2a. POST /print/jobs 回 409
    const { req: createReq, res: createRes } = createMockReqRes({
      body: {
        type: 'test',
        title: '測試列印'
      }
    });
    await createJob(createReq, createRes);
    assert.equal(createRes.getStatusCode(), 409, 'createJob 應回傳 409');
    assert.ok(
      createRes.getResponseData()?.error?.includes('列印已關閉'),
      '應提示列印已關閉'
    );

    // 2a-2. POST /print/jobs/:id/retry 回 409
    const { req: retryReq, res: retryRes } = createMockReqRes({
      params: { id: 1 }
    });
    await retryJob(retryReq, retryRes);
    assert.equal(retryRes.getStatusCode(), 409, 'retryJob 應回傳 409');
    assert.ok(retryRes.getResponseData()?.error?.includes('列印已關閉'));

    // 2a-3. POST /print/jobs/:id/local 回 409
    const { req: localReq, res: localRes } = createMockReqRes({
      params: { id: 1 },
      body: { result: 'printed' }
    });
    await reportLocalJob(localReq, localRes);
    assert.equal(localRes.getStatusCode(), 409, 'reportLocalJob 應回傳 409');
    assert.ok(localRes.getResponseData()?.error?.includes('列印已關閉'));

    // 2a-4. POST /print/stations/:id/test 回 409
    const { req: testReq, res: testRes } = createMockReqRes({
      params: { id: 1 }
    });
    await testStation(testReq, testRes);
    assert.equal(testRes.getStatusCode(), 409, 'testStation 應回傳 409');
    assert.ok(testRes.getResponseData()?.error?.includes('列印已關閉'));

    // 2b. stationClaim 回 { job: null }
    const { req: claimReq, res: claimRes } = createMockReqRes({
      query: { wait: '0' },
      printStation: { id: 999 }
    });
    await stationClaim(claimReq, claimRes);
    assert.equal(claimRes.getStatusCode(), 200);
    assert.equal(claimRes.getResponseData()?.job, null, 'claim 應回傳 job: null');

    // 2b-2. stationHeartbeat 回應 print_enabled: false
    const testStationRecord = await prisma.printStation.create({
      data: {
        name: '測試站',
        secret_hash: 'test_hash',
        accepting: true
      }
    });
    const { req: hbReq, res: hbRes } = createMockReqRes({
      body: { printer_state: 'normal', app_version: '1.0.0' },
      printStation: testStationRecord
    });
    await stationHeartbeat(hbReq, hbRes);
    assert.equal(hbRes.getStatusCode(), 200);
    assert.equal(hbRes.getResponseData()?.print_enabled, false, 'heartbeat 應回傳 print_enabled: false');
    await prisma.printStation.delete({ where: { id: testStationRecord.id } }).catch(() => {});

    // 2c. 收款成功但沒有新列印單
    const { req: collectReq, res: collectRes } = createMockReqRes({
      params: { booking_ref: bookingRef1 },
      body: {
        person_nos: [1],
        method: 'cash',
        amount: 200,
        print: true
      }
    });
    await postCollect(collectReq, collectRes);
    assert.equal(collectRes.getStatusCode(), 200, '收款應回傳 200 成功');

    const collectData = collectRes.getResponseData();
    assert.ok(Array.isArray(collectData?.print_jobs), 'print_jobs 應為陣列');
    assert.equal(collectData.print_jobs.length, 0, 'print_enabled 為 false 時不應產生 print_jobs');

    const printJobsInDb = await prisma.printJob.findMany({
      where: { booking_ref: bookingRef1 }
    });
    assert.equal(printJobsInDb.length, 0, '資料庫中不應有該訂單的列印單');
  });

  await t.test('3. 重新開啟後，收款會正常出單', async () => {
    // Enable printing again
    const { req: enableReq, res: enableRes } = createMockReqRes({
      body: {
        print_enabled: true
      }
    });
    await updateGlobalSetting(enableReq, enableRes);
    assert.equal(enableRes.getStatusCode(), 200);

    const setting = await prisma.globalSetting.findFirst();
    assert.equal(setting.print_enabled, true, 'globalSetting.print_enabled 應為 true');

    // Collect on Booking 2
    const { req: collectReq2, res: collectRes2 } = createMockReqRes({
      params: { booking_ref: bookingRef2 },
      body: {
        person_nos: [1],
        method: 'cash',
        amount: 200,
        print: true
      }
    });
    await postCollect(collectReq2, collectRes2);
    assert.equal(collectRes2.getStatusCode(), 200, '收款應回傳 200 成功');

    const collectData2 = collectRes2.getResponseData();
    assert.ok(collectData2?.print_jobs?.length > 0, '重新開啟後收款應產生列印工作');

    const printJobsInDb2 = await prisma.printJob.findMany({
      where: { booking_ref: bookingRef2 }
    });
    assert.ok(printJobsInDb2.length > 0, '資料庫中應有該訂單的列印工作');
  });
});

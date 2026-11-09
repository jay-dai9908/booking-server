import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { markJobPrinted } from '../src/controllers/printController.js';

function createMockReqRes({ params = {}, body = {}, user = { name: '店長測試員', id: 1 } } = {}) {
  const req = {
    params,
    body,
    user,
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

test('Round 15 Item 3: markJobPrinted controller verification', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const jobNo1 = `P-R15-${runId}-01`;
  const jobNo2 = `P-R15-${runId}-02`;

  const cleanup = async () => {
    await prisma.printJob.deleteMany({
      where: { job_no: { in: [jobNo1, jobNo2, 'P-TEST-R15-01', 'P-TEST-R15-02'] } }
    }).catch(() => {});
  };

  await cleanup();
  t.after(cleanup);

  await t.test('1. 租約內的單回 409', async () => {
    const jobWithinLease = await prisma.printJob.create({
      data: {
        job_no: jobNo1,
        title: '測試單據(租約內)',
        type: 'receipt',
        commands_json: [],
        status: 'claimed',
        claimed_at: new Date(),
        lease_until: new Date(Date.now() + 60000),
        requested_by_name: '系統',
        requested_device: 'POS-01'
      }
    });

    const { req, res } = createMockReqRes({ params: { id: String(jobWithinLease.id) } });
    await markJobPrinted(req, res);

    assert.equal(res.getStatusCode(), 409, '租約內的單據應回傳 409');
    assert.ok(
      res.getResponseData()?.error?.includes('租約尚未過期'),
      `應提示租約尚未過期，實際回傳: ${JSON.stringify(res.getResponseData())}`
    );

    // Verify job in DB is still claimed
    const dbJob = await prisma.printJob.findUnique({ where: { id: jobWithinLease.id } });
    assert.equal(dbJob.status, 'claimed');
  });

  await t.test('2. 超過租約的單成功，異動紀錄多一筆', async () => {
    const eventsCountBefore = await prisma.accountingEvent.count({
      where: { summary: `手動標記已印 #${jobNo2}` }
    });
    assert.equal(eventsCountBefore, 0);

    const jobExpiredLease = await prisma.printJob.create({
      data: {
        job_no: jobNo2,
        title: '測試單據(過期)',
        type: 'receipt',
        commands_json: [],
        status: 'claimed',
        claimed_at: new Date(Date.now() - 120000),
        lease_until: new Date(Date.now() - 30000),
        requested_by_name: '系統',
        requested_device: 'POS-01'
      }
    });

    const { req, res } = createMockReqRes({ params: { id: String(jobExpiredLease.id) } });
    await markJobPrinted(req, res);

    assert.equal(res.getStatusCode(), 200, '超過租約的單據應回傳 200 成功');
    assert.equal(res.getResponseData()?.success, true);
    assert.equal(res.getResponseData()?.job?.status, 'printed');

    // Verify in DB
    const dbJob = await prisma.printJob.findUnique({ where: { id: jobExpiredLease.id } });
    assert.equal(dbJob.status, 'printed');
    assert.ok(dbJob.printed_at);

    // Verify audit log
    const eventsCountAfter = await prisma.accountingEvent.count({
      where: { summary: `手動標記已印 #${jobNo2}` }
    });
    assert.equal(eventsCountAfter, 1, '異動紀錄應多一筆');

    const ev = await prisma.accountingEvent.findFirst({
      where: { summary: `手動標記已印 #${jobNo2}` }
    });
    assert.equal(ev.category, 'print');
    assert.equal(ev.print_job_id, jobExpiredLease.id);
  });

  await t.test('3. 已印的單回 409', async () => {
    const jobPrinted = await prisma.printJob.findUnique({ where: { job_no: jobNo2 } });
    assert.equal(jobPrinted.status, 'printed');

    const { req, res } = createMockReqRes({ params: { id: String(jobPrinted.id) } });
    await markJobPrinted(req, res);

    assert.equal(res.getStatusCode(), 409, '已印的單據應回傳 409');
    assert.ok(
      res.getResponseData()?.error?.includes('非 claimed 狀態'),
      `應提示非 claimed 狀態無法標記，實際回傳: ${JSON.stringify(res.getResponseData())}`
    );
  });
});

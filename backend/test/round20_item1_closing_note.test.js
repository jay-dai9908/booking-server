import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { postClosing } from '../src/controllers/accountingController.js';
import { toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ body = {}, user = { name: '日結測試員', id: 1 } } = {}) {
  const req = {
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

test('Round 20 Item 1: Cash closing note validation on cash difference', async (t) => {
  const todayStr = toTaipeiDateString(new Date());
  const createdClosingIds = [];

  t.after(async () => {
    if (createdClosingIds.length > 0) {
      await prisma.printJob.deleteMany({
        where: { closing_id: { in: createdClosingIds } }
      }).catch(() => {});
      await prisma.cashClosing.deleteMany({
        where: { id: { in: createdClosingIds } }
      }).catch(() => {});
    }
  });

  const floatAmount = 2000;
  // Case 1: Difference exists, note is empty -> 422
  {
    const { req, res } = createMockReqRes({
      body: {
        date: todayStr,
        float_amount: floatAmount,
        counted_cash: floatAmount - 100, // discrepancy of -100
        note: '',
        print: false
      }
    });

    await postClosing(req, res);
    assert.equal(res.getStatusCode(), 422, '有差額且沒備註應回傳 422');
    const data = res.getResponseData();
    assert.equal(data.error, '有差額，請先填寫備註');
  }

  // Case 1b: Difference exists, note is whitespace only -> 422
  {
    const { req, res } = createMockReqRes({
      body: {
        date: todayStr,
        float_amount: floatAmount,
        counted_cash: floatAmount + 50,
        note: '   ',
        print: false
      }
    });

    await postClosing(req, res);
    assert.equal(res.getStatusCode(), 422, '有差額且備註全為空白應回傳 422');
  }

  // Case 2: Difference exists, note is provided -> 200 success
  {
    const { req, res } = createMockReqRes({
      body: {
        date: todayStr,
        float_amount: floatAmount,
        counted_cash: floatAmount - 100,
        note: '少收100元差額已補入',
        print: false
      }
    });

    await postClosing(req, res);
    assert.equal(res.getStatusCode(), 200, '有差額且有備註應成功完成交班');
    const data = res.getResponseData();
    assert.ok(data.success);
    assert.ok(data.closing?.id);
    createdClosingIds.push(data.closing.id);
    assert.equal(data.closing.note, '少收100元差額已補入');
    assert.equal(data.closing.difference, -100);
  }

  // Case 3: No difference, note is empty -> 200 success
  {
    const { req, res } = createMockReqRes({
      body: {
        date: todayStr,
        float_amount: floatAmount,
        counted_cash: floatAmount, // exact match
        note: '',
        print: false
      }
    });

    await postClosing(req, res);
    assert.equal(res.getStatusCode(), 200, '沒差額不用備註也應成功完成交班');
    const data = res.getResponseData();
    assert.ok(data.success);
    assert.ok(data.closing?.id);
    createdClosingIds.push(data.closing.id);
    assert.equal(data.closing.difference, 0);
  }
});

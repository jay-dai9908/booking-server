import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import { batchUpdateDailySettings } from '../src/controllers/dailySettingController.js';

function createMockReqRes({ body = {}, user = { id: 903, name: 'R43測試店長', role: 'admin', isSuperAdmin: true, permissions: ['all'] } } = {}) {
  const req = { body, params: {}, query: {}, user, headers: {}, ip: '127.0.0.1' };
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

test('Round 43 Item 3: batchUpdateDailySettings treats null/empty as unchanged, supports clear flags and allow_unlimited, and rejects past date price edits with 422', async () => {
  const todayStr = toTaipeiDateString(new Date());
  const yestStr = toTaipeiDateString(new Date(Date.now() - 86400000));
  const futureStr = toTaipeiDateString(new Date(Date.now() + 20 * 86400000));
  const yestDate = dateOnly(yestStr);
  const futureDate = dateOnly(futureStr);

  const origYest = await prisma.dailySetting.findUnique({ where: { date: yestDate } });

  try {
    await prisma.dailySetting.upsert({
      where: { date: futureDate },
      update: { hourly_price: 120, unlimited_price: 600, allow_unlimited: true },
      create: { date: futureDate, hourly_price: 120, unlimited_price: 600, allow_unlimited: true }
    });
    await prisma.dailySetting.upsert({
      where: { date: yestDate },
      update: { hourly_price: 110, unlimited_price: 580, allow_unlimited: true },
      create: { date: yestDate, hourly_price: 110, unlimited_price: 580, allow_unlimited: true }
    });

    // 1) Batch with hourly_price: null, unlimited_price: 700 -> hourly_price stays 120!
    const r1 = createMockReqRes({
      body: { dates: [futureStr], hourly_price: null, unlimited_price: 700 }
    });
    await batchUpdateDailySettings(r1.req, r1.res);
    assert.equal(r1.res.getStatusCode(), 200);
    let dRow = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
    assert.equal(dRow.hourly_price, 120, 'null hourly_price in batch must leave existing hourly_price 120 unchanged');
    assert.equal(dRow.unlimited_price, 700);

    // 2) clear_hourly_price: true clears hourly_price -> null while unlimited_price stays 700
    const r2 = createMockReqRes({
      body: { dates: [futureStr], clear_hourly_price: true }
    });
    await batchUpdateDailySettings(r2.req, r2.res);
    assert.equal(r2.res.getStatusCode(), 200);
    dRow = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
    assert.equal(dRow.hourly_price, null);
    assert.equal(dRow.unlimited_price, 700);

    // 3) allow_unlimited: false leaves unlimited_price untouched
    const r3 = createMockReqRes({
      body: { dates: [futureStr], allow_unlimited: false }
    });
    await batchUpdateDailySettings(r3.req, r3.res);
    assert.equal(r3.res.getStatusCode(), 200);
    dRow = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
    assert.equal(dRow.allow_unlimited, false);
    assert.equal(dRow.unlimited_price, 700);

    // 4) Including yesterday while changing price -> 422 listing yesterday; neither future nor yesterday mutated
    assert.ok(yestStr < todayStr);
    const r4 = createMockReqRes({
      body: { dates: [yestStr, futureStr], hourly_price: 200 }
    });
    await batchUpdateDailySettings(r4.req, r4.res);
    assert.equal(r4.res.getStatusCode(), 422);
    assert.ok(JSON.stringify(r4.res.getBody()).includes(yestStr), '422 response must list past date');

    const yRowAfter = await prisma.dailySetting.findUnique({ where: { date: yestDate } });
    assert.equal(yRowAfter.hourly_price, 110);
    dRow = await prisma.dailySetting.findUnique({ where: { date: futureDate } });
    assert.equal(dRow.hourly_price, null);

    // 5) Non-numeric price -> 422
    const r5 = createMockReqRes({
      body: { dates: [futureStr], hourly_price: 'abc' }
    });
    await batchUpdateDailySettings(r5.req, r5.res);
    assert.equal(r5.res.getStatusCode(), 422);
  } finally {
    await prisma.dailySetting.deleteMany({ where: { date: futureDate } }).catch(() => {});
    if (origYest) {
      await prisma.dailySetting.update({
        where: { date: yestDate },
        data: {
          hourly_price: origYest.hourly_price,
          unlimited_price: origYest.unlimited_price,
          allow_unlimited: origYest.allow_unlimited
        }
      }).catch(() => {});
    } else {
      await prisma.dailySetting.deleteMany({ where: { date: yestDate } }).catch(() => {});
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getGlobalSetting, updateGlobalSetting } from '../src/controllers/dailySettingController.js';

function mockReq(body = {}, query = {}, user = { id: 1, name: '測試管理員', role: 'admin' }) {
  return { body, query, user };
}

function mockRes() {
  const res = {
    statusCode: 200,
    data: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.data = payload;
      return this;
    },
    getResponseData() {
      return this.data;
    }
  };
  return res;
}

test('Round 9 Section 2: Configurable booking note chips in backend', async (t) => {
  // Reset GlobalSetting id=1
  await prisma.globalSetting.upsert({
    where: { id: 1 },
    update: {
      booking_note_chips: ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起']
    },
    create: {
      id: 1,
      booking_note_chips: ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起']
    }
  });

  await t.test('1. getGlobalSetting returns default booking_note_chips', async () => {
    const req = mockReq();
    const res = mockRes();
    await getGlobalSetting(req, res);
    assert.equal(res.statusCode, 200);
    const data = res.getResponseData();
    assert.ok(Array.isArray(data.booking_note_chips), 'booking_note_chips must be an array');
    assert.deepEqual(data.booking_note_chips, ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起']);
  });

  await t.test('2. updateGlobalSetting updates chips, enforces <=12 chars & <=8 items, and logs audit', async () => {
    const rawChips = [
      '第一次玩',
      '慶生',
      '需要教學',
      '這是一個超過十二個中文字的選項長度會被切斷',
      '5', '6', '7', '8', '9_will_be_dropped'
    ];
    const req = mockReq({ booking_note_chips: rawChips });
    const res = mockRes();
    await updateGlobalSetting(req, res);
    assert.equal(res.statusCode, 200);

    const updated = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    assert.ok(Array.isArray(updated.booking_note_chips));
    assert.equal(updated.booking_note_chips.length, 8, 'Max 8 items should be preserved');
    assert.equal(updated.booking_note_chips[1], '慶生');
    assert.equal(updated.booking_note_chips[2], '需要教學');
    assert.equal(updated.booking_note_chips[3], '這是一個超過十二個中文字'); // 12 chars

    // Verify audit log
    const event = await prisma.accountingEvent.findFirst({
      where: { event_type: '設定變更', summary: '更新預約備註快速選項' },
      orderBy: { id: 'desc' }
    });
    assert.ok(event, 'Audit log event must be recorded');
    assert.equal(event.category, 'setting');
  });
});

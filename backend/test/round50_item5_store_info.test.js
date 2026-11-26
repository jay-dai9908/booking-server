import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import prisma from '../src/prismaClient.js';
import { generateToken } from '../src/middlewares/authMiddleware.js';
import dailySettingsRoutes from '../src/routes/dailySettings.js';

function startLocalApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/daily-settings', dailySettingsRoutes);
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

test('Round 50 Item 5: store info, cancel policy & privacy notice validation and GlobalSetting persistence', async () => {
  const ts = Date.now();
  let admin = null;
  let prevRow = null;
  let srv = null;

  try {
    prevRow = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    admin = await prisma.adminUser.create({
      data: {
        name: 'R50 StoreInfo Admin',
        password: `r50si_${ts}`,
        role: 'admin',
        is_active: true,
        permissions: ['settings']
      }
    });
    const adminToken = generateToken({
      id: admin.id,
      name: admin.name,
      role: 'admin',
      token_version: admin.token_version,
      typ: 'admin'
    });

    srv = await startLocalApp();
    const putGlobal = (body) =>
      fetch(`${srv.baseUrl}/api/daily-settings/global`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`
        },
        body: JSON.stringify(body)
      });

    // 1. Reject non-https map url & javascript URI
    for (const badUrl of ['http://maps.example.com', 'javascript:alert(1)', 'https://bad url']) {
      const res = await putGlobal({ store_map_url: badUrl });
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.equal(data.field, 'store_map_url');
    }

    // 2. Reject length limits (100 / 100 / 300 / 1000 / 2000)
    const lengthCases = [
      ['store_address', '測試'.repeat(51)], // 102 > 100
      ['store_hours_text', '時'.repeat(101)],
      ['store_map_url', `https://maps.google.com/?q=${'a'.repeat(280)}`], // > 300
      ['cancel_policy_text', '規'.repeat(1001)],
      ['privacy_notice_text', '隱'.repeat(2001)],
    ];
    for (const [field, val] of lengthCases) {
      const res = await putGlobal({ [field]: val });
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.equal(data.field, field);
    }

    // 3. Valid save + GET /global verification
    const validPayload = {
      store_phone: '02-0000-0000',
      store_address: '測試市測試路 1 號',
      store_map_url: 'https://maps.google.com/?q=shiguang',
      store_hours_text: '週二～週日 12:00-21:00',
      cancel_policy_text: '自訂取消規則測試內容',
      privacy_notice_text: '自訂隱私權與電話說明測試內容'
    };
    const okRes = await putGlobal(validPayload);
    assert.equal(okRes.status, 200);

    const getRes = await fetch(`${srv.baseUrl}/api/daily-settings/global`);
    assert.equal(getRes.status, 200);
    const loaded = await getRes.json();
    assert.equal(loaded.store_phone, '02-0000-0000');
    assert.equal(loaded.store_address, '測試市測試路 1 號');
    assert.equal(loaded.store_map_url, 'https://maps.google.com/?q=shiguang');
    assert.equal(loaded.store_hours_text, '週二～週日 12:00-21:00');
    assert.equal(loaded.cancel_policy_text, '自訂取消規則測試內容');
    assert.equal(loaded.privacy_notice_text, '自訂隱私權與電話說明測試內容');
  } finally {
    if (srv) await srv.close();
    if (prevRow) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          store_phone: prevRow.store_phone,
          store_address: prevRow.store_address,
          store_map_url: prevRow.store_map_url,
          store_hours_text: prevRow.store_hours_text,
          cancel_policy_text: prevRow.cancel_policy_text,
          privacy_notice_text: prevRow.privacy_notice_text
        }
      });
    }
    if (admin) await prisma.adminUser.deleteMany({ where: { id: admin.id } });
  }
});

// backend/test/round27_item1_floor_map.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { updateLayoutDraft, publishLayout } from '../src/controllers/seatLayoutController.js';
import { getFloorMapFileHandler } from '../src/controllers/kioskController.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';

function createMockReqRes({ body = {}, params = {}, query = {}, user = { name: '店長', id: 1, role: 'admin', permissions: ['all'] } } = {}) {
  const req = { body, params, query, user, headers: {} };
  let statusCode = 200;
  let responseData = null;
  const headers = {};

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
      return res;
    },
    end(data) {
      responseData = data;
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    }
  };
  return { req, res };
}

test('Round 27 Item 1: Floor map data generation, validation, sync payload, and download', async (t) => {
  const TS = Date.now();
  const testDateStr = toTaipeiDateString(new Date());
  const testDate = dateOnly(testDateStr);

  // Setup layout draft
  const draft = await prisma.seatLayout.create({
    data: {
      name: `草稿版面_${TS}`,
      status: 'draft',
      canvas_w: 1000,
      canvas_h: 800,
      kiosk_map_rotation: 0
    }
  });

  const layoutId = draft.id;

  try {
    // 1. 兩個門都標入口：儲存草稿回 422
    {
      const { req, res } = createMockReqRes({
        params: { id: String(layoutId) },
        body: {
          zones: [{ name: 'A區', sort_order: 1 }],
          tables: [{ label: 'T1', zone_key: 'A區', cx: 200, cy: 200, w: 80, h: 60, rotation: 0 }],
          seats: [{ code: 'T1-1', table_key: 'T1', is_active: true }],
          elements_json: [
            { id: 'door-1', type: 'door', cx: 100, cy: 100, w: 40, h: 10, kiosk: { entrance: true } },
            { id: 'door-2', type: 'door', cx: 300, cy: 100, w: 40, h: 10, kiosk: { entrance: true } }
          ]
        }
      });
      await updateLayoutDraft(req, res);
      assert.equal(res.getStatusCode(), 422);
      assert.equal(res.getResponseData()?.code, 'MULTIPLE_ENTRANCES');
    }

    // 2. kiosk.color 是不存在的顏色：儲存草稿回 422
    {
      const { req, res } = createMockReqRes({
        params: { id: String(layoutId) },
        body: {
          zones: [{ name: 'A區', sort_order: 1 }],
          tables: [{ label: 'T1', zone_key: 'A區', cx: 200, cy: 200, w: 80, h: 60, rotation: 0 }],
          seats: [{ code: 'T1-1', table_key: 'T1', is_active: true }],
          elements_json: [
            { id: 'c-1', type: 'counter', label: '吧檯', cx: 100, cy: 100, w: 50, h: 50, kiosk: { color: 'rainbow' } }
          ]
        }
      });
      await updateLayoutDraft(req, res);
      assert.equal(res.getStatusCode(), 422);
      assert.equal(res.getResponseData()?.code, 'INVALID_KIOSK_COLOR');
    }

    // 3. kiosk_map_rotation 不在 0, 90, 180, 270：回 422
    {
      const { req, res } = createMockReqRes({
        params: { id: String(layoutId) },
        body: {
          zones: [{ name: 'A區', sort_order: 1 }],
          tables: [{ label: 'T1', zone_key: 'A區', cx: 200, cy: 200, w: 80, h: 60, rotation: 0 }],
          seats: [{ code: 'T1-1', table_key: 'T1', is_active: true }],
          kiosk_map_rotation: 45
        }
      });
      await updateLayoutDraft(req, res);
      assert.equal(res.getStatusCode(), 422);
      assert.equal(res.getResponseData()?.code, 'INVALID_KIOSK_ROTATION');
    }

    // 4. 正確更新草稿：一個入口門、一個設施、kiosk_map_rotation = 90
    {
      const { req, res } = createMockReqRes({
        params: { id: String(layoutId) },
        body: {
          zones: [{ key: 'z1', name: 'A區', sort_order: 1 }],
          tables: [{ key: 't1', label: 'T1', zone_key: 'z1', cx: 200, cy: 200, w: 80, h: 60, rotation: 0 }],
          seats: [{ code: 'A1-1', table_key: 't1', is_active: true }],
          kiosk_map_rotation: 90,
          elements_json: [
            { id: 'door-main', type: 'door', cx: 100, cy: 500, w: 60, h: 10, kiosk: { entrance: true } },
            { id: 'c-iron', type: 'counter', label: '燙豆區', cx: 100, cy: 100, w: 50, h: 50 }
          ]
        }
      });
      await updateLayoutDraft(req, res);
      assert.equal(res.getStatusCode(), 200);
    }

    // 5. 發布版面
    {
      const { req, res } = createMockReqRes({
        params: { id: String(layoutId) },
        body: {
          effective_from: testDateStr,
          confirm: true
        }
      });
      await publishLayout(req, res);
      assert.equal(res.getStatusCode(), 200);
    }

    // 建立假裝置以測試 sync
    const device = await prisma.kioskDevice.create({
      data: {
        name: `測試機_${TS}`,
        key_wrapped: 'dummy_key',
        is_active: true
      }
    });

    let syncResult1;
    // 6. 測試 sync 回傳 floor_map
    {
      syncResult1 = await processKioskSync(prisma, {
        device,
        body: {},
        clientIp: '127.0.0.1',
        now: new Date()
      });

      assert.ok(syncResult1.floor_map, 'sync 應包含 floor_map');
      assert.ok(syncResult1.floor_map.version.startsWith(`L${layoutId}-`));
      assert.equal(syncResult1.floor_map.url, `/api/kiosk/files/floor-map/${syncResult1.floor_map.version}.json`);
      assert.equal(typeof syncResult1.floor_map.sha256, 'string');
      assert.equal(syncResult1.floor_map.sha256.length, 64);
      assert.ok(syncResult1.floor_map.size > 0);
    }

    // 7. 測試公開檔案下載 GET /api/kiosk/files/floor-map/:version.json
    {
      const { req, res } = createMockReqRes({
        params: { version: syncResult1.floor_map.version }
      });
      await getFloorMapFileHandler(req, res);
      assert.equal(res.getStatusCode(), 200);
      assert.equal(res.getHeader('content-type'), 'application/json; charset=utf-8');

      const downloadedBuf = res.getResponseData();
      assert.ok(Buffer.isBuffer(downloadedBuf));
      const downloadedSha = crypto.createHash('sha256').update(downloadedBuf).digest('hex');
      assert.equal(downloadedSha, syncResult1.floor_map.sha256, '下載檔案的 sha256 應與 sync 提供的一致');
      assert.equal(downloadedBuf.length, syncResult1.floor_map.size);

      const parsedMap = JSON.parse(downloadedBuf.toString('utf8'));
      assert.equal(parsedMap.version, syncResult1.floor_map.version);
      assert.equal(parsedMap.rotation, 90);
    }

    // 8. 測試不存在的版本回 404
    {
      const { req, res } = createMockReqRes({
        params: { version: 'L99999-0000000000' }
      });
      await getFloorMapFileHandler(req, res);
      assert.equal(res.getStatusCode(), 404);
    }

    // 9. 重新發布新版面，sync 的 floor_map.version 應改變，sha256 相符
    const draft2 = await prisma.seatLayout.create({
      data: {
        name: `新草稿_${TS}`,
        status: 'draft',
        canvas_w: 1200,
        canvas_h: 900,
        kiosk_map_rotation: 180
      }
    });

    {
      const { req, res } = createMockReqRes({
        params: { id: String(draft2.id) },
        body: {
          zones: [{ key: 'z2', name: 'B區', sort_order: 1 }],
          tables: [{ key: 't2', label: 'B1', zone_key: 'z2', cx: 300, cy: 300, w: 80, h: 60, rotation: 0 }],
          seats: [{ code: 'B1-1', table_key: 't2', is_active: true }],
          kiosk_map_rotation: 180,
          elements_json: [
            { id: 'door-2', type: 'door', cx: 150, cy: 600, w: 60, h: 10, kiosk: { entrance: true } }
          ]
        }
      });
      await updateLayoutDraft(req, res);
      assert.equal(res.getStatusCode(), 200);

      const { req: pReq, res: pRes } = createMockReqRes({
        params: { id: String(draft2.id) },
        body: {
          effective_from: testDateStr,
          confirm: true
        }
      });
      await publishLayout(pReq, pRes);
      assert.equal(pRes.getStatusCode(), 200);
    }

    {
      const syncResult2 = await processKioskSync(prisma, {
        device,
        body: {},
        clientIp: '127.0.0.1',
        now: new Date()
      });

      assert.ok(syncResult2.floor_map);
      assert.notEqual(syncResult2.floor_map.version, syncResult1.floor_map.version);
      assert.ok(syncResult2.floor_map.version.startsWith(`L${draft2.id}-`));

      const { req, res } = createMockReqRes({
        params: { version: syncResult2.floor_map.version }
      });
      await getFloorMapFileHandler(req, res);
      assert.equal(res.getStatusCode(), 200);

      const downloadedBuf = res.getResponseData();
      const downloadedSha = crypto.createHash('sha256').update(downloadedBuf).digest('hex');
      assert.equal(downloadedSha, syncResult2.floor_map.sha256);
      const parsed = JSON.parse(downloadedBuf.toString('utf8'));
      assert.equal(parsed.rotation, 180);
    }

    // 清理假裝置與測試版面
    await prisma.kioskDevice.delete({ where: { id: device.id } }).catch(() => {});
    await prisma.seatLayout.delete({ where: { id: draft2.id } }).catch(() => {});
  } finally {
    await prisma.seatLayout.delete({ where: { id: layoutId } }).catch(() => {});
  }
});

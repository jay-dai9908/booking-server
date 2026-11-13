import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { updateLayoutDraft } from '../src/controllers/seatLayoutController.js';

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

test('Round 24 Item 2: Draft zone persistence and unknown table zone_id rejection', async (t) => {
  const draft = await prisma.seatLayout.create({
    data: {
      name: `Round 24 Zone Draft ${Date.now()}`,
      status: 'draft',
      canvas_w: 1000,
      canvas_h: 625,
      capacity: 4
    }
  });

  t.after(async () => {
    await prisma.seat.deleteMany({ where: { layout_id: draft.id } });
    await prisma.seatTable.deleteMany({ where: { layout_id: draft.id } });
    await prisma.seatZone.deleteMany({ where: { layout_id: draft.id } });
    await prisma.seatLayout.deleteMany({ where: { id: draft.id } });
  });

  await t.test('1. Saving draft with 3 zones and tables across 3 zones persists all 3 zones and table assignments', async () => {
    const zones = [
      { id: -101, name: 'A 區', sort_order: 0 },
      { id: -102, name: 'B 區', sort_order: 1 },
      { id: -103, name: 'C 區', sort_order: 2 }
    ];
    const tables = [
      { id: -1001, key: 't1', zone_id: -101, label: '桌 1', shape: 'rect', arrangement: 'two_sides', cx: 150, cy: 150, w: 70, h: 140, rotation: 0, sort_order: 0 },
      { id: -1002, key: 't2', zone_id: -102, label: '桌 2', shape: 'rect', arrangement: 'two_sides', cx: 350, cy: 150, w: 70, h: 140, rotation: 0, sort_order: 1 },
      { id: -1003, key: 't3', zone_id: -103, label: '桌 3', shape: 'rect', arrangement: 'two_sides', cx: 550, cy: 150, w: 70, h: 140, rotation: 0, sort_order: 2 }
    ];
    const seats = [
      { code: '1-1', table_key: 't1', zone_id: -101, lx: -45, ly: -35, sort_order: 0 },
      { code: '2-1', table_key: 't2', zone_id: -102, lx: -45, ly: -35, sort_order: 1 },
      { code: '3-1', table_key: 't3', zone_id: -103, lx: -45, ly: -35, sort_order: 2 }
    ];

    const { req, res } = createMockReqRes({
      params: { id: String(draft.id) },
      body: { zones, tables, seats }
    });
    await updateLayoutDraft(req, res);

    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.equal(data.layout.zones.length, 3);

    const zoneByName = new Map(data.layout.zones.map(z => [z.name, z]));
    const tableByLabel = new Map(data.layout.tables.map(tbl => [tbl.label, tbl]));
    assert.equal(tableByLabel.get('桌 1').zone_id, zoneByName.get('A 區').id);
    assert.equal(tableByLabel.get('桌 2').zone_id, zoneByName.get('B 區').id);
    assert.equal(tableByLabel.get('桌 3').zone_id, zoneByName.get('C 區').id);
  });

  await t.test('2. Saving draft with a table referencing non-existent zone_id returns 422 and leaves DB unchanged', async () => {
    const before = await prisma.seatLayout.findUnique({
      where: { id: draft.id },
      include: {
        zones: { orderBy: { sort_order: 'asc' } },
        tables: { orderBy: { sort_order: 'asc' } },
        seats: { orderBy: { sort_order: 'asc' } }
      }
    });

    const zones = before.zones.map(z => ({ id: z.id, name: z.name, sort_order: z.sort_order }));
    const tables = [
      { id: before.tables[0].id, zone_id: 99999999, label: '桌 99', shape: 'rect', arrangement: 'two_sides', cx: 150, cy: 150, w: 70, h: 140, rotation: 0, sort_order: 0 }
    ];
    const seats = [
      { code: '99-1', table_id: before.tables[0].id, zone_id: 99999999, lx: -45, ly: -35, sort_order: 0 }
    ];

    const { req, res } = createMockReqRes({
      params: { id: String(draft.id) },
      body: { zones, tables, seats }
    });
    await updateLayoutDraft(req, res);

    assert.equal(res.getStatusCode(), 422);
    const errBody = res.getResponseData();
    assert.ok(errBody.error.includes('桌子 桌 99 的區域不存在'), `Unexpected error message: ${errBody.error}`);

    const after = await prisma.seatLayout.findUnique({
      where: { id: draft.id },
      include: {
        zones: { orderBy: { sort_order: 'asc' } },
        tables: { orderBy: { sort_order: 'asc' } },
        seats: { orderBy: { sort_order: 'asc' } }
      }
    });
    assert.equal(after.zones.length, before.zones.length);
    assert.equal(after.tables.length, before.tables.length);
    assert.equal(after.seats.length, before.seats.length);
    assert.deepEqual(
      after.tables.map(tbl => ({ id: tbl.id, label: tbl.label, zone_id: tbl.zone_id })),
      before.tables.map(tbl => ({ id: tbl.id, label: tbl.label, zone_id: tbl.zone_id }))
    );
  });
});

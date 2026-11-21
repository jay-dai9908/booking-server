import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { getDayType } from '../src/services/display/dayType.js';
import { dateOnly } from '../../shared/time.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

test('Round 28 Item 2: getDayType, DisplaySetting CRUD/422 validation, and GlobalSetting isolation', async () => {
  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const createdStaffIds = [];
  // Use far-future unique dates so they never collide with other tests
  const dClosed = '2099-05-01'; // Friday, no sessions
  const dWeekday = '2099-05-04'; // Monday, with session, not self-service
  const dHoliday = '2099-05-02'; // Saturday, with session, not self-service
  const dSelf = '2099-05-05'; // Tuesday, with session + is_self_service=true
  const testDates = [dClosed, dWeekday, dHoliday, dSelf].map((d) => dateOnly(d));

  try {
    await prisma.session.deleteMany({ where: { session_date: { in: testDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });

    await prisma.session.createMany({
      data: [
        { session_date: dateOnly(dWeekday), start_time: '10:00', end_time: '11:00', max_capacity: 16 },
        { session_date: dateOnly(dHoliday), start_time: '10:00', end_time: '11:00', max_capacity: 16 },
        { session_date: dateOnly(dSelf), start_time: '10:00', end_time: '11:00', max_capacity: 16 }
      ]
    });
    await prisma.dailySetting.create({
      data: { date: dateOnly(dSelf), is_self_service: true }
    });

    // 1. Verify all 4 getDayType results
    assert.equal(await getDayType(dClosed), 'closed');
    assert.equal(await getDayType(dWeekday), 'weekday');
    assert.equal(await getDayType(dHoliday), 'holiday');
    assert.equal(await getDayType(dSelf), 'self');

    // Setup admin with settings permission
    const staffPass = `set2_${ts}`;
    const staff = await prisma.adminUser.create({
      data: { name: 'Display Setting Admin', password: staffPass, role: 'staff', permissions: ['settings'], is_active: true }
    });
    createdStaffIds.push(staff.id);

    const loginRes = await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    assert.equal(loginRes.status, 200);
    const adminToken = (await loginRes.json()).token;

    // 2. GET /api/display/admin/settings
    {
      const r = await fetch(`${BASE}/api/display/admin/settings`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.id, 1);
      assert.ok(data.schedule?.self && data.schedule?.weekday && data.schedule?.holiday && data.schedule?.closed);
    }

    // 3. 422 range validation checks
    const invalidPayloads = [
      { map_rotation: 45 },
      { time_mode: 'elapsed' },
      { soon_minutes: 0 },
      { soon_minutes: 61 },
      { card_seconds: 4 },
      { card_seconds: 61 },
      { announcement_seconds: 4 },
      { announcement_seconds: 61 },
      { announcements: Array.from({ length: 11 }, (_, i) => `a${i}`) },
      { notices: Array.from({ length: 6 }, (_, i) => `n${i}`) },
      { closing_minutes: 4 },
      { closing_minutes: 121 },
      { shift_minutes: 0 },
      { shift_minutes: 61 },
      { slide_seconds: 3 },
      { slide_seconds: 61 },
      { schedule: { weekday: { mode: 'bogus', content: 'timers' } } },
      { schedule: { weekday: { mode: 'fixed', on: '99:99', off: '21:00', content: 'timers' } } },
      { schedule: { weekday: { mode: 'biz', before: 181, after: 0, content: 'timers' } } },
      { special_dates: [{ date: '2026-99-99', off: '23:30', note: 'bad' }] },
      { special_dates: [{ date: '2026-12-31', off: '25:00', note: 'bad' }] }
    ];

    for (const payload of invalidPayloads) {
      const r = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      assert.equal(r.status, 422, `Expected 422 for payload: ${JSON.stringify(payload)}`);
    }

    // 4. Valid PUT persists changes
    {
      const r = await fetch(`${BASE}/api/display/admin/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          map_rotation: 180,
          soon_minutes: 15,
          announcements: ['新公告 A', '新公告 B'],
          notices: ['請勿飲食', '離場歸位'],
          closing_minutes: 45,
          shift_minutes: 5
        })
      });
      assert.equal(r.status, 200);
      const data = await r.json();
      assert.equal(data.setting.map_rotation, 180);
      assert.equal(data.setting.soon_minutes, 15);
      assert.deepEqual(data.setting.announcements, ['新公告 A', '新公告 B']);
    }

    // 5. GET /api/global-settings NEVER exposes any DisplaySetting columns
    {
      const r = await fetch(`${BASE}/api/global-settings`);
      assert.equal(r.status, 200);
      const gs = await r.json();
      const forbiddenKeys = [
        'schedule', 'special_dates', 'map_rotation', 'here_element', 'time_mode',
        'soon_minutes', 'fallback_to_slides', 'cards', 'card_seconds', 'announcements',
        'announcement_seconds', 'show_line_mini', 'line_title', 'notices',
        'closing_warn', 'closing_minutes', 'shift_minutes', 'slide_seconds'
      ];
      for (const k of forbiddenKeys) {
        assert.equal(k in gs, false, `GlobalSetting must NOT expose DisplaySetting key: ${k}`);
      }
    }
  } finally {
    await prisma.session.deleteMany({ where: { session_date: { in: testDates } } });
    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });
    if (createdStaffIds.length) {
      await prisma.adminUser.deleteMany({ where: { id: { in: createdStaffIds } } });
    }
    await srv.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { createJob } from '../src/controllers/printController.js';
import { dateOnly } from '../../shared/time.js';
import { strWidth } from '../../shared/receipts.js';

function createMockReqRes({ body = {}, user = { name: '分單測試員', id: 1 } } = {}) {
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

test('Round 20 Item 6: Server-side person_slip formatting and createJob whitelist', async (t) => {
  const runId = Math.random().toString(36).slice(2, 8);
  const bookingRef = `R20-6-${runId}`;
  const sessionDate = dateOnly('2026-11-25');
  const createdJobIds = [];

  t.after(async () => {
    if (createdJobIds.length > 0) {
      await prisma.printJob.deleteMany({
        where: { id: { in: createdJobIds } }
      }).catch(() => {});
    }
    await prisma.printJob.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.bookingPerson.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.reservation.deleteMany({
      where: { booking_ref: bookingRef }
    }).catch(() => {});
    await prisma.user.deleteMany({
      where: { line_user_id: `test_user_${runId}` }
    }).catch(() => {});
  });

  // Ensure global print is enabled
  const setting = await prisma.globalSetting.findFirst();
  if (setting && setting.print_enabled === false) {
    await prisma.globalSetting.update({
      where: { id: setting.id },
      data: { print_enabled: true }
    });
  }

  // Ensure test user and session
  const testUser = await prisma.user.upsert({
    where: { line_user_id: `test_user_${runId}` },
    update: { name: '測試顧客' },
    create: {
      line_user_id: `test_user_${runId}`,
      name: '測試顧客',
      phone: '0988776655'
    }
  });

  const session = await prisma.session.upsert({
    where: {
      session_date_start_time: {
        session_date: sessionDate,
        start_time: '14:00'
      }
    },
    update: { end_time: '18:00', max_capacity: 20 },
    create: {
      session_date: sessionDate,
      start_time: '14:00',
      end_time: '18:00',
      max_capacity: 20
    }
  });

  // Create test reservation with 2 persons
  await prisma.reservation.create({
    data: {
      booking_ref: bookingRef,
      user_id: testUser.id,
      session_id: session.id,
      pax: 2,
      assigned_seats: ['1-1', '1-2'],
      status: 'confirmed',
      checkout_details: {
        version: 2,
        order_addons: [],
        order_promos: [],
        persons: [
          {
            person_no: 1,
            addons: [{ key: 'a1', name: '夜光吊飾扣', price: 60, qty: 1 }]
          },
          {
            person_no: 2,
            addons: []
          }
        ]
      }
    }
  });

  const p1 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 1,
      seat_code: '1-1',
      status: 'active',
      billing_start_at: new Date('2026-11-25T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-25T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-25T17:30:00+08:00')
    }
  });

  const p2 = await prisma.bookingPerson.create({
    data: {
      booking_ref: bookingRef,
      person_no: 2,
      seat_code: '1-2',
      status: 'active',
      billing_start_at: new Date('2026-11-25T14:00:00+08:00'),
      timer_started_at: new Date('2026-11-25T14:00:00+08:00'),
      timer_ended_at: new Date('2026-11-25T18:00:00+08:00')
    }
  });


  await t.test('1. POST /print/jobs ignores client-supplied commands and title', async () => {
    const maliciousCommands = [
      { type: 'text', text: 'MALICIOUS_INJECTED_RECEIPT_COMMAND_99999' }
    ];
    const maliciousTitle = 'MALICIOUS_TITLE_INJECTION';

    const { req, res } = createMockReqRes({
      body: {
        type: 'person_slip',
        booking_ref: bookingRef,
        person_no: 1,
        commands: maliciousCommands,
        title: maliciousTitle
      }
    });

    await createJob(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.ok(data?.job?.id, 'PrintJob should be created');
    createdJobIds.push(data.job.id);

    const savedJob = await prisma.printJob.findUnique({
      where: { id: data.job.id }
    });
    assert.ok(savedJob);

    // Verify injected title was ignored
    assert.notEqual(savedJob.title, maliciousTitle, 'Client-supplied title must be ignored');
    assert.ok(savedJob.title.includes('第 1 位'), 'Server generates title based on person_no');

    // Verify injected commands were ignored
    const cmdStrings = JSON.stringify(savedJob.commands_json);
    assert.ok(
      !cmdStrings.includes('MALICIOUS_INJECTED_RECEIPT_COMMAND_99999'),
      'Client-supplied commands must not exist in saved print job'
    );
  });

  await t.test('2. person_slip generated receipt lines do not exceed 31 half-width chars', async () => {
    const { req, res } = createMockReqRes({
      body: {
        type: 'person_slip',
        booking_ref: bookingRef,
        person_no: 1
      }
    });

    await createJob(req, res);
    assert.equal(res.getStatusCode(), 200);
    const data = res.getResponseData();
    assert.ok(data?.job?.id);
    createdJobIds.push(data.job.id);

    const savedJob = await prisma.printJob.findUnique({
      where: { id: data.job.id }
    });
    assert.ok(savedJob);
    const commands = savedJob.commands_json;
    assert.ok(Array.isArray(commands), 'commands_json must be an array');
    assert.ok(commands.length > 0, 'commands_json must not be empty');

    for (const cmd of commands) {
      if (cmd.type === 'text' || cmd.type === 'title') {
        assert.ok(cmd.text != null, 'text command must have text');
        assert.ok(!cmd.text.endsWith('\n'), `Command should not end with newline: ${JSON.stringify(cmd.text)}`);
        const lines = String(cmd.text).split('\n');
        for (const line of lines) {
          const w = strWidth(line);
          assert.ok(
            w <= 31,
            `Receipt line width (${w}) exceeds 31 half-width characters budget: "${line}"`
          );
        }
      }
    }
  });
});

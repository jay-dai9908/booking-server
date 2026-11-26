import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  sendSelfServiceFirstCheckinNotification,
  sendBookingConfirmationNotification
} from '../src/utils/lineMessaging.js';

test('Round 49 Item 4: first check-in LINE notification uses 燙豆區 and booking notification uses 智能板', async () => {
  const prevToken = process.env.LINE_MESSAGING_ACCESS_TOKEN;
  const origPost = axios.post;
  const capturedPayloads = [];

  try {
    process.env.LINE_MESSAGING_ACCESS_TOKEN = `r49_test_${Date.now()}`;
    axios.post = async (url, payload) => {
      capturedPayloads.push({ url, payload });
      return { data: { sentMessages: [] } };
    };

    const fakeUser = {
      id: 1,
      name: 'R49命名測試客',
      line_user_id: `r49_i4_line_${Date.now()}`
    };

    await sendSelfServiceFirstCheckinNotification(
      {
        seats: ['A1'],
        zone: '主區',
        until: '21:00',
        boards: [{ name: '中板', quantity: 1 }]
      },
      fakeUser
    );

    await sendBookingConfirmationNotification(
      {
        booking_ref: '11112222-3333-4444-5555-666677779999',
        session_date: '2026-12-10',
        time_range: '13:00 - 15:00',
        pax: 2,
        equipment_summary: '中板×1',
        total_amount: 500
      },
      fakeUser
    );

    assert.equal(capturedPayloads.length, 2);
    const checkinStr = JSON.stringify(capturedPayloads[0].payload);
    assert.ok(checkinStr.includes('燙豆區'), 'First checkin notification must include 燙豆區');
    assert.equal(checkinStr.includes('熨燙區'), false, 'First checkin notification must NOT include 熨燙區');

    const bookingStr = JSON.stringify(capturedPayloads[1].payload);
    assert.ok(bookingStr.includes('智能板'), 'Booking notification must include 智能板');
    assert.equal(bookingStr.includes('智能拼豆板'), false, 'Booking notification must NOT include 智能拼豆板');
  } finally {
    axios.post = origPost;
    if (prevToken === undefined) {
      delete process.env.LINE_MESSAGING_ACCESS_TOKEN;
    } else {
      process.env.LINE_MESSAGING_ACCESS_TOKEN = prevToken;
    }
  }
});

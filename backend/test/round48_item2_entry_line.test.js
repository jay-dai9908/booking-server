import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { sendSelfServiceVerifiedNotification } from '../src/utils/lineMessaging.js';

test('Round 48 Item 2: sendSelfServiceVerifiedNotification directs guests to dynamic entry QR without 預約條碼', async () => {
  const prevToken = process.env.LINE_MESSAGING_ACCESS_TOKEN;
  const origPost = axios.post;
  const capturedPayloads = [];

  try {
    process.env.LINE_MESSAGING_ACCESS_TOKEN = `r48_test_${Date.now()}`;
    axios.post = async (url, payload) => {
      capturedPayloads.push({ url, payload });
      return { data: { sentMessages: [] } };
    };

    await sendSelfServiceVerifiedNotification(
      {
        booking_ref: '11112222-3333-4444-5555-666677778888',
        session_date: '2026-12-10',
        time_range: '13:00 - 21:00',
        open_at: '12:30'
      },
      {
        id: 1,
        name: '測試顧客',
        line_user_id: `r48_i2_line_${Date.now()}`
      }
    );

    assert.equal(capturedPayloads.length, 1);
    const jsonStr = JSON.stringify(capturedPayloads[0].payload);
    assert.ok(jsonStr.includes('進場 QR'), 'LINE notification must mention 進場 QR');
    assert.ok(jsonStr.includes('截圖無效'), 'LINE notification must warn 截圖無效');
    assert.ok(jsonStr.includes('查看預約詳情'), 'LINE button must say 查看預約詳情');
    assert.equal(jsonStr.includes('預約條碼'), false, 'LINE notification must NOT mention 預約條碼');
  } finally {
    axios.post = origPost;
    if (prevToken === undefined) {
      delete process.env.LINE_MESSAGING_ACCESS_TOKEN;
    } else {
      process.env.LINE_MESSAGING_ACCESS_TOKEN = prevToken;
    }
  }
});

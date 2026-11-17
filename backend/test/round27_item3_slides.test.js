import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import prisma from '../src/prismaClient.js';
import { processKioskSync } from '../src/services/kiosk/syncService.js';

const ADMIN_PORT = 3001;
const BASE_URL = `http://localhost:${ADMIN_PORT}`;

test('Round 27 Item 3: Carousel Slides RGB565 management and kiosk sync', async () => {
  // 1. Setup admin staff user and login via /api/auth/admin/login
  const staffPass = `test_pwd_${Date.now()}`;
  const admin = await prisma.adminUser.create({
    data: {
      name: 'Slide Admin',
      password: staffPass,
      role: 'staff',
      permissions: ['settings'],
      is_active: true
    }
  });

  const loginRes = await fetch(`${BASE_URL}/api/auth/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: staffPass })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  const token = loginData.token;
  assert.ok(token);

  // Clean existing slides
  await prisma.kioskSlide.deleteMany();
  await prisma.kioskSetting.upsert({
    where: { id: 1 },
    update: { slides_rev: 0 },
    create: { id: 1, slides_rev: 0 }
  });

  // 2. Test uploading invalid size (e.g. 500 bytes)
  const invalidBuf = Buffer.alloc(500, 0x12);
  const resInvalid = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'Bad Size',
      raw_base64: invalidBuf.toString('base64'),
      duration_sec: 8
    })
  });
  assert.equal(resInvalid.status, 400);
  const dataInvalid = await resInvalid.json();
  assert.equal(dataInvalid.error, 'SLIDE_INVALID_SIZE');

  // 3. Test uploading valid 768,000 bytes slide
  const validBuf1 = Buffer.alloc(768000, 0x5a);
  const sha256_1 = crypto.createHash('sha256').update(validBuf1).digest('hex');

  const resValid1 = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'Slide 1',
      raw_base64: validBuf1.toString('base64'),
      duration_sec: 10,
      enabled: true
    })
  });
  assert.equal(resValid1.status, 201);
  const data1 = await resValid1.json();
  assert.equal(data1.ok, true);
  assert.equal(data1.slide.title, 'Slide 1');
  assert.equal(data1.slide.duration_sec, 10);
  assert.equal(data1.slide.sha256, sha256_1);
  assert.equal(data1.slide.size, 768000);
  const slide1Id = data1.slide.id;

  // Check slides_rev incremented
  let setting = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  assert.equal(setting.slides_rev, 1);

  // 4. Upload 4 more slides to reach 5 enabled slides
  const createdIds = [slide1Id];
  for (let i = 2; i <= 5; i++) {
    const buf = Buffer.alloc(768000, i);
    const res = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: `Slide ${i}`,
        raw_base64: buf.toString('base64'),
        duration_sec: 8,
        enabled: true
      })
    });
    assert.equal(res.status, 201);
    const d = await res.json();
    createdIds.push(d.slide.id);
  }

  // 5. Try uploading 6th enabled slide -> must fail with MAX_SLIDES_EXCEEDED
  const buf6 = Buffer.alloc(768000, 0x66);
  const res6Fail = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'Slide 6 Over Limit',
      raw_base64: buf6.toString('base64'),
      duration_sec: 8,
      enabled: true
    })
  });
  assert.equal(res6Fail.status, 400);
  const data6Fail = await res6Fail.json();
  assert.equal(data6Fail.error, 'MAX_SLIDES_EXCEEDED');

  // 6. Upload 6th slide as DISABLED -> succeeds
  const res6Disabled = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      title: 'Slide 6 Disabled',
      raw_base64: buf6.toString('base64'),
      duration_sec: 8,
      enabled: false
    })
  });
  assert.equal(res6Disabled.status, 201);
  const data6Disabled = await res6Disabled.json();
  const slide6Id = data6Disabled.slide.id;
  assert.equal(data6Disabled.slide.enabled, false);

  // 7. Try enabling slide 6 while 5 are enabled -> must fail with MAX_SLIDES_EXCEEDED
  const resEnableFail = await fetch(`${BASE_URL}/api/kiosk/admin/slides/${slide6Id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(resEnableFail.status, 400);
  const dataEnableFail = await resEnableFail.json();
  assert.equal(dataEnableFail.error, 'MAX_SLIDES_EXCEEDED');

  // 8. Test list endpoint
  const resList = await fetch(`${BASE_URL}/api/kiosk/admin/slides`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resList.status, 200);
  const dataList = await resList.json();
  assert.equal(dataList.ok, true);
  assert.equal(dataList.slides.length, 6);

  // 9. Public download endpoint
  const resDown = await fetch(`${BASE_URL}/api/kiosk/files/slides/${slide1Id}.bin`);
  assert.equal(resDown.status, 200);
  assert.equal(resDown.headers.get('content-type'), 'application/octet-stream');
  assert.equal(resDown.headers.get('cache-control'), 'public, max-age=86400, immutable');
  assert.equal(resDown.headers.get('etag'), `"${sha256_1}"`);
  const downArrayBuf = await resDown.arrayBuffer();
  assert.equal(downArrayBuf.byteLength, 768000);
  const downBuf = Buffer.from(downArrayBuf);
  assert(downBuf.equals(validBuf1));

  // 10. Test processKioskSync payload
  let device = await prisma.kioskDevice.findFirst();
  if (!device) {
    device = await prisma.kioskDevice.create({
      data: { name: '門口報到機', key_wrapped: 'dummy' }
    });
  }
  const syncPayload = await processKioskSync(prisma, {
    device,
    body: {},
    clientIp: '127.0.0.1',
    now: new Date()
  });
  assert.ok(syncPayload.slides);
  assert.equal(syncPayload.slides.items.length, 5); // Only 5 enabled slides
  assert.equal(syncPayload.slides.items[0].id, slide1Id);
  assert.equal(syncPayload.slides.items[0].sha256, sha256_1);
  assert.equal(syncPayload.slides.items[0].duration_sec, 10);
  assert.equal(syncPayload.slides.items[0].url, `/api/kiosk/files/slides/${slide1Id}.bin`);

  // 11. Delete a slide and verify rev increments
  const prevRev = (await prisma.kioskSetting.findUnique({ where: { id: 1 } })).slides_rev;
  const resDel = await fetch(`${BASE_URL}/api/kiosk/admin/slides/${slide6Id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(resDel.status, 200);
  const nextRev = (await prisma.kioskSetting.findUnique({ where: { id: 1 } })).slides_rev;
  assert.equal(nextRev, prevRev + 1);

  // Cleanup
  await prisma.kioskSlide.deleteMany();
  await prisma.kioskSetting.updateMany({
    where: { id: 1 },
    data: { slides_rev: 0 }
  });
  await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => {});
});

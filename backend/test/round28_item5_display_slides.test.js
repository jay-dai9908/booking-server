import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../src/prismaClient.js';
import { inspectImageBuffer } from '../src/utils/imageInspect.js';
import { startDisplayTestServer } from './helpers/displayTestServer.js';

function makePng(width, height, extraBytes = 0) {
  const buf = Buffer.alloc(32 + extraBytes, 0);
  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR chunk
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 2; // color type
  return buf;
}

function makeJpeg(width, height) {
  const buf = Buffer.alloc(24, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8; // SOI
  buf[2] = 0xff;
  buf[3] = 0xc0; // SOF0
  buf.writeUInt16BE(17, 4); // length
  buf[6] = 8; // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  buf[11] = 3;
  return buf;
}

function makeWebpLossless(width, height) {
  const buf = Buffer.alloc(32, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(12, 16);
  buf[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits >>> 0, 21);
  return buf;
}

test('Round 28 Item 5: DisplaySlide validation (1920x1080 <=2MB), CRUD, file caching, and state integration', async () => {
  // Unit sanity on inspectImageBuffer
  assert.deepEqual(inspectImageBuffer(makePng(1920, 1080)), { mime: 'image/png', width: 1920, height: 1080 });
  assert.deepEqual(inspectImageBuffer(makeJpeg(1920, 1080)), { mime: 'image/jpeg', width: 1920, height: 1080 });
  assert.deepEqual(inspectImageBuffer(makeWebpLossless(1920, 1080)), { mime: 'image/webp', width: 1920, height: 1080 });

  const srv = await startDisplayTestServer();
  const BASE = srv.baseUrl;
  const ts = Date.now();
  const createdSlideIds = [];
  let staffId = null;
  let deviceId = null;

  try {
    const staffPass = `slide_adm_${ts}`;
    const staff = await prisma.adminUser.create({
      data: { name: 'Display Slide Admin', password: staffPass, role: 'staff', permissions: ['settings'], is_active: true }
    });
    staffId = staff.id;

    const loginAdminRes = await fetch(`${BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: staffPass })
    });
    const adminToken = (await loginAdminRes.json()).token;

    const devPass = `disp_slide_${ts}`;
    const dev = await prisma.displayDevice.create({
      data: { name: `Slide Display ${ts}`, password_hash: await bcrypt.hash(devPass, 10), token_version: 1 }
    });
    deviceId = dev.id;

    const dispLoginRes = await fetch(`${BASE}/api/display/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: dev.id, password: devPass })
    });
    const displayToken = (await dispLoginRes.json()).token;

    // 1. Invalid dimensions -> 422
    {
      const badDim = makePng(800, 600);
      const r = await fetch(`${BASE}/api/display/admin/slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: 'self', title: 'Wrong Dim', data_base64: badDim.toString('base64') })
      });
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error, 'SLIDE_INVALID_DIMENSIONS');
    }

    // 2. Invalid format -> 422
    {
      const badFmt = Buffer.from('not-an-image-at-all-1234567890');
      const r = await fetch(`${BASE}/api/display/admin/slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: 'self', title: 'Bad Fmt', data_base64: badFmt.toString('base64') })
      });
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error, 'SLIDE_INVALID_FORMAT');
    }

    // 3. Over 2MB -> 422
    {
      const oversized = makePng(1920, 1080, 2 * 1024 * 1024 + 64);
      const r = await fetch(`${BASE}/api/display/admin/slides`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ set: 'self', title: 'Too Big', data_base64: oversized.toString('base64') })
      });
      assert.equal(r.status, 422);
      assert.equal((await r.json()).error, 'SLIDE_TOO_LARGE');
    }

    // 4. Valid 1920x1080 PNG (self), JPEG (self), WebP (general)
    const pngBuf = makePng(1920, 1080, 10);
    const pngSha = crypto.createHash('sha256').update(pngBuf).digest('hex');
    const rPng = await fetch(`${BASE}/api/display/admin/slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: 'self', title: 'Self PNG', seconds: 10, data_base64: `data:image/png;base64,${pngBuf.toString('base64')}` })
    });
    assert.equal(rPng.status, 201);
    const dPng = await rPng.json();
    createdSlideIds.push(dPng.slide.id);
    assert.equal(dPng.slide.mime, 'image/png');
    assert.equal(dPng.slide.sha256, pngSha);

    const jpgBuf = makeJpeg(1920, 1080);
    const rJpg = await fetch(`${BASE}/api/display/admin/slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: 'self', title: 'Self JPG', seconds: 12, data_base64: jpgBuf.toString('base64') })
    });
    assert.equal(rJpg.status, 201);
    const dJpg = await rJpg.json();
    createdSlideIds.push(dJpg.slide.id);
    assert.equal(dJpg.slide.mime, 'image/jpeg');

    const webpBuf = makeWebpLossless(1920, 1080);
    const rWebp = await fetch(`${BASE}/api/display/admin/slides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: 'general', title: 'Gen WebP', seconds: 8, data_base64: webpBuf.toString('base64') })
    });
    assert.equal(rWebp.status, 201);
    const dWebp = await rWebp.json();
    createdSlideIds.push(dWebp.slide.id);
    assert.equal(dWebp.slide.mime, 'image/webp');

    // 5. Public file download with immutable cache & sha256 verification
    {
      const rFile = await fetch(`${BASE}/api/display/files/slides/${dPng.slide.id}/${pngSha}`);
      assert.equal(rFile.status, 200);
      assert.equal(rFile.headers.get('content-type'), 'image/png');
      assert.match(rFile.headers.get('cache-control') || '', /immutable/);
      assert.equal(rFile.headers.get('etag'), `"${pngSha}"`);
      const dlBuf = Buffer.from(await rFile.arrayBuffer());
      assert.deepEqual(dlBuf, pngBuf);

      // Mismatched sha256 -> 404
      const rBadSha = await fetch(`${BASE}/api/display/files/slides/${dPng.slide.id}/wrongsha`);
      assert.equal(rBadSha.status, 404);
    }

    // 6. Reorder self slides (put JPG before PNG) and verify state reflects order & enabled filter
    {
      const rOrd = await fetch(`${BASE}/api/display/admin/slides/order`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orders: [
            { id: dJpg.slide.id, sort_order: 0 },
            { id: dPng.slide.id, sort_order: 1 }
          ]
        })
      });
      assert.equal(rOrd.status, 200);

      // Disable WebP slide
      const rPatch = await fetch(`${BASE}/api/display/admin/slides/${dWebp.slide.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, title: 'Gen WebP Disabled' })
      });
      assert.equal(rPatch.status, 200);

      const stateRes = await fetch(`${BASE}/api/display/state`, {
        headers: { Authorization: `Bearer ${displayToken}` }
      });
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();

      const selfIds = state.slides.self.map((s) => s.id);
      const jpgIdx = selfIds.indexOf(dJpg.slide.id);
      const pngIdx = selfIds.indexOf(dPng.slide.id);
      assert.ok(jpgIdx >= 0 && pngIdx >= 0 && jpgIdx < pngIdx, 'Self slides should follow updated sort_order');
      assert.equal(state.slides.general.some((s) => s.id === dWebp.slide.id), false, 'Disabled slide must be excluded');
    }

    // 7. Delete slide
    {
      const rDel = await fetch(`${BASE}/api/display/admin/slides/${dPng.slide.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(rDel.status, 200);
      const rAfter = await fetch(`${BASE}/api/display/files/slides/${dPng.slide.id}/${pngSha}`);
      assert.equal(rAfter.status, 404);
    }
  } finally {
    if (createdSlideIds.length) {
      await prisma.displaySlide.deleteMany({ where: { id: { in: createdSlideIds } } });
    }
    if (deviceId) await prisma.displayDevice.deleteMany({ where: { id: deviceId } });
    if (staffId) await prisma.adminUser.deleteMany({ where: { id: staffId } });
    await srv.close();
  }
});

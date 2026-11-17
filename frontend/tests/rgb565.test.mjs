import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIDE_WIDTH,
  SLIDE_HEIGHT,
  SLIDE_BYTES,
  rgbaToRgb565,
  rgb565ToRgba,
  computeSha256Hex
} from '../src/utils/admin/rgb565.js';

test('rgbaToRgb565 outputs exactly 768,000 bytes for 800x480 input', () => {
  const dummyRgba = new Uint8ClampedArray(SLIDE_WIDTH * SLIDE_HEIGHT * 4);
  const bytes = rgbaToRgb565({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, data: dummyRgba });
  assert.equal(bytes.byteLength, SLIDE_BYTES, 'Must be exactly 768,000 bytes');
  assert.equal(bytes.byteLength, 800 * 480 * 2);
});

test('Little-endian RGB565 packing of primary colors (without dithering)', () => {
  const width = 2;
  const height = 2;
  // 4 pixels: Black, White, Pure Red, Pure Green
  const rgba = new Uint8ClampedArray([
    0, 0, 0, 255,       // Black
    255, 255, 255, 255, // White
    255, 0, 0, 255,     // Red
    0, 255, 0, 255      // Green
  ]);

  const bytes = rgbaToRgb565({ width, height, data: rgba }, { dither: false });
  assert.equal(bytes.byteLength, 8);

  // Pixel 0: Black -> 0x0000 -> [0x00, 0x00]
  assert.equal(bytes[0], 0x00);
  assert.equal(bytes[1], 0x00);

  // Pixel 1: White -> 0xFFFF -> [0xFF, 0xFF]
  assert.equal(bytes[2], 0xff);
  assert.equal(bytes[3], 0xff);

  // Pixel 2: Red -> 0xF800 -> low byte 0x00, high byte 0xF8
  assert.equal(bytes[4], 0x00);
  assert.equal(bytes[5], 0xf8);

  // Pixel 3: Green -> 0x07E0 -> low byte 0xE0, high byte 0x07
  assert.equal(bytes[6], 0xe0);
  assert.equal(bytes[7], 0x07);
});

test('Pure blue pixel little-endian packing', () => {
  const rgba = new Uint8ClampedArray([0, 0, 255, 255]);
  const bytes = rgbaToRgb565({ width: 1, height: 1, data: rgba }, { dither: false });
  // Blue -> 0x001F -> low byte 0x1F, high byte 0x00
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x00);
});

test('Roundtrip rgbaToRgb565 -> rgb565ToRgba maintains color fidelity', () => {
  const width = 4;
  const height = 4;
  const original = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    original[i * 4] = (i * 15) % 256;     // R
    original[i * 4 + 1] = (i * 25) % 256; // G
    original[i * 4 + 2] = (i * 35) % 256; // B
    original[i * 4 + 3] = 255;            // A
  }

  const encoded = rgbaToRgb565({ width, height, data: original }, { dither: false });
  const decoded = rgb565ToRgba(encoded, width, height);

  assert.equal(decoded.length, original.length);
  for (let i = 0; i < width * height; i++) {
    // 5-bit channel max error: ~8, 6-bit channel max error: ~4
    assert(Math.abs(decoded[i * 4] - original[i * 4]) <= 9, `R error within quantization tolerance at ${i}`);
    assert(Math.abs(decoded[i * 4 + 1] - original[i * 4 + 1]) <= 5, `G error within quantization tolerance at ${i}`);
    assert(Math.abs(decoded[i * 4 + 2] - original[i * 4 + 2]) <= 9, `B error within quantization tolerance at ${i}`);
    assert.equal(decoded[i * 4 + 3], 255, 'Alpha is fully opaque 255');
  }
});

test('Floyd-Steinberg error diffusion handles full-scale 800x480 gradient without NaN or out-of-bounds', async () => {
  const fullRgba = new Uint8ClampedArray(SLIDE_WIDTH * SLIDE_HEIGHT * 4);
  for (let y = 0; y < SLIDE_HEIGHT; y++) {
    for (let x = 0; x < SLIDE_WIDTH; x++) {
      const idx = (y * SLIDE_WIDTH + x) * 4;
      fullRgba[idx] = Math.floor((x / SLIDE_WIDTH) * 255);
      fullRgba[idx + 1] = Math.floor((y / SLIDE_HEIGHT) * 255);
      fullRgba[idx + 2] = Math.floor(((x + y) / (SLIDE_WIDTH + SLIDE_HEIGHT)) * 255);
      fullRgba[idx + 3] = 255;
    }
  }

  const ditheredBytes = rgbaToRgb565({ width: SLIDE_WIDTH, height: SLIDE_HEIGHT, data: fullRgba }, { dither: true });
  assert.equal(ditheredBytes.byteLength, SLIDE_BYTES);

  for (let i = 0; i < ditheredBytes.byteLength; i++) {
    assert(!Number.isNaN(ditheredBytes[i]), `Byte at ${i} must not be NaN`);
  }

  const hash = await computeSha256Hex(ditheredBytes);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
});

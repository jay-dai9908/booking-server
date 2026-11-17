/**
 * RGB565 conversion utilities for Kiosk Carousel Slides (800x480 raw 16-bit RGB565 LE)
 * Protocol Section 8:
 * - 800x480 resolution
 * - 16-bit RGB565 little-endian
 * - Exactly 768,000 bytes
 * - No headers (no BMP, PNG, or JPEG header)
 */

export const SLIDE_WIDTH = 800;
export const SLIDE_HEIGHT = 480;
export const SLIDE_BYTES = 768000; // 800 * 480 * 2

/**
 * Converts ImageData or Uint8ClampedArray RGBA buffer to RGB565 Uint8Array (little-endian).
 * Optionally applies Floyd-Steinberg dithering to eliminate color banding in 16-bit color.
 *
 * @param {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }} imgData
 * @param {{ dither?: boolean }} [options]
 * @returns {Uint8Array} exactly width * height * 2 bytes
 */
export function rgbaToRgb565(imgData, options = {}) {
  const { width = SLIDE_WIDTH, height = SLIDE_HEIGHT, data } = imgData;
  const dither = options.dither !== false;

  const totalPixels = width * height;
  const outBytes = new Uint8Array(totalPixels * 2);

  if (!dither) {
    for (let i = 0; i < totalPixels; i++) {
      const srcIdx = i * 4;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];

      const r5 = Math.round((r * 31) / 255) & 0x1f;
      const g6 = Math.round((g * 63) / 255) & 0x3f;
      const b5 = Math.round((b * 31) / 255) & 0x1f;

      const word = (r5 << 11) | (g6 << 5) | b5;
      const byteIdx = i * 2;
      outBytes[byteIdx] = word & 0xff;
      outBytes[byteIdx + 1] = (word >> 8) & 0xff;
    }
    return outBytes;
  }

  // Floyd-Steinberg error diffusion buffers
  const rBuf = new Float32Array(totalPixels);
  const gBuf = new Float32Array(totalPixels);
  const bBuf = new Float32Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const srcIdx = i * 4;
    rBuf[i] = data[srcIdx];
    gBuf[i] = data[srcIdx + 1];
    bBuf[i] = data[srcIdx + 2];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const r = Math.min(255, Math.max(0, rBuf[idx]));
      const g = Math.min(255, Math.max(0, gBuf[idx]));
      const b = Math.min(255, Math.max(0, bBuf[idx]));

      const r5 = Math.min(31, Math.max(0, Math.round((r * 31) / 255)));
      const g6 = Math.min(63, Math.max(0, Math.round((g * 63) / 255)));
      const b5 = Math.min(31, Math.max(0, Math.round((b * 31) / 255)));

      const rQuant = (r5 * 255) / 31;
      const gQuant = (g6 * 255) / 63;
      const bQuant = (b5 * 255) / 31;

      const errR = r - rQuant;
      const errG = g - gQuant;
      const errB = b - bQuant;

      // Distribute Floyd-Steinberg error
      // (x + 1, y): 7/16
      if (x + 1 < width) {
        const i1 = idx + 1;
        rBuf[i1] += errR * (7 / 16);
        gBuf[i1] += errG * (7 / 16);
        bBuf[i1] += errB * (7 / 16);
      }
      // (x - 1, y + 1): 3/16
      if (x - 1 >= 0 && y + 1 < height) {
        const i2 = (y + 1) * width + (x - 1);
        rBuf[i2] += errR * (3 / 16);
        gBuf[i2] += errG * (3 / 16);
        bBuf[i2] += errB * (3 / 16);
      }
      // (x, y + 1): 5/16
      if (y + 1 < height) {
        const i3 = (y + 1) * width + x;
        rBuf[i3] += errR * (5 / 16);
        gBuf[i3] += errG * (5 / 16);
        bBuf[i3] += errB * (5 / 16);
      }
      // (x + 1, y + 1): 1/16
      if (x + 1 < width && y + 1 < height) {
        const i4 = (y + 1) * width + (x + 1);
        rBuf[i4] += errR * (1 / 16);
        gBuf[i4] += errG * (1 / 16);
        bBuf[i4] += errB * (1 / 16);
      }

      const word = (r5 << 11) | (g6 << 5) | b5;
      const byteIdx = idx * 2;
      outBytes[byteIdx] = word & 0xff;
      outBytes[byteIdx + 1] = (word >> 8) & 0xff;
    }
  }

  return outBytes;
}

/**
 * Decodes RGB565 little-endian Uint8Array back to RGBA Uint8ClampedArray for preview canvas rendering.
 *
 * @param {Uint8Array} bytes
 * @param {number} [width=SLIDE_WIDTH]
 * @param {number} [height=SLIDE_HEIGHT]
 * @returns {Uint8ClampedArray} RGBA data of length width * height * 4
 */
export function rgb565ToRgba(bytes, width = SLIDE_WIDTH, height = SLIDE_HEIGHT) {
  const totalPixels = width * height;
  const outRgba = new Uint8ClampedArray(totalPixels * 4);

  for (let i = 0; i < totalPixels; i++) {
    const byteIdx = i * 2;
    const word = bytes[byteIdx] | (bytes[byteIdx + 1] << 8);

    const r5 = (word >> 11) & 0x1f;
    const g6 = (word >> 5) & 0x3f;
    const b5 = word & 0x1f;

    const dstIdx = i * 4;
    outRgba[dstIdx] = Math.round((r5 * 255) / 31);
    outRgba[dstIdx + 1] = Math.round((g6 * 255) / 63);
    outRgba[dstIdx + 2] = Math.round((b5 * 255) / 31);
    outRgba[dstIdx + 3] = 255;
  }

  return outRgba;
}

/**
 * Computes lowercase hex SHA-256 for a Uint8Array buffer.
 * Supports both Web Crypto and Node.js environments.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function computeSha256Hex(bytes) {
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hashArr = Array.from(new Uint8Array(hashBuf));
    return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node.js fallback
  try {
    const nodeCrypto = await import('node:crypto');
    return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
  } catch (e) {
    throw new Error('SHA-256 computation not supported in current environment');
  }
}

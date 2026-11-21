/**
 * Pure Node image header inspector for JPEG, PNG, and WebP.
 * Returns { mime, width, height } or null if unrecognized/corrupted.
 */
export function inspectImageBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR at bytes 12..16
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a &&
    buf.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return {
      mime: 'image/png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    };
  }

  // 2. WebP: RIFF....WEBP
  if (
    buf.length >= 30 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return {
        mime: 'image/webp',
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff
      };
    }
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return {
        mime: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1
      };
    }
    if (chunk === 'VP8X') {
      return {
        mime: 'image/webp',
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3)
      };
    }
  }

  // 3. JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos < buf.length) {
      while (pos < buf.length && buf[pos] === 0xff) pos++;
      if (pos >= buf.length) break;
      const marker = buf[pos++];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (pos + 1 >= buf.length) break;
      const segLen = buf.readUInt16BE(pos);
      if (segLen < 2 || pos + segLen > buf.length) break;

      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof && segLen >= 7 && pos + 6 < buf.length) {
        return {
          mime: 'image/jpeg',
          height: buf.readUInt16BE(pos + 3),
          width: buf.readUInt16BE(pos + 5)
        };
      }
      pos += segLen;
    }
  }

  return null;
}

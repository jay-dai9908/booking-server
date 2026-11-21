// frontend/src/components/display/DisplayQrCode.jsx
import React, { useMemo } from 'react';
import QRCode from 'qrcode';

/**
 * Crisp SVG QR code rendered synchronously via `qrcode` (error correction level M by default).
 */
export default function DisplayQrCode({
  text,
  ecc = 'M',
  size = 240,
  className = '',
  style = {}
}) {
  const qrSvg = useMemo(() => {
    if (!text) return null;
    try {
      const qr = QRCode.create(String(text), { errorCorrectionLevel: ecc });
      const n = qr.modules.size;
      const margin = 4;
      const rects = [];
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (qr.modules.get(y, x)) {
            rects.push(
              <rect
                key={`${x}-${y}`}
                x={x + margin}
                y={y + margin}
                width={1.02}
                height={1.02}
              />
            );
          }
        }
      }
      return { n, margin, rects };
    } catch {
      return null;
    }
  }, [text, ecc]);

  if (!qrSvg) {
    return (
      <div
        className={`bg-sg-paper border-2 border-sg-line flex items-center justify-center text-sg-muted text-xs ${className}`}
        style={{ width: size, height: size, ...style }}
      >
        尚無條碼
      </div>
    );
  }

  const vb = qrSvg.n + 2 * qrSvg.margin;

  return (
    <div
      className={`bg-white overflow-hidden ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      <svg
        viewBox={`0 0 ${vb} ${vb}`}
        shapeRendering="crispEdges"
        className="w-full h-full block"
        aria-hidden="true"
      >
        <rect width="100%" height="100%" fill="#FFFFFF" />
        <g fill="#231C17">{qrSvg.rects}</g>
      </svg>
    </div>
  );
}

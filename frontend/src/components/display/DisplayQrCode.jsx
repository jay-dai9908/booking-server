// frontend/src/components/display/DisplayQrCode.jsx
import React, { useMemo } from 'react';
import QRCode from 'qrcode';

const ALPHANUMERIC_RE = /^[0-9A-Z $%*+\-./:]+$/;

/**
 * Crisp SVG QR code rendered synchronously via `qrcode`.
 * Supports ECC M (LINE) and ECC H + alphanumeric mode + optional centered logo (TWQR).
 */
export default function DisplayQrCode({
  text,
  ecc = 'M',
  size = 240,
  showLogo = false,
  logoSrc = '',
  className = '',
  style = {},
  testId
}) {
  const qrSvg = useMemo(() => {
    if (!text) return null;
    const str = String(text);
    try {
      const input = ALPHANUMERIC_RE.test(str)
        ? [{ data: str, mode: 'alphanumeric' }]
        : str;
      const qr = QRCode.create(input, { errorCorrectionLevel: ecc });
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
        data-testid={testId}
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
      data-testid={testId}
      className={`relative bg-white overflow-hidden ${className}`}
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
      {showLogo && logoSrc && (
        <div
          data-testid="display-qr-logo"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white flex items-center justify-center"
          style={{
            width: '30%',
            height: '10.5%',
            padding: '4px 8px',
            borderRadius: 8,
            boxShadow: '0 0 0 5px #FFFFFF'
          }}
        >
          <img
            src={logoSrc}
            alt="TWQR"
            className="w-full h-full object-contain block"
          />
        </div>
      )}
    </div>
  );
}

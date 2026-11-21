// frontend/src/components/display/DisplaySelfSide.jsx
import React from 'react';
import DisplayQrCode from './DisplayQrCode';

/**
 * Right column for slides_self and timers_self:
 * - LINE QR card (ecc M)
 * - Notices card (up to 5 bullet points, sized so all 5 fit cleanly without clipping)
 */
export default function DisplaySelfSide({
  line = {},
  notices = [],
  compactQr = false
}) {
  const qrSize = compactQr ? 176 : 200;
  const list = Array.isArray(notices) ? notices.filter(Boolean).slice(0, 5) : [];

  return (
    <>
      <div
        data-testid="display-line-card"
        className="bg-sg-paper relative overflow-hidden flex flex-col items-center text-center flex-none"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
          padding: '22px 28px',
          gap: 8
        }}
      >
        <b className="font-display font-bold text-sg-ink" style={{ fontSize: 32 }}>
          {line?.title || '有問題請加 LINE'}
        </b>
        <div
          className="bg-sg-paper border-[3px] border-sg-line flex items-center justify-center overflow-hidden"
          style={{ width: qrSize, height: qrSize, borderRadius: 20 }}
        >
          <DisplayQrCode text={line?.url || ''} ecc="M" size={qrSize - 6} />
        </div>
        {line?.id && (
          <div className="font-num font-extrabold text-sg-line-green" style={{ fontSize: 32, lineHeight: 1.1 }}>
            {line.id}
          </div>
        )}
      </div>

      <div
        data-testid="display-notices-card"
        className="bg-sg-paper relative overflow-hidden flex-1 flex flex-col"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
          padding: '24px 32px'
        }}
      >
        <h3 className="font-display font-bold text-sg-ink" style={{ fontSize: 34, marginBottom: 8 }}>
          注意事項
        </h3>
        <div className="flex flex-col" style={{ gap: 6 }}>
          {list.length > 0 ? (
            list.map((item, idx) => (
              <div
                key={idx}
                className="flex text-sg-ink"
                style={{ gap: 12, fontSize: 22, lineHeight: 1.38, padding: '2px 0' }}
              >
                <span
                  className="flex-none rounded-full bg-sg-peach"
                  style={{ width: 12, height: 12, marginTop: 9 }}
                />
                <span>{item}</span>
              </div>
            ))
          ) : (
            <p className="text-sg-muted m-0" style={{ fontSize: 22 }}>
              歡迎光臨拾光製所，祝您拼豆愉快！
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// frontend/src/components/display/DisplayThanksView.jsx
import React from 'react';

/**
 * Payment complete thank-you screen shown for thanks_seconds after collect.
 */
export default function DisplayThanksView() {
  return (
    <div
      data-testid="display-thanks-view"
      className="flex flex-col items-center justify-center text-center h-full w-full relative z-10"
      style={{ gap: 26 }}
    >
      <img
        src="/logo.png"
        alt="拾光製所"
        className="rounded-full object-cover"
        style={{
          width: 260,
          height: 260,
          boxShadow: '0 0 0 8px #FFFDF9, 0 6px 20px rgba(62,51,43,0.12)'
        }}
      />
      <h2
        className="font-display font-bold text-sg-ink m-0"
        style={{ fontSize: 110, letterSpacing: '0.06em', lineHeight: 1.2 }}
      >
        謝謝光臨
      </h2>
      <p className="text-sg-muted m-0" style={{ fontSize: 40 }}>
        付款完成。作品記得帶回家，歡迎再來拼豆
      </p>
    </div>
  );
}

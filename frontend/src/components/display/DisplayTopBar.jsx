// frontend/src/components/display/DisplayTopBar.jsx
import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { DAY_TYPE_LABELS } from '../../utils/display/seatStatus';

/**
 * 3-column Top Bar matching store-display-mock.html:
 * - Left: brand logo + 拾光製所 + GATHERING LIGHT
 * - Center: date + day_type pill whose date text baseline aligns with 拾光製所 baseline
 * - Right: HH:mm clock + optional disconnect notice positioned below without shifting layout
 */
export default function DisplayTopBar({
  dateText,
  dayType,
  clockText,
  offline = false,
  screenScale = 1
}) {
  const tbRef = useRef(null);
  const brandNameRef = useRef(null);
  const dateSpanRef = useRef(null);

  const alignTop = useCallback(() => {
    const tbEl = tbRef.current;
    const brandEl = brandNameRef.current;
    const dtEl = dateSpanRef.current;
    if (!tbEl || !brandEl || !dtEl) return;

    const measureBaseline = (el) => {
      const probe = document.createElement('i');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      el.appendChild(probe);
      const y = probe.getBoundingClientRect().top;
      probe.remove();
      return y;
    };

    tbEl.style.setProperty('--tb-dy', '0px');
    const screenEl = tbEl.closest('[data-display-screen]');
    const rectWidth = screenEl ? screenEl.getBoundingClientRect().width : 0;
    const k = rectWidth > 0 ? 1920 / rectWidth : (screenScale > 0 ? 1 / screenScale : 1);

    const targetY = measureBaseline(brandEl);
    const currentY = measureBaseline(dtEl);
    const dy = (targetY - currentY) * k;
    if (Number.isFinite(dy)) {
      tbEl.style.setProperty('--tb-dy', `${Math.round(dy * 100) / 100}px`);
    }
  }, [screenScale]);

  useLayoutEffect(() => {
    alignTop();
  }, [alignTop, dateText, dayType]);

  useEffect(() => {
    let active = true;
    const raf = requestAnimationFrame(() => {
      if (active) alignTop();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (active) alignTop();
      });
    }
    return () => {
      active = false;
      cancelAnimationFrame(raf);
    };
  }, [alignTop, dateText, dayType]);

  const dayLabel = DAY_TYPE_LABELS[dayType] || DAY_TYPE_LABELS.weekday;

  return (
    <header
      ref={tbRef}
      data-testid="display-topbar"
      className="absolute left-0 right-0 top-0 grid items-center"
      style={{
        height: 132,
        gridTemplateColumns: '1fr auto 1fr',
        padding: '0 64px'
      }}
    >
      {/* Left: Brand */}
      <div className="flex items-center" style={{ gap: 22 }}>
        <img
          src="/logo.png"
          alt="拾光製所"
          className="rounded-full object-cover"
          style={{
            width: 96,
            height: 96,
            boxShadow: '0 0 0 5px #FFFDF9, 0 4px 14px rgba(62,51,43,0.12)'
          }}
        />
        <div>
          <b
            ref={brandNameRef}
            data-testid="display-brand-name"
            className="block font-display font-bold text-sg-ink"
            style={{ fontSize: 50, letterSpacing: '0.06em', lineHeight: 1.1 }}
          >
            拾光製所
          </b>
          <small
            className="block font-num font-bold text-sg-peach-ink"
            style={{ fontSize: 20, letterSpacing: '0.32em', marginTop: 4 }}
          >
            GATHERING LIGHT
          </small>
        </div>
      </div>

      {/* Center: Date + Day Type Pill (baseline-aligned with brand name) */}
      <div
        data-testid="display-topbar-day"
        className="justify-self-center flex items-center font-display text-sg-muted"
        style={{
          fontSize: 36,
          fontWeight: 400,
          transform: 'translateY(var(--tb-dy, 0px))'
        }}
      >
        <span ref={dateSpanRef} data-testid="display-date-text">
          {dateText}
        </span>
        <em
          data-testid="display-day-pill"
          className="not-italic bg-sg-peach-ink text-sg-paper rounded-full font-body font-bold"
          style={{
            padding: '2px 22px',
            marginLeft: 14,
            fontSize: 30,
            lineHeight: 1.4
          }}
        >
          {dayLabel}
        </em>
      </div>

      {/* Right: Clock + Offline Notice */}
      <div
        data-testid="display-clock"
        className="justify-self-end text-right font-num font-extrabold text-sg-ink relative"
        style={{
          fontSize: 92,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '0.01em',
          lineHeight: 1
        }}
      >
        {clockText}
        {offline && (
          <span
            data-testid="display-offline-notice"
            className="absolute right-0 whitespace-nowrap font-body font-bold"
            style={{
              top: '100%',
              marginTop: 6,
              fontSize: 22,
              color: '#B4553F'
            }}
          >
            連線中斷，顯示最後資料
          </span>
        )}
      </div>
    </header>
  );
}

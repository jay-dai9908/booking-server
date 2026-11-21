// frontend/src/components/display/DisplayTicker.jsx
import React from 'react';
import DisplayQrCode from './DisplayQrCode';

/**
 * Bottom ticker bar:
 * - Closing warning takes priority (honey-soft pill background)
 * - Self-service mode shows fixed semi-self reminder (unless closing warning active)
 * - Normal mode rotates announcements + optional mini LINE QR (ecc M)
 */
export default function DisplayTicker({
  announcements = [],
  annIdx = 0,
  closingWarning = '',
  isSelfMode = false,
  isSelfSlides = false,
  showLineMini = true,
  line = {}
}) {
  if (closingWarning) {
    return (
      <div
        data-testid="display-ticker-closing"
        className="absolute flex items-center bg-sg-honey-soft rounded-full"
        style={{
          left: 64,
          right: 64,
          bottom: 22,
          height: 66,
          gap: 24,
          fontSize: 30,
          padding: '0 20px 0 10px'
        }}
      >
        <span
          className="flex-none font-body font-bold text-sg-paper bg-sg-honey-ink rounded-full"
          style={{ fontSize: 26, padding: '6px 22px' }}
        >
          打烊提醒
        </span>
        <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-sg-ink">
          {closingWarning}
        </span>
      </div>
    );
  }

  if (isSelfMode) {
    return (
      <div
        data-testid="display-ticker-self"
        className="absolute flex items-center"
        style={{
          left: 64,
          right: 64,
          bottom: 22,
          height: 66,
          gap: 24,
          fontSize: 30
        }}
      >
        <span
          className="flex-none font-body font-bold text-sg-paper bg-sg-peach-ink rounded-full"
          style={{ fontSize: 26, padding: '6px 22px' }}
        >
          半自助日
        </span>
        <span className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-sg-ink">
          {isSelfSlides
            ? '今天沒有店員在場，進門請掃條碼；需要幫忙請用 LINE'
            : '今天沒有店員在場，需要幫忙請用 LINE'}
        </span>
      </div>
    );
  }

  const list = Array.isArray(announcements) && announcements.length > 0
    ? announcements
    : ['歡迎光臨拾光製所'];
  const currentText = list[annIdx % list.length];

  return (
    <div
      data-testid="display-ticker"
      className="absolute flex items-center"
      style={{
        left: 64,
        right: 64,
        bottom: 22,
        height: 66,
        gap: 24,
        fontSize: 30
      }}
    >
      <span
        className="flex-none font-body font-bold text-sg-paper bg-sg-peach-ink rounded-full"
        style={{ fontSize: 26, padding: '6px 22px' }}
      >
        公告
      </span>
      <span
        data-testid="display-announcement-text"
        className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-sg-ink"
      >
        {currentText}
      </span>
      {showLineMini && (line?.url || line?.id) && (
        <span
          className="flex items-center flex-none font-num font-bold text-sg-muted"
          style={{ gap: 14, fontSize: 26 }}
        >
          {line?.id ? `LINE ${line.id}` : 'LINE'}
          {line?.url && (
            <DisplayQrCode
              text={line.url}
              ecc="M"
              size={60}
              className="rounded-[10px]"
              style={{ padding: 3 }}
            />
          )}
        </span>
      )}
    </div>
  );
}

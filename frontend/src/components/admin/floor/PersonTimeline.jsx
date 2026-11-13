import React from 'react';
import { formatTimeHHmm, formatTimerHMM } from '../../../../../shared/time.js';
import { displayBoardName } from '../../../../../shared/billing.js';
import { bookedMinutes, personElapsedMinutes } from '../../../utils/admin/floorSelectors';

function shortBoardSize(name) {
  const clean = displayBoardName(name || '');
  if (clean.includes('小板')) return '小板';
  if (clean.includes('中板')) return '中板';
  if (clean.includes('大板')) return '大板';
  return clean.split(/[\s(（]/)[0] || '智能板';
}

function toMs(val) {
  if (!val) return null;
  const ms = val instanceof Date ? val.getTime() : new Date(val).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const STRIPE_STYLE = {
  backgroundImage: 'repeating-linear-gradient(-45deg, #FFFDF9, #FFFDF9 3px, #C7BBAE 3px, #C7BBAE 6px)',
};

/**
 * 座位面板的時間軸（計時軸 + 智能板軸）
 * 以共用時間刻度繪製已玩、剩餘、暫停斜線、超時紅條、現在紅線與換板虛線。
 */
export default function PersonTimeline({ booking, person, personNo, now }) {
  if (!booking) return null;

  const nowMs = toMs(now) ?? Date.now();
  const timer = person?.timer || {};
  const pauses = Array.isArray(person?.pauses) ? person.pauses : [];

  const totalBookedMins = bookedMinutes(booking);
  const playedMins = personElapsedMinutes(person, nowMs);
  const isPaused = Boolean(timer.paused_at && !timer.timer_ended_at);
  const isEnded = Boolean(timer.timer_ended_at);

  const pausedStartMs = toMs(timer.paused_at);
  const currentPauseMins = isPaused && pausedStartMs
    ? Math.max(0, Math.floor((nowMs - pausedStartMs) / 60000))
    : 0;

  // 第一行摘要（依狀態三擇一）
  let summaryContent;
  if (isPaused) {
    summaryContent = (
      <span>
        已玩 {formatTimerHMM(playedMins)} · 暫停中 {formatTimerHMM(currentPauseMins)}（不計費）
      </span>
    );
  } else if (playedMins > totalBookedMins) {
    const overMins = playedMins - totalBookedMins;
    summaryContent = (
      <span>
        已玩 {formatTimerHMM(playedMins)} ·{' '}
        <span className="text-sg-danger font-bold">超過預約 {overMins} 分</span>
      </span>
    );
  } else {
    const remainMins = Math.max(0, totalBookedMins - playedMins);
    summaryContent = (
      <span>
        已玩 {formatTimerHMM(playedMins)} · 預約還有 {formatTimerHMM(remainMins)}
      </span>
    );
  }

  // 時間軸範圍計算
  const bookingStartMs = toMs(booking.start_at) ?? nowMs;
  const bookingEndMs = toMs(booking.end_at) ?? (bookingStartMs + Math.max(60, totalBookedMins) * 60000);
  const timerStartMs = toMs(timer.billing_start_at) ?? toMs(timer.timer_started_at);
  const timerEndMs = toMs(timer.timer_ended_at);
  const effectiveNowMs = timerEndMs ?? nowMs;

  const targetPersonNo = Number(personNo || person?.person_no || 1);
  const personBoards = (booking.boards || []).filter(
    (bd) => Number(bd.person_no) === targetPersonNo
  );

  // 蒐集所有時間點以決定共用座標軸範圍
  const allStarts = [bookingStartMs];
  const allEnds = [bookingEndMs];

  if (timerStartMs !== null) {
    allStarts.push(timerStartMs);
  }
  if (!isEnded && timerStartMs !== null && nowMs > bookingEndMs) {
    allEnds.push(nowMs);
  } else if (timerEndMs !== null && timerEndMs > bookingEndMs) {
    allEnds.push(timerEndMs);
  }

  const swapTimesMs = [];
  const sizeTracksMap = new Map();
  const boardSummaryParts = [];

  for (const bd of personBoards) {
    const rawSegs = Array.isArray(bd.segments) ? bd.segments : [];
    const segs = [...rawSegs].sort((a, b) => (toMs(a.start_at) ?? 0) - (toMs(b.start_at) ?? 0));
    const unitPauses = Array.isArray(bd.pauses) ? bd.pauses : [];

    const segLabels = [];
    const groupSwapLabels = [];

    segs.forEach((seg, idx) => {
      const sStart = toMs(seg.start_at);
      const sEnd = toMs(seg.end_at) ?? toMs(seg.planned_end_at) ?? bookingEndMs;
      if (sStart === null) return;

      allStarts.push(sStart);
      if (sEnd > bookingEndMs) allEnds.push(sEnd);

      const sizeLabel = shortBoardSize(seg.name);
      if (!sizeTracksMap.has(sizeLabel)) {
        sizeTracksMap.set(sizeLabel, []);
      }
      sizeTracksMap.get(sizeLabel).push({
        seg,
        sStart,
        sEnd,
        isEnded: Boolean(seg.end_at),
        pauses: unitPauses,
      });

      if (idx > 0) {
        swapTimesMs.push(sStart);
        groupSwapLabels.push(formatTimeHHmm(sStart));
      }

      const endStr = formatTimeHHmm(seg.end_at || seg.planned_end_at || bookingEndMs);
      segLabels.push(`${sizeLabel} ${formatTimeHHmm(sStart)}–${endStr}`);
    });

    if (segLabels.length > 1) {
      boardSummaryParts.push(`${segLabels.join(' → ')}（${groupSwapLabels.join('、')} 換板）`);
    } else if (segLabels.length === 1) {
      const onlySeg = segs[0];
      const suffix = onlySeg?.end_at ? '（已歸還）' : '';
      boardSummaryParts.push(`${segLabels[0]}${suffix}`);
    }
  }

  const domainStartMs = Math.min(...allStarts);
  const domainEndMs = Math.max(...allEnds, domainStartMs + 60 * 60000);
  const spanMs = Math.max(60000, domainEndMs - domainStartMs);

  const toPct = (ms) => {
    const raw = ((ms - domainStartMs) / spanMs) * 100;
    return Math.max(0, Math.min(100, raw));
  };

  const spanStyle = (startMs, endMs) => {
    const left = toPct(startMs);
    const right = toPct(Math.max(startMs, endMs));
    return {
      left: `${left}%`,
      width: `${Math.max(0, right - left)}%`,
    };
  };

  // 整點刻度（UTC+8 與整點對齊，每 3600000 ms 即台北整點）
  const firstHourMs = Math.ceil(domainStartMs / 3600000) * 3600000;
  const hourTicks = [];
  for (let t = firstHourMs; t <= domainEndMs + 1000; t += 3600000) {
    if (t >= domainStartMs && t <= domainEndMs) {
      hourTicks.push(t);
    }
  }

  const showCompactHours = hourTicks.length > 6;
  const showNowLine = nowMs >= domainStartMs && nowMs <= domainEndMs;
  const nowPct = toPct(nowMs);

  const playedStartMs = timerStartMs;
  const playedNormalEndMs = playedStartMs !== null ? Math.min(effectiveNowMs, bookingEndMs) : null;
  const hasOvertime = playedStartMs !== null && effectiveNowMs > bookingEndMs;
  const sizeTracks = Array.from(sizeTracksMap.entries());

  return (
    <div className="rounded-xl bg-sg-paper border border-sg-line p-3 space-y-2.5">
      {/* 第一行摘要 */}
      <div className="text-[13px] font-bold text-sg-ink flex items-center justify-between gap-2">
        <div className="truncate">{summaryContent}</div>
      </div>

      {/* 時間軸群組（右側欄位共用同一時間刻度） */}
      <div className="space-y-1.5">
        {/* 「現在」標籤與共享垂直紅線基準區 */}
        <div className="relative">
          {/* 共用軌道區 + 右欄垂直疊層 */}
          <div className="space-y-1.5 relative">
            {/* 計時軸 */}
            <div className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-[11px] font-bold text-sg-muted">計時</span>
              <div className="relative flex-1 h-5 rounded-md overflow-hidden bg-sg-bg border border-sg-line/80">
                {/* 預約區間底色（剩餘時間：淺色） */}
                <div
                  className="absolute inset-y-0 bg-sg-sage-soft"
                  style={spanStyle(bookingStartMs, bookingEndMs)}
                />
                {/* 已玩時間（實色） */}
                {playedStartMs !== null && playedNormalEndMs !== null && playedNormalEndMs > playedStartMs && (
                  <div
                    className="absolute inset-y-0 bg-sg-sage"
                    style={spanStyle(playedStartMs, playedNormalEndMs)}
                  />
                )}
                {/* 超時時間（紅色） */}
                {hasOvertime && (
                  <div
                    className="absolute inset-y-0 bg-sg-danger"
                    style={spanStyle(bookingEndMs, effectiveNowMs)}
                  />
                )}
                {/* 暫停區間（斜線） */}
                {pauses.map((p, idx) => {
                  const pStart = toMs(p.started_at);
                  const pEnd = toMs(p.ended_at) ?? effectiveNowMs;
                  if (pStart === null || pEnd <= pStart) return null;
                  const st = spanStyle(pStart, pEnd);
                  return (
                    <div
                      key={p.id || idx}
                      className="absolute inset-y-0 border-x border-sg-muted/40"
                      style={{ ...st, ...STRIPE_STYLE, minWidth: '3px' }}
                      title={`暫停 ${formatTimeHHmm(pStart)}–${formatTimeHHmm(pEnd)}`}
                    />
                  );
                })}
              </div>
            </div>

            {/* 智能板軸（每種尺寸各一條） */}
            {sizeTracks.map(([sizeLabel, items]) => (
              <div key={sizeLabel} className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-[11px] font-bold text-sg-muted">{sizeLabel}</span>
                <div className="relative flex-1 h-5 rounded-md overflow-hidden bg-sg-bg/70 border border-sg-line/60">
                  {items.map((item, idx) => {
                    const st = spanStyle(item.sStart, item.sEnd);
                    const elapsedBoardEnd = Math.min(nowMs, item.sEnd);
                    return (
                      <React.Fragment key={item.seg.equipment_id || `${sizeLabel}-${idx}`}>
                        {item.isEnded ? (
                          <div
                            className="absolute inset-y-0 bg-[#E7E0D7] border border-sg-line flex items-center justify-center overflow-hidden px-1"
                            style={{ ...st, minWidth: '3px' }}
                            title={`${sizeLabel} 已歸還`}
                          >
                            <span className="text-[10px] font-bold text-sg-muted whitespace-nowrap truncate">
                              已歸還
                            </span>
                          </div>
                        ) : (
                          <>
                            {/* 預計使用期（淺棕） */}
                            <div
                              className="absolute inset-y-0 bg-sg-brown-soft border border-sg-brown/30"
                              style={st}
                            />
                            {/* 目前已經過區間（實棕） */}
                            {elapsedBoardEnd > item.sStart && (
                              <div
                                className="absolute inset-y-0 bg-sg-brown/85"
                                style={spanStyle(item.sStart, elapsedBoardEnd)}
                              />
                            )}
                          </>
                        )}
                        {/* 智能板暫停區間（斜線） */}
                        {item.pauses.map((bp, bpIdx) => {
                          const bpStart = toMs(bp.started_at);
                          const bpEnd = toMs(bp.ended_at) ?? effectiveNowMs;
                          if (bpStart === null || bpEnd <= item.sStart || bpStart >= item.sEnd) return null;
                          const overlapStart = Math.max(item.sStart, bpStart);
                          const overlapEnd = Math.min(item.sEnd, bpEnd);
                          if (overlapEnd <= overlapStart) return null;
                          return (
                            <div
                              key={bp.id || bpIdx}
                              className="absolute inset-y-0 border-x border-sg-muted/40"
                              style={{ ...spanStyle(overlapStart, overlapEnd), ...STRIPE_STYLE, minWidth: '3px' }}
                            />
                          );
                        })}
                      </React.Fragment>
                    );
                  })}

                  {/* 換板虛線（僅在有換板時間點繪製） */}
                  {swapTimesMs.map((swMs, idx) => (
                    <div
                      key={idx}
                      className="absolute inset-y-0 border-l-2 border-dashed border-sg-ink/60 pointer-events-none z-10"
                      style={{ left: `${toPct(swMs)}%` }}
                    />
                  ))}
                </div>
              </div>
            ))}

            {/* 貫穿計時軸與智能板軸的「現在」紅色直線 */}
            {showNowLine && (
              <div className="flex items-stretch gap-2 absolute inset-0 pointer-events-none">
                <div className="w-9 shrink-0" />
                <div className="relative flex-1">
                  <div
                    className="absolute -top-1 bottom-0 w-0.5 bg-sg-danger z-20"
                    style={{ left: `${nowPct}%` }}
                  >
                    <span
                      className={`absolute -top-3.5 text-[9px] font-bold text-sg-danger whitespace-nowrap bg-sg-paper/90 px-0.5 rounded ${
                        nowPct > 88 ? '-translate-x-full' : nowPct < 12 ? 'translate-x-0' : '-translate-x-1/2'
                      }`}
                    >
                      現在
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 下方整點刻度 */}
        <div className="flex items-center gap-2 pt-0.5">
          <div className="w-9 shrink-0" />
          <div className="relative flex-1 h-4 text-[10px] font-num text-sg-muted">
            {hourTicks.map((tickMs) => {
              const p = toPct(tickMs);
              const hhmm = formatTimeHHmm(tickMs);
              const label = showCompactHours ? hhmm.slice(0, 2) : hhmm;
              const alignClass =
                p <= 4 ? 'translate-x-0' : p >= 96 ? '-translate-x-full' : '-translate-x-1/2';
              return (
                <div
                  key={tickMs}
                  className={`absolute top-0 flex flex-col items-center ${alignClass}`}
                  style={{ left: `${p}%` }}
                >
                  <div className="w-px h-1 bg-sg-muted/50 mb-0.5" />
                  <span className="leading-none whitespace-nowrap">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 智能板一行文字說明 */}
      {boardSummaryParts.length > 0 && (
        <div className="text-[11px] font-medium text-sg-muted pt-0.5 leading-snug">
          {boardSummaryParts.join(' · ')}
        </div>
      )}
    </div>
  );
}

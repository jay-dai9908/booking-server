import React, { useRef, useState, useEffect, useMemo } from 'react';
import { Check } from 'lucide-react';
import { extractTimeHHMM } from '../../../utils/admin/floorSelectors';

export default function TimelineGrid({
  seats = [],
  bookings = [],
  sessions = [],
  onBookingClick = null,
  onEmptySlotClick = null,
  className = ''
}) {
  const containerRef = useRef(null);
  const [viewMode, setViewMode] = useState('all'); // 'window' | 'all'

  const getTaipeiDecimalHour = (d) => {
    if (!d) return 0;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    }).formatToParts(d instanceof Date ? d : new Date(d));
    const h = Number(parts.find(p => p.type === 'hour')?.value) || 0;
    const m = Number(parts.find(p => p.type === 'minute')?.value) || 0;
    return h + m / 60;
  };

  const now = new Date();
  const currentHour = getTaipeiDecimalHour(now);

  // Time boundaries based on viewMode
  const startHour = viewMode === 'window' ? Math.max(10, Math.floor(currentHour) - 2) : 10;
  const endHour = viewMode === 'window' ? Math.min(22, Math.ceil(currentHour) + 4) : 22;
  const totalHours = Math.max(1, endHour - startHour);
  const hourWidth = 90; // pixels per hour
  const timelineWidth = totalHours * hourWidth;
  const nowOffsetPx = (currentHour - startHour) * hourWidth;

  useEffect(() => {
    // Scroll container to roughly center the 'now' line
    if (containerRef.current && nowOffsetPx > 0) {
      containerRef.current.scrollLeft = Math.max(0, nowOffsetPx - 150);
    }
  }, [nowOffsetPx, viewMode]);

  const hoursArray = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i);

  // Natural alphanumeric sort so B1-1, B1-2, B1-3 are in proper order
  const sortedPhysicalSeats = useMemo(() => {
    return [...seats].sort((a, b) => {
      return a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [seats]);

  // Compute waiting area seats (WAIT-1, WAIT-2, ...)
  const waitingSeats = useMemo(() => {
    let maxWaitIdx = 0;
    for (const b of bookings) {
      for (const sc of (b.assigned_seats || [])) {
        if (sc.startsWith('WAIT-')) {
          const idx = parseInt(sc.replace('WAIT-', ''), 10);
          if (idx > maxWaitIdx) maxWaitIdx = idx;
        }
      }
    }
    const count = Math.max(2, maxWaitIdx + 2);
    const list = [];
    for (let i = 1; i <= count; i++) {
      list.push({
        code: `WAIT-${i}`,
        label: `等待 ${i}`,
        isWaiting: true
      });
    }
    return list;
  }, [bookings]);

  const allRows = useMemo(() => {
    return [
      ...sortedPhysicalSeats.map(s => ({ ...s, label: s.code, isWaiting: false })),
      ...waitingSeats
    ];
  }, [sortedPhysicalSeats, waitingSeats]);

  return (
    <div className={`space-y-2 select-none ${className}`}>
      {/* Control bar: '現在前後' vs '整天' */}
      <div className="flex items-center justify-between px-1">
        <span className="text-[12px] font-bold text-sg-muted">時間軸座位表</span>
        <div className="flex items-center gap-1 bg-sg-paper border border-sg-line p-0.5 rounded-xl">
          <button
            type="button"
            onClick={() => setViewMode('window')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
              viewMode === 'window'
                ? 'bg-sg-brown text-white shadow-xs'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            現在前後
          </button>
          <button
            type="button"
            onClick={() => setViewMode('all')}
            className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition ${
              viewMode === 'all'
                ? 'bg-sg-brown text-white shadow-xs'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            整天
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="overflow-x-auto bg-white border border-sg-line rounded-2xl"
      >
        <div style={{ width: timelineWidth + 100, minWidth: '100%' }}>
          {/* Time ruler header */}
          <div className="flex border-b border-sg-line bg-sg-paper/40 sticky top-0 z-20">
            <div className="w-24 px-3 py-2 text-[11px] font-bold text-sg-muted border-r border-sg-line flex-shrink-0 bg-sg-paper">
              座位
            </div>
            <div className="relative flex-1 h-9">
              {hoursArray.map((hour, idx) => (
                <div
                  key={hour}
                  className="absolute top-0 bottom-0 text-[11px] font-bold text-sg-muted flex items-center -translate-x-1/2"
                  style={{ left: idx * hourWidth }}
                >
                  {String(hour).padStart(2, '0')}:00
                </div>
              ))}
              {/* Red now line marker in header */}
              {currentHour >= startHour && currentHour <= endHour && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-sg-danger z-30"
                  style={{ left: nowOffsetPx }}
                >
                  <div className="w-2 h-2 rounded-full bg-sg-danger -translate-x-[3px] -translate-y-0.5" />
                </div>
              )}
            </div>
          </div>

          {/* Seat rows */}
          <div className="relative">
            {/* Vertical grid lines */}
            <div className="absolute inset-0 left-24 pointer-events-none">
              {hoursArray.map((_, idx) => (
                <div
                  key={idx}
                  className="absolute top-0 bottom-0 border-l border-sg-line/50"
                  style={{ left: idx * hourWidth }}
                />
              ))}
              {/* Full-height red now line */}
              {currentHour >= startHour && currentHour <= endHour && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-sg-danger z-20 pointer-events-none"
                  style={{ left: nowOffsetPx }}
                />
              )}
            </div>

            {allRows.map((seat) => {
              // Find bookings that occupy this seat
              const seatBookings = bookings.filter(b => b.assigned_seats?.includes(seat.code));

              return (
                <div
                  key={seat.code}
                  className={`flex items-center h-12 border-b border-sg-line hover:bg-sg-paper/20 relative ${
                    seat.isWaiting ? 'bg-sg-paper/10' : ''
                  }`}
                >
                  <div
                    className={`w-24 px-3 py-2 text-[12px] font-bold border-r border-sg-line flex-shrink-0 z-10 truncate ${
                      seat.isWaiting ? 'text-sg-brown bg-sg-brown-soft/40 font-semibold' : 'text-sg-ink bg-white'
                    }`}
                  >
                    {seat.label}
                  </div>

                  <div
                    className="relative flex-1 h-full cursor-pointer"
                    onClick={(e) => {
                      if (onEmptySlotClick) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const clickedHour = startHour + clickX / hourWidth;
                        onEmptySlotClick(seat.code, clickedHour);
                      }
                    }}
                  >
                    {seatBookings.map((b) => {
                      const startDt = new Date(b.start_at);
                      const endDt = new Date(b.end_at);
                      const bStartHour = getTaipeiDecimalHour(startDt);
                      const bEndHour = getTaipeiDecimalHour(endDt);

                      const leftPx = Math.max(0, (bStartHour - startHour) * hourWidth);
                      const widthPx = Math.max(20, (bEndHour - bStartHour) * hourWidth - 4);

                      const isCheckedIn = b.attendance === 'checked_in';
                      const isPaid = b.billing?.status === 'paid' || b.billing?.status === 'waived';
                      const timeStr = `${extractTimeHHMM(b.start_at)}-${extractTimeHHMM(b.end_at)}`;

                      return (
                        <div
                          key={b.booking_ref}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onBookingClick) onBookingClick(b);
                          }}
                          style={{ left: leftPx, width: widthPx }}
                          className={`absolute top-1.5 bottom-1.5 px-2 rounded-xl text-[12px] font-bold flex items-center justify-between border shadow-xs truncate z-10 cursor-pointer active:scale-95 transition ${
                            isCheckedIn
                              ? 'bg-sg-sage-soft text-sg-sage-ink border-sg-sage/40'
                              : 'bg-sg-paper text-sg-ink border-sg-line'
                          }`}
                        >
                          <span className="truncate">
                            {b.name} {b.pax} 位 · {timeStr}
                          </span>
                          {isPaid && <Check className="w-3 h-3 ml-1 shrink-0" />}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

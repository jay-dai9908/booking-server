import React, { useRef, useEffect } from 'react';
import { Check } from 'lucide-react';

export default function TimelineGrid({
  seats = [],
  bookings = [],
  sessions = [],
  onBookingClick = null,
  onEmptySlotClick = null,
  className = ''
}) {
  const containerRef = useRef(null);

  // Time range: 10:00 to 22:00 (12 hours)
  const startHour = 10;
  const endHour = 22;
  const totalHours = endHour - startHour;
  const hourWidth = 80; // pixels per hour
  const timelineWidth = totalHours * hourWidth;

  const now = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const nowOffsetPx = (currentHour - startHour) * hourWidth;

  useEffect(() => {
    // Scroll container to roughly center the 'now' line
    if (containerRef.current && nowOffsetPx > 0) {
      containerRef.current.scrollLeft = Math.max(0, nowOffsetPx - 150);
    }
  }, [nowOffsetPx]);

  const hoursArray = Array.from({ length: totalHours + 1 }, (_, i) => startHour + i);

  return (
    <div
      ref={containerRef}
      className={`overflow-x-auto bg-white border border-sg-line rounded-2xl select-none ${className}`}
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

          {seats.map((seat) => {
            // Find bookings that occupy this seat
            const seatBookings = bookings.filter(b => b.assigned_seats?.includes(seat.code));

            return (
              <div
                key={seat.code}
                className="flex items-center h-12 border-b border-sg-line hover:bg-sg-paper/20 relative"
              >
                <div className="w-24 px-3 py-2 text-[12px] font-bold text-sg-ink border-r border-sg-line flex-shrink-0 bg-white z-10 truncate">
                  {seat.code}
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
                    const bStartHour = startDt.getHours() + startDt.getMinutes() / 60;
                    const bEndHour = endDt.getHours() + endDt.getMinutes() / 60;

                    const leftPx = Math.max(0, (bStartHour - startHour) * hourWidth);
                    const widthPx = Math.max(20, (bEndHour - bStartHour) * hourWidth - 4);

                    const isCheckedIn = b.attendance === 'checked_in';
                    const isPaid = b.billing?.status === 'paid' || b.billing?.status === 'waived';

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
                        <span className="truncate">{b.name}</span>
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
  );
}

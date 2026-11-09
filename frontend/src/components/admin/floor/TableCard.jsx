import React, { useMemo } from 'react';
import SeatTile from './SeatTile';

export default function TableCard({
  table,
  zoneName = '',
  seats = [],
  seatStates = {},
  selectedSeats = [],
  suggestedSeats = [],
  onSeatClick = null,
  className = ''
}) {
  const leftSeats = seats.filter(s => s.side_resolved === 'L' || s.side === 'L');
  const rightSeats = seats.filter(s => s.side_resolved === 'R' || s.side === 'R');
  const isOneSide = table.arrangement === 'one_side' || rightSeats.length === 0;

  // Group summary for header (Round 17 Item 5)
  // e.g. "桌 1 陳大明 4 位 還有 20 分" or "林小美 2 位 · 王小華 16:00 到"
  const groupSummary = useMemo(() => {
    const map = new Map();
    for (const seat of seats) {
      const info = seatStates[seat.code];
      if (!info) continue;
      const ref = info.bookingRef || info.booking?.booking_ref;
      const name = info.paxName || info.booking?.name;
      if (!ref && !name) continue;

      const key = ref || name;
      if (!map.has(key)) {
        map.set(key, {
          name: name || '客人',
          pax: info.booking?.pax || 1,
          seatCount: 1,
          timerText: info.timerText && info.timerText !== '空位' && info.timerText !== '已停用' ? info.timerText : ''
        });
      } else {
        map.get(key).seatCount += 1;
      }
    }

    const summaries = [];
    for (const item of map.values()) {
      const paxText = `${item.pax || item.seatCount} 位`;
      const timePart = item.timerText ? ` ${item.timerText}` : '';
      summaries.push(`${item.name} ${paxText}${timePart}`);
    }
    return summaries.join(' · ');
  }, [seats, seatStates]);

  return (
    <div
      id={`table-card-${table.id}`}
      className={`bg-white rounded-2xl border border-sg-line p-4 shadow-xs space-y-3 scroll-mt-20 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between pb-2 border-b border-sg-line gap-2">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <h3 className="text-[16px] font-bold text-sg-ink shrink-0">{table.label}</h3>
          {groupSummary && (
            <span className="text-[13px] font-bold text-sg-brown truncate">
              {groupSummary}
            </span>
          )}
        </div>
        <span className="text-[12px] font-medium text-sg-muted shrink-0">
          {seats.filter(s => s.is_active).length} 個座位
        </span>
      </div>

      {isOneSide ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {seats.map((seat) => {
            const seatInfo = seatStates[seat.code] || {};
            let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
            if (selectedSeats.includes(seat.code)) state = 'pick';
            else if (suggestedSeats.includes(seat.code)) state = 'sugg';

            return (
              <SeatTile
                key={seat.code}
                code={seat.code}
                state={state}
                isVent={seat.priority === 'last'}
                isPaid={Boolean(seatInfo.isPaid)}
                boards={seatInfo.boards || []}
                timerText={seatInfo.timerText}
                paxName={seatInfo.paxName}
                onClick={onSeatClick ? () => onSeatClick(seat) : null}
              />
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 items-start">
          <div className="space-y-2">
            <div className="text-[11px] font-bold text-sg-muted text-center">左側 (L)</div>
            <div className="space-y-2">
              {leftSeats.map((seat) => {
                const seatInfo = seatStates[seat.code] || {};
                let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
                if (selectedSeats.includes(seat.code)) state = 'pick';
                else if (suggestedSeats.includes(seat.code)) state = 'sugg';

                return (
                  <SeatTile
                    key={seat.code}
                    code={seat.code}
                    state={state}
                    isVent={seat.priority === 'last'}
                    isPaid={Boolean(seatInfo.isPaid)}
                    boards={seatInfo.boards || []}
                    timerText={seatInfo.timerText}
                    paxName={seatInfo.paxName}
                    onClick={onSeatClick ? () => onSeatClick(seat) : null}
                  />
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[11px] font-bold text-sg-muted text-center">右側 (R)</div>
            <div className="space-y-2">
              {rightSeats.map((seat) => {
                const seatInfo = seatStates[seat.code] || {};
                let state = seatInfo.state || (seat.is_active ? 'empty' : 'off');
                if (selectedSeats.includes(seat.code)) state = 'pick';
                else if (suggestedSeats.includes(seat.code)) state = 'sugg';

                return (
                  <SeatTile
                    key={seat.code}
                    code={seat.code}
                    state={state}
                    isVent={seat.priority === 'last'}
                    isPaid={Boolean(seatInfo.isPaid)}
                    boards={seatInfo.boards || []}
                    timerText={seatInfo.timerText}
                    paxName={seatInfo.paxName}
                    onClick={onSeatClick ? () => onSeatClick(seat) : null}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

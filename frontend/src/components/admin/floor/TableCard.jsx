import React from 'react';
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

  return (
    <div
      id={`table-card-${table.id}`}
      className={`bg-white rounded-2xl border border-sg-line p-4 shadow-xs space-y-3 scroll-mt-20 ${className}`}
    >
      <div className="flex items-center justify-between pb-2 border-b border-sg-line">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[16px] font-bold text-sg-ink">{table.label}</h3>
        </div>
        <span className="text-[12px] font-medium text-sg-muted">
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

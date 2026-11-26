// frontend/src/components/display/DisplayInfoCards.jsx
import React from 'react';
import {
  DAY_TYPE_LABELS,
  computeSeatVisualState,
  formatTaipeiHHmm
} from '../../utils/display/seatStatus';

/**
 * Right column rotating info cards:
 * 1. seats: 現在可以入座
 * 2. soon: 時間快到了
 * 3. price: 今日價目
 */
export default function DisplayInfoCards({
  cardsConfig = { seats: true, soon: true, price: true },
  seats = [],
  floorSeats = [],
  cardsData = null,
  price = null,
  dayType = 'weekday',
  nowMs,
  soonMinutes = 10,
  timeMode = 'remain',
  cardIdx = 0
}) {
  const activeCards = [];

  if (cardsConfig?.seats !== false) {
    const freeCount = cardsData?.free_seats ?? cardsData?.free_count ?? (() => {
      const total = Array.isArray(floorSeats) ? floorSeats.length : 0;
      const occCodes = new Set((seats || []).filter(s => s.state !== 'booked').map(s => s.code));
      return Math.max(0, total - occCodes.size);
    })();

    const nextFreeAt = cardsData?.next_available?.at ?? cardsData?.next_free?.at ?? cardsData?.next_free_at ?? null;
    const nextFreeCount = cardsData?.next_available?.count ?? cardsData?.next_free?.count ?? cardsData?.next_free_count ?? 0;
    const bookedSoonCount = cardsData?.booked_within_hour ?? cardsData?.booked_within_1h ?? cardsData?.booked_soon_count ?? 0;

    activeCards.push({
      key: 'seats',
      content: (
        <>
          <h3 className="font-display font-bold text-sg-ink" style={{ fontSize: 42, letterSpacing: '0.04em' }}>
            現在可以入座
          </h3>
          <div className="font-num font-extrabold text-sg-sage-ink" style={{ fontSize: 116, lineHeight: 1 }}>
            {freeCount}
            <small className="font-body font-bold text-sg-ink" style={{ fontSize: 40, marginLeft: 12 }}>
              個空位
            </small>
          </div>
          <p className="m-0 text-sg-ink" style={{ fontSize: 29, lineHeight: 1.55 }}>
            {nextFreeAt && nextFreeCount > 0 ? (
              <>
                約 <b>{formatTaipeiHHmm(nextFreeAt)}</b> 再空出 {nextFreeCount} 個位子。
              </>
            ) : (
              '目前沒有預計空出的位子。'
            )}
            {bookedSoonCount > 0 && (
              <>
                <br />
                其中 {bookedSoonCount} 個位子 1 小時內有預約。
              </>
            )}
          </p>
          <p className="m-0 text-sg-muted" style={{ fontSize: 27 }}>
            現場入座請找櫃檯店員
          </p>
        </>
      )
    });
  }

  if (cardsConfig?.soon !== false) {
    const groups = new Map();
    for (const seat of seats || []) {
      const st = computeSeatVisualState(seat, { nowMs, soonMinutes, timeMode });
      if (st.cls === 'soon' || st.cls === 'over') {
        const mins = Math.round((st.remainSeconds || 0) / 60);
        const key = `${st.cls}|${mins}`;
        if (!groups.has(key)) groups.set(key, { cls: st.cls, mins, codes: [] });
        groups.get(key).codes.push(seat.code);
      }
    }

    const seatRows = Array.from(groups.values())
      .sort((a, b) => a.mins - b.mins)
      .slice(0, 4)
      .map(g => ({
        key: `seat-${g.cls}-${g.mins}`,
        isOver: g.cls === 'over',
        label: g.codes.join('、'),
        timeLabel: g.mins < 0 ? `超過 ${-g.mins} 分` : (g.mins === 0 ? '時間到' : `剩 ${g.mins} 分`)
      }));

    const expiringBoards = Array.isArray(cardsData?.expiring_boards)
      ? cardsData.expiring_boards
      : (Array.isArray(cardsData?.boards_soon) ? cardsData.boards_soon : []);

    const boardRows = expiringBoards.map((b, idx) => {
      const endMs = b.ends_at ? new Date(b.ends_at).getTime() : NaN;
      const leftMins = Number.isFinite(endMs) ? Math.round((endMs - nowMs) / 60000) : 0;
      const isOver = leftMins <= 0;
      const nameStr = String(b.name || '智能板');
      const label = nameStr.startsWith('智能') ? nameStr : `智能${nameStr}`;
      return {
        key: `board-${idx}-${b.name}`,
        isOver,
        label,
        timeLabel: isOver ? `超過 ${Math.abs(leftMins)} 分` : `剩 ${leftMins} 分`
      };
    });

    const rows = [...seatRows, ...boardRows];

    activeCards.push({
      key: 'soon',
      content: (
        <>
          <h3 className="font-display font-bold text-sg-ink" style={{ fontSize: 42, letterSpacing: '0.04em' }}>
            時間快到了
          </h3>
          {rows.length > 0 ? (
            <div>
              {rows.map(r => (
                <div
                  key={r.key}
                  className="flex justify-between items-center border-b-2 border-dashed border-sg-line"
                  style={{ gap: 16, fontSize: 29, padding: '12px 0' }}
                >
                  <span className="truncate">{r.label}</span>
                  <b
                    className="font-num font-extrabold whitespace-nowrap"
                    style={{
                      fontSize: 32,
                      color: r.isOver ? '#B4553F' : '#8A5E1F'
                    }}
                  >
                    {r.timeLabel}
                  </b>
                </div>
              ))}
            </div>
          ) : (
            <p className="m-0 text-sg-ink" style={{ fontSize: 29, lineHeight: 1.55 }}>
              目前沒有快到時間的座位。
            </p>
          )}
          <p className="m-0 text-sg-muted" style={{ fontSize: 27, marginTop: 6 }}>
            想延長請告訴店員
          </p>
        </>
      )
    });
  }

  if (cardsConfig?.price !== false) {
    const hourly = price?.hourly ?? price?.hourly_price ?? 0;
    const unlimited = price?.unlimited ?? price?.unlimited_price ?? 0;
    const allowUnlimited = price?.allow_unlimited !== false && unlimited > 0;
    const boards = Array.isArray(price?.boards) ? price.boards : [];
    const discount = price?.board_discount;
    const promoText = price?.promo_text || (
      discount?.enabled && discount?.buy_hours && discount?.free_hours
        ? `智能板買 ${discount.buy_hours} 小時送 ${discount.free_hours} 小時`
        : ''
    );
    const dayLabel = DAY_TYPE_LABELS[dayType] || DAY_TYPE_LABELS.weekday;

    activeCards.push({
      key: 'price',
      content: (
        <>
          <h3 className="font-display font-bold text-sg-ink" style={{ fontSize: 42, letterSpacing: '0.04em' }}>
            今日價目
          </h3>
          <div
            className="grid items-baseline text-sg-ink"
            style={{
              gridTemplateColumns: '1fr auto',
              gap: '10px 16px',
              fontSize: 28
            }}
          >
            <span>計時（每位每小時）</span>
            <b className="font-num font-extrabold" style={{ fontSize: 36 }}>
              NT${hourly}
            </b>

            {allowUnlimited && (
              <>
                <span>不限時（每位）</span>
                <b className="font-num font-extrabold" style={{ fontSize: 36 }}>
                  NT${unlimited}
                </b>
              </>
            )}

            {boards.map((b, i) => (
              <React.Fragment key={b.id || b.name || i}>
                <span>{String(b.name || '').startsWith('智能') ? b.name : `智能板 ${b.name}`}</span>
                <b className="font-num font-extrabold" style={{ fontSize: 36 }}>
                  NT${b.hourly_rate ?? b.price ?? 0}
                  <small className="font-body font-normal text-sg-muted" style={{ fontSize: 24 }}>
                    /時
                  </small>
                </b>
              </React.Fragment>
            ))}

            <small
              className="text-sg-muted"
              style={{ gridColumn: '1 / -1', fontSize: 24, marginTop: 2 }}
            >
              {promoText ? `${promoText} · ` : ''}{dayLabel}價格
            </small>
          </div>
        </>
      )
    });
  }

  if (activeCards.length === 0) return null;

  const idx = cardIdx % activeCards.length;
  const active = activeCards[idx];

  return (
    <div
      data-testid={`display-info-card-${active.key}`}
      className="bg-sg-paper relative overflow-hidden flex-1 flex flex-col"
      style={{
        borderRadius: 40,
        boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
        padding: '38px 40px',
        gap: 20
      }}
    >
      {active.content}
      <div className="mt-auto flex" style={{ gap: 12 }}>
        {activeCards.map((c, n) => (
          <span
            key={c.key}
            className={`rounded-full ${n === idx ? 'bg-sg-peach' : 'bg-sg-line'}`}
            style={{ width: 16, height: 16 }}
          />
        ))}
      </div>
    </div>
  );
}

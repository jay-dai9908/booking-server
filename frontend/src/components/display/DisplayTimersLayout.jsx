// frontend/src/components/display/DisplayTimersLayout.jsx
import React from 'react';
import DisplayFloorMap from './DisplayFloorMap';
import DisplayInfoCards from './DisplayInfoCards';
import DisplaySelfSide from './DisplaySelfSide';
import { BEAD_COLORS } from '../../utils/display/seatStatus';

function LegendItem({ cls, label }) {
  const c = BEAD_COLORS[cls];
  return (
    <span className="flex items-center whitespace-nowrap" style={{ gap: 10 }}>
      <i
        className="inline-block"
        style={{
          width: 36,
          height: 28,
          borderRadius: 7,
          background: c.bg,
          border: `3px ${cls === 'booked' ? 'dashed' : 'solid'} ${c.bd}`
        }}
      />
      {label}
    </span>
  );
}

/**
 * Floor map + legend bar on left, info cards (timers) or LINE+notices (timers_self) on right.
 */
export default function DisplayTimersLayout({
  selfMode = false,
  floorMap,
  rotation = 90,
  hereElement = '',
  seats = [],
  nowMs,
  soonMinutes = 10,
  timeMode = 'remain',
  cardsConfig,
  cardsData,
  price,
  dayType,
  cardIdx = 0,
  line = {},
  notices = []
}) {
  return (
    <div
      data-testid={selfMode ? 'display-layout-timers-self' : 'display-layout-timers'}
      className="absolute grid"
      style={{
        left: 64,
        right: 64,
        top: 150,
        bottom: 108,
        gridTemplateColumns: '1fr 440px',
        gap: 30
      }}
    >
      {/* Left: Floor Map Card + Legend */}
      <div
        className="bg-sg-paper relative overflow-hidden flex flex-col"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
          padding: '16px 20px 12px'
        }}
      >
        <DisplayFloorMap
          floor={floorMap}
          rotation={rotation}
          hereElement={hereElement}
          seats={seats}
          nowMs={nowMs}
          soonMinutes={soonMinutes}
          timeMode={timeMode}
        />

        <div
          className="flex items-center justify-between"
          style={{ gap: 20, padding: '4px 16px 0' }}
        >
          <div
            data-testid="display-legend"
            className="flex flex-nowrap text-sg-muted"
            style={{ gap: 18, fontSize: 21 }}
          >
            <LegendItem cls="run" label={timeMode === 'used' ? '計時中' : '剩餘時間'} />
            <LegendItem cls="soon" label={`剩 ${soonMinutes} 分內`} />
            <LegendItem cls="over" label="已超時" />
            <LegendItem cls="unl" label="不限時" />
            <LegendItem cls="paused" label="暫停過" />
            <LegendItem cls="booked" label="已預約" />
            <span className="flex items-center whitespace-nowrap" style={{ gap: 10 }}>
              <b
                className="inline-flex items-center justify-center font-body font-bold"
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: '#D9A441',
                  color: '#FFFDF9',
                  fontSize: 13
                }}
              >
                板
              </b>
              有租智能板
            </span>
          </div>
          <small className="text-sg-muted whitespace-nowrap" style={{ fontSize: 23 }}>
            計時從預約時間開始
          </small>
        </div>
      </div>

      {/* Right Column */}
      <div className="flex flex-col min-h-0" style={{ gap: 28 }}>
        {selfMode ? (
          <DisplaySelfSide line={line} notices={notices} compactQr />
        ) : (
          <DisplayInfoCards
            cardsConfig={cardsConfig}
            seats={seats}
            floorSeats={floorMap?.seats || []}
            cardsData={cardsData}
            price={price}
            dayType={dayType}
            nowMs={nowMs}
            soonMinutes={soonMinutes}
            timeMode={timeMode}
            cardIdx={cardIdx}
          />
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect, useMemo } from 'react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import api from '../../../api/axios';
import { bookingTimeRange } from '../../../utils/admin/floorSelectors';
import { shortBoardName } from '../../../utils/customer/pricing';

export default function CheckInPanel({
  isOpen,
  onClose,
  target,
  activeSeats: propActiveSeats,
  seatStatesMap: propSeatStatesMap,
  layout: propLayout,
  onSuccess
}) {
  const [selectedSeats, setSelectedSeats] = useState([]);
  const [boardAssign, setBoardAssign] = useState({});
  const [startTimer, setStartTimer] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [loadedSeats, setLoadedSeats] = useState([]);
  const [loadedSeatStates, setLoadedSeatStates] = useState({});
  const [loadedLayout, setLoadedLayout] = useState(null);

  useEffect(() => {
    if (!target) return;
    setSelectedSeats(target.assigned_seats || []);
    setStartTimer(true);
    setError(null);

    // Initial board assignment
    const initialAssign = {};
    const bds = target.boards || target.equipments || [];
    bds.forEach((bd, idx) => {
      const assignedSeat = target.assigned_seats?.[idx] || target.assigned_seats?.[0] || '';
      initialAssign[bd.unit_group || bd.id || idx] = assignedSeat;
    });
    setBoardAssign(initialAssign);

    // If activeSeats or seatStatesMap not provided, fetch from /floor/live
    if (!propActiveSeats || propActiveSeats.length === 0) {
      const targetDate = target.session?.session_date
        ? String(target.session.session_date).slice(0, 10)
        : target.start_at
        ? target.start_at.slice(0, 10)
        : '';
      api.get(`/floor/live${targetDate ? `?date=${targetDate}` : ''}`)
        .then(res => {
          const lSeats = (res.data?.layout?.seats || []).filter(s => s.is_active);
          setLoadedSeats(lSeats);
          setLoadedLayout(res.data?.layout || null);

          const sMap = {};
          for (const s of lSeats) {
            sMap[s.code] = { state: 'empty' };
          }
          for (const b of (res.data?.bookings || [])) {
            if (b.attendance === 'checked_in') {
              for (const sc of (b.assigned_seats || [])) {
                sMap[sc] = { state: 'in_use' };
              }
            }
          }
          setLoadedSeatStates(sMap);
        })
        .catch(err => {
          console.error('[CheckInPanel] Error loading floor live data:', err);
        });
    }
  }, [target, propActiveSeats]);

  const activeSeats = (propActiveSeats && propActiveSeats.length > 0) ? propActiveSeats : loadedSeats;
  const seatStatesMap = propSeatStatesMap || loadedSeatStates;
  const layout = propLayout || loadedLayout;

  // Group activeSeats into CompactPlan (Zones -> Tables -> Left/Right sides)
  const groupedPlan = useMemo(() => {
    const zoneMap = new Map();

    activeSeats.forEach(s => {
      // 1. Determine zone
      let zoneName = s.zone?.name || s.zone_name;
      if (!zoneName && layout?.zones && s.zone_id) {
        zoneName = layout.zones.find(z => z.id === s.zone_id)?.name;
      }
      if (!zoneName) {
        const match = s.code.match(/^([A-Za-z]+)/);
        zoneName = match ? `${match[1].toUpperCase()}區` : '全區';
      }
      if (!zoneMap.has(zoneName)) zoneMap.set(zoneName, new Map());
      const tableMap = zoneMap.get(zoneName);

      // 2. Determine table
      let tableLabel = s.table?.label || s.table_label;
      if (!tableLabel && layout?.tables && s.table_id) {
        tableLabel = layout.tables.find(t => t.id === s.table_id)?.label;
      }
      if (!tableLabel) {
        const match = s.code.match(/^([A-Za-z0-9]+)-/);
        tableLabel = match ? `桌 ${match[1]}` : '一般桌';
      }
      if (!tableMap.has(tableLabel)) {
        tableMap.set(tableLabel, { left: [], right: [] });
      }
      const tableObj = tableMap.get(tableLabel);

      // 3. Determine side
      const side = (s.side || '').toUpperCase();
      if (side === 'R') {
        tableObj.right.push(s);
      } else if (side === 'L') {
        tableObj.left.push(s);
      } else {
        tableObj.left.push(s);
      }
    });

    const result = [];
    for (const [zName, tableMap] of zoneMap.entries()) {
      const tables = [];
      for (const [tLabel, sides] of tableMap.entries()) {
        sides.left.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
        sides.right.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

        // Auto balance if all seats fell into left side
        if (sides.right.length === 0 && sides.left.length > 1) {
          const half = Math.ceil(sides.left.length / 2);
          sides.right = sides.left.slice(half);
          sides.left = sides.left.slice(0, half);
        }

        tables.push({ label: tLabel, left: sides.left, right: sides.right });
      }
      result.push({ zone: zName, tables });
    }
    return result;
  }, [activeSeats, layout]);

  const handleSubmit = async (deferSeating = false) => {
    if (!target) return;
    try {
      setIsSubmitting(true);
      setError(null);

      const boardAssignments = Object.entries(boardAssign).map(([uGroup, sCode]) => {
        const pIdx = selectedSeats.indexOf(sCode);
        return {
          unit_group: uGroup,
          person_no: pIdx >= 0 ? pIdx + 1 : 1
        };
      });

      const res = await api.post(`/floor/${target.booking_ref}/check-in`, {
        seats: deferSeating ? [] : selectedSeats,
        board_assignments: boardAssignments,
        start_timer: deferSeating ? false : startTimer,
        defer_seating: deferSeating
      });

      if (onSuccess) {
        onSuccess(res.data, deferSeating);
      }
      onClose();
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409) {
        setError(err.response?.data?.error || err.response?.data?.message || '座位已被鎖定，請選其他座位');
      } else {
        setError(err.response?.data?.error || err.response?.data?.message || '報到帶位失敗');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen || !target) return null;

  const timeRangeText = bookingTimeRange(target);
  const pax = target.pax || 1;
  const reasonText = target.allocation_reason || target.reason || '已避開冷氣出風口並優先安排同側或相鄰座位。';

  const boardsList = (target.boards && target.boards.length > 0)
    ? target.boards
    : (target.equipments && target.equipments.length > 0)
    ? target.equipments.filter(e => (e.equipment_id || e.id) !== 'bring_own')
    : [];

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="報到並帶位"
      subtitle={`${target.name || '現場客人'} · ${pax} 位 · ${timeRangeText}`}
      footer={
        <div className="space-y-2">
          {error && (
            <div className="p-2.5 rounded-xl bg-sg-danger-soft text-sg-danger text-[12px] font-bold">
              {error}
            </div>
          )}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => handleSubmit(true)}
              className="text-[13px] text-sg-brown font-bold hover:underline"
            >
              只報到，稍後再帶位
            </button>
            <Button
              variant="primary"
              size="md"
              onClick={() => handleSubmit(false)}
              loading={isSubmitting}
              disabled={selectedSeats.length === 0}
            >
              {startTimer ? '入座並開始計時' : '入座'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 py-2">
        {/* Allocator suggestion box */}
        <div className="p-3 rounded-2xl bg-sg-brown-soft text-[12px] text-sg-brown border border-sg-brown/20 space-y-1">
          <span className="font-bold block">
            系統建議座位：{target.assigned_seats?.join('、') || '自動指派'}
          </span>
          <span className="text-[11px] opacity-90">{reasonText}</span>
        </div>

        {/* Seat selection - CompactPlan (Spec 6.3) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-bold text-sg-ink">
              選擇入座座位（已選 {selectedSeats.length} / {pax} 位）
            </span>
            {selectedSeats.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedSeats([])}
                className="text-[11px] text-sg-brown hover:underline"
              >
                清除重選
              </button>
            )}
          </div>

          <div className="space-y-3">
            {groupedPlan.map((z) => (
              <div key={z.zone} className="space-y-1.5">
                <div className="text-[11px] font-bold text-sg-muted uppercase tracking-wider px-1">
                  {z.zone}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {z.tables.map((t) => (
                    <div key={t.label} className="border border-sg-line rounded-2xl p-2.5 bg-sg-paper/40 space-y-2">
                      <div className="text-[12px] font-bold text-sg-ink px-1 flex items-center justify-between">
                        <span>{t.label}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        {/* Left column */}
                        <div className="space-y-1.5">
                          <div className="text-[10px] text-sg-muted font-bold text-center">左側</div>
                          {t.left.map((s) => {
                            const isSelected = selectedSeats.includes(s.code);
                            const isOccupied = seatStatesMap[s.code]?.state === 'in_use' && !target.assigned_seats?.includes(s.code);

                            return (
                              <button
                                key={s.code}
                                type="button"
                                disabled={isOccupied}
                                onClick={() => {
                                  if (isSelected) {
                                    setSelectedSeats(selectedSeats.filter(c => c !== s.code));
                                  } else {
                                    if (selectedSeats.length < pax) {
                                      setSelectedSeats([...selectedSeats, s.code]);
                                    }
                                  }
                                }}
                                className={`w-full p-2 rounded-xl border text-center transition ${
                                  isOccupied
                                    ? 'bg-sg-paper text-sg-muted border-sg-line cursor-not-allowed opacity-50'
                                    : isSelected
                                    ? 'bg-sg-brown text-white border-sg-brown font-bold shadow-sm'
                                    : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                                }`}
                              >
                                <span className="block text-[13px] font-num">{s.code}</span>
                                <span className="block text-[10px] opacity-80">{isOccupied ? '有人' : isSelected ? '已選' : '空位'}</span>
                              </button>
                            );
                          })}
                        </div>

                        {/* Right column */}
                        <div className="space-y-1.5">
                          <div className="text-[10px] text-sg-muted font-bold text-center">右側</div>
                          {t.right.length > 0 ? (
                            t.right.map((s) => {
                              const isSelected = selectedSeats.includes(s.code);
                              const isOccupied = seatStatesMap[s.code]?.state === 'in_use' && !target.assigned_seats?.includes(s.code);

                              return (
                                <button
                                  key={s.code}
                                  type="button"
                                  disabled={isOccupied}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedSeats(selectedSeats.filter(c => c !== s.code));
                                    } else {
                                      if (selectedSeats.length < pax) {
                                        setSelectedSeats([...selectedSeats, s.code]);
                                      }
                                    }
                                  }}
                                  className={`w-full p-2 rounded-xl border text-center transition ${
                                    isOccupied
                                      ? 'bg-sg-paper text-sg-muted border-sg-line cursor-not-allowed opacity-50'
                                      : isSelected
                                      ? 'bg-sg-brown text-white border-sg-brown font-bold shadow-sm'
                                      : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                                  }`}
                                >
                                  <span className="block text-[13px] font-num">{s.code}</span>
                                  <span className="block text-[10px] opacity-80">{isOccupied ? '有人' : isSelected ? '已選' : '空位'}</span>
                                </button>
                              );
                            })
                          ) : (
                            <div className="h-12 flex items-center justify-center text-[10px] text-sg-muted bg-white/40 rounded-xl border border-dashed border-sg-line/60">
                              無
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Smart Board assignment (Spec 6.3 item 8) */}
        {boardsList.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-sg-line">
            <span className="text-[13px] font-bold text-sg-ink block">智能板分配給哪一位</span>
            {boardsList.map((bd, bIdx) => {
              const bKey = bd.unit_group || bd.id || bIdx;
              const bdName = shortBoardName(bd.name || bd.equipment_name_snapshot || '智能板');
              return (
                <div key={bKey} className="flex flex-col sm:flex-row sm:items-center justify-between p-2.5 rounded-xl bg-sg-paper/50 border border-sg-line text-[12px] gap-2">
                  <span className="font-bold text-sg-ink">
                    {bdName} #{bIdx + 1}
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {selectedSeats.length === 0 ? (
                      <span className="text-[11px] text-sg-muted">請先在上方選取座位</span>
                    ) : (
                      selectedSeats.map((sCode, pIdx) => (
                        <button
                          key={sCode}
                          type="button"
                          onClick={() => setBoardAssign(prev => ({ ...prev, [bKey]: sCode }))}
                          className={`px-2.5 py-1 rounded-lg font-bold border transition text-[11px] ${
                            boardAssign[bKey] === sCode
                              ? 'bg-sg-brown text-white border-sg-brown shadow-xs'
                              : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                          }`}
                        >
                          第 {pIdx + 1} 位 ({sCode})
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Start timer toggle with shared switch style */}
        <div className="pt-2 border-t border-sg-line flex items-center justify-between">
          <span className="text-[13px] font-bold text-sg-ink">入座後立即開始計時</span>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={startTimer}
              onChange={(e) => setStartTimer(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-sg-line peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-sg-line after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sg-brown"></div>
          </label>
        </div>
      </div>
    </ResponsivePanel>
  );
}

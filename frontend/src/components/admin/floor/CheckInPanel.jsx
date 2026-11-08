import React, { useState, useEffect } from 'react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import api from '../../../api/axios';
import { bookingTimeRange } from '../../../utils/admin/floorSelectors';

export default function CheckInPanel({
  isOpen,
  onClose,
  target,
  activeSeats: propActiveSeats,
  seatStatesMap: propSeatStatesMap,
  onSuccess
}) {
  const [selectedSeats, setSelectedSeats] = useState([]);
  const [boardAssign, setBoardAssign] = useState({});
  const [startTimer, setStartTimer] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [loadedSeats, setLoadedSeats] = useState([]);
  const [loadedSeatStates, setLoadedSeatStates] = useState({});

  useEffect(() => {
    if (!target) return;
    setSelectedSeats(target.assigned_seats || []);
    setStartTimer(true);
    setError(null);

    // Initial board assignment
    const initialAssign = {};
    const bds = target.boards || [];
    bds.forEach((bd, idx) => {
      const assignedSeat = target.assigned_seats?.[idx] || target.assigned_seats?.[0] || '';
      initialAssign[bd.unit_group || idx] = assignedSeat;
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

  const timeRangeText = target.time_range || bookingTimeRange(target);
  const pax = target.pax || 1;

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
          <span className="text-[11px] opacity-90">已避開冷氣出風口並優先安排同側或相鄰座位。</span>
        </div>

        {/* Seat selection */}
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

          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {activeSeats.map((s) => {
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
                  className={`p-2.5 rounded-xl border text-center transition ${
                    isOccupied
                      ? 'bg-sg-paper text-sg-muted border-sg-line cursor-not-allowed opacity-50'
                      : isSelected
                      ? 'bg-sg-brown text-white border-sg-brown font-bold'
                      : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                  }`}
                >
                  <span className="block text-[13px] font-num">{s.code}</span>
                  <span className="block text-[10px] opacity-80">{isOccupied ? '有人' : isSelected ? '已選' : '空位'}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Smart Board assignment */}
        {(target.boards || []).length > 0 && (
          <div className="space-y-2 pt-2 border-t border-sg-line">
            <span className="text-[13px] font-bold text-sg-ink block">智能板分配給哪一位</span>
            {target.boards.map((bd, bIdx) => (
              <div key={bd.unit_group || bIdx} className="flex items-center justify-between p-2.5 rounded-xl bg-sg-paper/40 border border-sg-line text-[12px]">
                <span className="font-bold text-sg-ink">
                  智能板 #{bIdx + 1}
                </span>
                <div className="flex items-center gap-1.5">
                  {selectedSeats.map((sCode) => (
                    <button
                      key={sCode}
                      type="button"
                      onClick={() => setBoardAssign(prev => ({ ...prev, [bd.unit_group || bIdx]: sCode }))}
                      className={`px-2.5 py-1 rounded-lg font-bold border transition ${
                        boardAssign[bd.unit_group || bIdx] === sCode
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line'
                      }`}
                    >
                      {sCode}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Start timer toggle */}
        <div className="pt-2 border-t border-sg-line flex items-center justify-between">
          <span className="text-[13px] font-bold text-sg-ink">入座後立即開始計時</span>
          <input
            type="checkbox"
            checked={startTimer}
            onChange={(e) => setStartTimer(e.target.checked)}
            className="w-5 h-5 rounded text-sg-brown focus:ring-sg-brown cursor-pointer"
          />
        </div>
      </div>
    </ResponsivePanel>
  );
}

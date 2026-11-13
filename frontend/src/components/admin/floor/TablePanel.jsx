import React, { useState, useMemo, useEffect, useRef } from 'react';
import { X, MoreVertical, Plus, UserCheck, ArrowRightLeft, CreditCard, Clock, LogOut, FileText, Pause, Play, AlertCircle } from 'lucide-react';
import api from '../../../api/axios';
import { formatElapsedText } from '../../../utils/admin/floorSelectors';

export default function TablePanel({
  isOpen,
  onClose,
  table,
  seats = [],
  seatStates = {},
  bookings = [],
  onCheckout,
  onDetails,
  onCheckIn,
  onExtendTime,
  onMoveGroup,
  onTimerAction,
  onOpenSeatAction,
  onMoveSeat,
  onSwapBoard,
  onAddBoard,
  onForceAdd,
  refresh,
  serverNow,
  showToast
}) {
  const [addingPersonForRef, setAddingPersonForRef] = useState(null);
  const [menuOpenKey, setMenuOpenKey] = useState(null);
  const menuRef = useRef(null);

  // Close popup menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpenKey(null);
      }
    };
    if (menuOpenKey) {
      document.addEventListener('pointerdown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [menuOpenKey]);

  if (!isOpen || !table) return null;

  // Active seats belonging to this table
  const tableSeats = seats.filter(s => s.is_active);
  const totalSeats = tableSeats.length;

  // Count occupied / in-use seats
  const inUseSeats = tableSeats.filter(s => {
    const st = seatStates[s.code]?.state;
    return st === 'in_use' || st === 'run' || st === 'warn' || st === 'over' || st === 'paused' || st === 'reserved';
  }).length;

  // Available empty seats at this table
  const emptySeatsAtTable = tableSeats.filter(s => {
    const st = seatStates[s.code];
    return !st?.booking && (!st?.state || st?.state === 'empty');
  });

  // Collect distinct groups (bookings) currently seated or reserved at this table
  const tableSeatCodes = new Set(tableSeats.map(s => s.code));
  const distinctGroupRefs = [];

  for (const s of tableSeats) {
    const st = seatStates[s.code];
    const ref = st?.bookingRef || st?.booking?.booking_ref;
    if (ref && !distinctGroupRefs.includes(ref)) {
      distinctGroupRefs.push(ref);
    }
  }

  // Also include bookings whose assigned_seats touch this table but not completed
  for (const b of bookings) {
    if (b.status === 'cancelled' || b.attendance === 'completed') continue;
    const touchesTable = (b.assigned_seats || []).some(code => tableSeatCodes.has(code));
    if (touchesTable && !distinctGroupRefs.includes(b.booking_ref)) {
      distinctGroupRefs.push(b.booking_ref);
    }
  }

  const groups = distinctGroupRefs.map(ref => {
    return bookings.find(b => b.booking_ref === ref) || { booking_ref: ref, name: '客人', pax: 1, attendance: 'checked_in', booking_persons: [] };
  });

  // Handle "＋ 為這組加人"
  const handleAddPersonToGroup = async (booking) => {
    if (emptySeatsAtTable.length === 0) {
      if (showToast) {
        showToast('這桌沒有空位，請先整組換桌或選其他座位');
      }
      return;
    }

    const targetSeat = emptySeatsAtTable[0];
    setAddingPersonForRef(booking.booking_ref);
    try {
      await api.post(`/floor/${booking.booking_ref}/persons`, {
        seat_code: targetSeat.code
      });
      if (refresh) await refresh();
      if (showToast) showToast('已為本組加 1 人');
    } catch (err) {
      console.error('[TablePanel] Add person error:', err);
      if (showToast) {
        showToast(err.response?.data?.error || err.response?.data?.message || '加人失敗');
      }
    } finally {
      setAddingPersonForRef(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-sg-ink/50 backdrop-blur-xs animate-fade-in">
      {/* Drawer / Modal Container */}
      <div
        className="w-full max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl border border-sg-line flex flex-col max-h-[90vh] overflow-hidden animate-slide-up"
        role="dialog"
        aria-modal="true"
        data-testid="table-management-panel"
      >
        {/* Header (標題：「A1 · 使用中 3 / 4 位」) */}
        <div className="px-5 py-4 border-b border-sg-line/70 flex items-center justify-between bg-sg-paper/80 shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-bold text-sg-ink" data-testid="table-panel-title">
              {table.label} · 使用中 {inUseSeats} / {totalSeats} 位
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sg-muted hover:text-sg-ink hover:bg-sg-paper transition cursor-pointer"
            aria-label="關閉"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1">
          {groups.length === 0 ? (
            <div className="py-8 text-center text-sg-muted text-[13px] bg-sg-paper/40 rounded-2xl border border-sg-line/60">
              此桌目前無客人入座
            </div>
          ) : (
            groups.map((group, idx) => {
              const isCheckedIn = group.attendance === 'checked_in';
              const isPending = group.attendance === 'pending' || !group.attendance;
              const persons = group.persons || group.booking_persons || [];

              const getPersonTimer = (p) => p?.timer || p || {};

              // Check if all active persons are paused
              const activePersons = persons.filter(p => p.status === 'active' && !getPersonTimer(p).timer_ended_at);
              const allPaused = activePersons.length > 0 && activePersons.every(p => Boolean(getPersonTimer(p).paused_at));

              return (
                <div
                  key={group.booking_ref}
                  className="bg-white rounded-2xl border border-sg-line p-3.5 shadow-xs space-y-3"
                  data-testid={`group-card-${idx + 1}`}
                  data-booking-ref={group.booking_ref}
                >
                  {/* Top: Group Badge, Name, Pax, Status */}
                  <div className="flex items-center justify-between pb-2 border-b border-sg-line/60 flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      {groups.length > 1 && (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-sg-brown text-white">
                          第 {idx + 1} 組
                        </span>
                      )}
                      <span className="text-[15px] font-bold text-sg-ink">{group.name || '客人'}</span>
                      <span className="text-[13px] font-medium text-sg-muted" data-testid={`group-pax-${idx + 1}`}>
                        {group.pax} 位
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      {isCheckedIn ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-sg-sage-soft text-sg-sage-ink border border-sg-sage/30">
                          使用中
                        </span>
                      ) : isPending ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-sg-paper text-sg-brown border border-sg-brown/40">
                          還沒報到
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-gray-100 text-gray-500">
                          已離場
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Group Action Buttons (組的共用按鈕) */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {isCheckedIn && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onCheckout?.(group.booking_ref);
                          }}
                          className="px-3 py-1.5 rounded-xl font-bold text-[12px] bg-sg-brown text-white hover:bg-sg-brown/90 shadow-2xs transition flex items-center gap-1 cursor-pointer"
                        >
                          <CreditCard className="w-3.5 h-3.5" />
                          <span>結帳</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            const personNos = activePersons.map(p => p.person_no);
                            onTimerAction?.(group.booking_ref, personNos, allPaused ? 'resume' : 'pause');
                          }}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          {allPaused ? <Play className="w-3.5 h-3.5 text-sg-sage" /> : <Pause className="w-3.5 h-3.5 text-sg-vent" />}
                          <span>{allPaused ? '全組繼續' : '全組暫停'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onExtendTime?.(group);
                          }}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          <Clock className="w-3.5 h-3.5 text-sg-honey" />
                          <span>加時</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onMoveGroup?.(group)}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5 text-sg-brown" />
                          <span>整組換桌</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onDetails?.(group.booking_ref);
                          }}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5 text-sg-muted" />
                          <span>訂單管理</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            const personNos = activePersons.map(p => p.person_no);
                            onTimerAction?.(group.booking_ref, personNos, 'leave');
                          }}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-danger-soft border border-sg-danger/30 text-sg-danger hover:bg-sg-danger/10 transition flex items-center gap-1 cursor-pointer"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>全組離場</span>
                        </button>
                      </>
                    )}

                    {isPending && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onCheckIn?.(group);
                          }}
                          className="px-3 py-1.5 rounded-xl font-bold text-[12px] bg-sg-brown text-white hover:bg-sg-brown/90 shadow-2xs transition flex items-center gap-1 cursor-pointer"
                        >
                          <UserCheck className="w-3.5 h-3.5" />
                          <span>報到並帶位</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onMoveGroup?.(group)}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          <ArrowRightLeft className="w-3.5 h-3.5 text-sg-brown" />
                          <span>整組換桌</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            onClose();
                            onDetails?.(group.booking_ref);
                          }}
                          className="px-2.5 py-1.5 rounded-xl font-bold text-[12px] bg-sg-paper border border-sg-line text-sg-ink hover:bg-sg-paper/80 transition flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5 text-sg-muted" />
                          <span>訂單管理</span>
                        </button>
                      </>
                    )}
                  </div>

                  {/* Card Person List (卡片內每位一列) */}
                  <div className="space-y-1.5 pt-1">
                    {persons.map((person) => {
                      const seatObj = seats.find(s => s.code === person.seat_code);
                      const seatInfo = seatStates[person.seat_code] || {};
                      const tm = getPersonTimer(person);
                      const isEnded = Boolean(tm.timer_ended_at);
                      const isPaused = Boolean(tm.paused_at && !isEnded);
                      const hasStarted = Boolean(tm.timer_started_at);
                      const elapsedText = isEnded ? '已離場' : (!hasStarted ? '待計時' : formatElapsedText(person, serverNow || new Date()));
                      const currentKey = `${group.booking_ref}-${person.person_no}`;
                      const isMenuOpen = menuOpenKey === currentKey;

                      return (
                        <div
                          key={person.id || person.person_no}
                          onClick={() => onOpenSeatAction?.(seatObj, seatInfo, group)}
                          className="px-3 py-2 rounded-xl bg-sg-paper/50 hover:bg-sg-paper border border-sg-line/70 flex items-center justify-between text-[12px] cursor-pointer transition gap-2 group/row"
                        >
                          {/* Seat & Person No */}
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-num font-bold text-sg-ink px-1.5 py-0.5 rounded bg-white border border-sg-line text-[11px]">
                              {person.seat_code || '未排座'}
                            </span>
                            <span className="text-sg-muted font-medium">第 {person.person_no} 位</span>
                          </div>

                          {/* Timer */}
                          <div className="flex-1 text-center font-num font-bold text-sg-ink truncate">
                            {elapsedText}
                          </div>

                          {/* Actions: Pause/Resume + More (...) */}
                          <div
                            className="flex items-center gap-1 shrink-0"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {!isEnded && hasStarted && (
                              <button
                                type="button"
                                onClick={() => {
                                  onTimerAction?.(group.booking_ref, [person.person_no], isPaused ? 'resume' : 'pause');
                                }}
                                className={`px-2 py-0.5 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                                  isPaused
                                    ? 'bg-sg-sage/15 text-sg-sage border border-sg-sage/30'
                                    : 'bg-white text-sg-muted border border-sg-line hover:text-sg-ink'
                                }`}
                              >
                                {isPaused ? '繼續' : '暫停'}
                              </button>
                            )}

                            {/* Dropdown Menu Trigger */}
                            <div className="relative" ref={isMenuOpen ? menuRef : null}>
                              <button
                                type="button"
                                onClick={() => setMenuOpenKey(isMenuOpen ? null : currentKey)}
                                className="w-6 h-6 rounded-lg flex items-center justify-center text-sg-muted hover:text-sg-ink hover:bg-white transition cursor-pointer"
                                aria-label="更多選項"
                              >
                                <MoreVertical className="w-3.5 h-3.5" />
                              </button>

                              {/* Dropdown Popover */}
                              {isMenuOpen && (
                                <div className="absolute right-0 top-full mt-1 w-32 bg-white rounded-xl shadow-lg border border-sg-line py-1 z-30 text-[12px] space-y-0.5 animate-fade-in">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuOpenKey(null);
                                      onClose();
                                      onMoveSeat?.({ booking: group, fromSeat: person.seat_code, personNo: person.person_no });
                                    }}
                                    className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium transition"
                                  >
                                    換座位
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuOpenKey(null);
                                      onClose();
                                      onSwapBoard?.({ booking: group, personNo: person.person_no });
                                    }}
                                    className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium transition"
                                  >
                                    換板
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuOpenKey(null);
                                      onClose();
                                      onAddBoard?.({ booking: group, personNo: person.person_no });
                                    }}
                                    className="w-full text-left px-3 py-1.5 hover:bg-sg-paper text-sg-ink font-medium transition"
                                  >
                                    加租板
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMenuOpenKey(null);
                                      onTimerAction?.(group.booking_ref, [person.person_no], 'leave');
                                    }}
                                    className="w-full text-left px-3 py-1.5 hover:bg-sg-danger-soft text-sg-danger font-medium transition"
                                  >
                                    離場
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Card bottom: 為這組加人 */}
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={addingPersonForRef === group.booking_ref}
                      onClick={() => handleAddPersonToGroup(group)}
                      data-testid={`add-person-btn-${idx + 1}`}
                      className="w-full py-2 rounded-xl border border-dashed border-sg-brown/50 bg-sg-brown-soft/40 hover:bg-sg-brown-soft text-sg-brown font-bold text-[12px] flex items-center justify-center gap-1 transition cursor-pointer disabled:opacity-50"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>{addingPersonForRef === group.booking_ref ? '加人中…' : '為這組加人'}</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Panel Footer: 新的一組坐這桌 · 空 2 位 (次要樣式) */}
        {emptySeatsAtTable.length > 0 && (
          <div className="p-4 border-t border-sg-line/70 bg-sg-paper/50 shrink-0">
            <button
              type="button"
              onClick={() => {
                onClose();
                onForceAdd?.(null, emptySeatsAtTable.map(s => s.code));
              }}
              data-testid="force-add-table-btn"
              className="w-full py-2.5 rounded-2xl border-2 border-sg-brown/30 bg-white hover:bg-sg-paper text-sg-brown font-bold text-[13px] flex items-center justify-center gap-1.5 shadow-2xs transition cursor-pointer"
            >
              <Plus className="w-4 h-4 text-sg-brown" />
              <span>新的一組坐這桌 · 空 {emptySeatsAtTable.length} 位</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

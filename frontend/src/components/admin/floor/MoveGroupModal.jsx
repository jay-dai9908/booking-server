import React, { useState, useMemo, useEffect } from 'react';
import { X, ArrowRight, ArrowRightLeft, AlertCircle } from 'lucide-react';
import api from '../../../api/axios';

export default function MoveGroupModal({
  isOpen,
  onClose,
  booking,
  layout = {},
  seatStates = {},
  onSuccess,
  showToast
}) {
  const [selectedTableId, setSelectedTableId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setSelectedTableId(null);
      setError(null);
    }
  }, [isOpen, booking?.booking_ref]);

  const persons = useMemo(() => booking?.persons || booking?.booking_persons || [], [booking]);
  const currentSeats = useMemo(() => {
    if (persons.length > 0) {
      const pSeats = persons.map(p => p.seat_code).filter(Boolean);
      if (pSeats.length > 0) return pSeats;
    }
    return booking?.assigned_seats || [];
  }, [persons, booking]);

  const groupPax = persons.length > 0 ? persons.length : (booking?.assigned_seats?.length || booking?.pax || 1);

  // Find table(s) where this group is currently seated
  const currentTableId = useMemo(() => {
    const tableSeats = (layout.seats || []).filter(s => currentSeats.includes(s.code));
    return tableSeats[0]?.table_id || null;
  }, [layout, currentSeats]);

  // Tables with enough empty seats (只列空位夠的桌子)
  const availableTables = useMemo(() => {
    const allTables = layout.tables || [];
    const allSeats = layout.seats || [];

    return allTables.map((t) => {
      if (t.id === currentTableId) return null;

      const tSeats = allSeats
        .filter(s => s.table_id === t.id && s.is_active)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.code.localeCompare(b.code));
      const emptySeats = tSeats.filter(s => {
        const st = seatStates[s.code];
        return !st?.booking && (!st?.state || st?.state === 'empty');
      });

      if (emptySeats.length < groupPax) return null;
      return {
        ...t,
        emptySeats
      };
    }).filter(Boolean);
  }, [layout, currentTableId, seatStates, groupPax]);

  // Target table object
  const selectedTable = useMemo(() => {
    return availableTables.find(t => t.id === selectedTableId) || null;
  }, [availableTables, selectedTableId]);

  const targetSeats = useMemo(() => {
    if (!selectedTable) return [];
    return selectedTable.emptySeats.slice(0, groupPax).map(s => s.code);
  }, [selectedTable, groupPax]);

  // Target seat mappings
  const seatMappings = useMemo(() => {
    if (!selectedTable) return [];
    return currentSeats.map((cSeat, i) => ({
      from: cSeat || `第 ${i + 1} 位`,
      to: targetSeats[i] || `空位 ${i + 1}`
    }));
  }, [selectedTable, currentSeats, targetSeats]);

  if (!isOpen || !booking) return null;

  const handleSubmit = async () => {
    if (!selectedTableId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/floor/${booking.booking_ref}/move-group`, {
        to_table_id: selectedTableId,
        to_seats: targetSeats
      });
      if (showToast) showToast(`已整組換桌至 ${selectedTable?.label}`);
      if (onSuccess) onSuccess();
      onClose();
    } catch (err) {
      console.error('[MoveGroupModal] Error:', err);
      const msg = err.response?.data?.message || err.response?.data?.error || '整組換桌失敗';
      setError(msg);
      if (showToast) showToast(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-sg-ink/50 backdrop-blur-xs animate-fade-in">
      <div
        className="w-full max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl border border-sg-line flex flex-col max-h-[85vh] overflow-hidden animate-slide-up"
        role="dialog"
        aria-modal="true"
        data-testid="move-group-modal"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-sg-line/70 flex items-center justify-between bg-sg-paper/80 shrink-0">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-sg-brown" />
            <h3 className="text-[17px] font-bold text-sg-ink">整組換桌 · {booking.name || '客人'}</h3>
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

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {error && (
            <div className="p-3 rounded-2xl bg-sg-danger-soft border border-sg-danger/30 text-sg-danger text-[13px] flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Step 1: Select target table */}
          <div className="space-y-2">
            <label className="text-[13px] font-bold text-sg-ink block">
              1. 選擇目標桌（需 {groupPax} 個空位）
            </label>

            {availableTables.length === 0 ? (
              <div className="py-6 px-4 text-center text-sg-muted text-[13px] bg-sg-paper/40 rounded-2xl border border-sg-line/60">
                目前沒有其他桌有足夠空位（需 {groupPax} 位）
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2.5">
                {availableTables.map((t) => {
                  const isSelected = t.id === selectedTableId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setSelectedTableId(t.id);
                        setError(null);
                      }}
                      className={`p-3 rounded-2xl border text-left transition cursor-pointer flex flex-col justify-between ${
                        isSelected
                          ? 'border-sg-brown bg-sg-brown-soft text-sg-ink ring-2 ring-sg-brown'
                          : 'border-sg-line bg-white hover:bg-sg-paper text-sg-ink'
                      }`}
                      data-testid={`target-table-btn-${t.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[15px]">{t.label}</span>
                        {isSelected && <span className="w-2 h-2 rounded-full bg-sg-brown" />}
                      </div>
                      <span className="text-[11px] font-medium text-sg-muted mt-1">
                        剩餘 {t.emptySeats.length} 個空位
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Step 2: Show mapping preview: A1-1 → B2-1 */}
          {selectedTable && seatMappings.length > 0 && (
            <div className="space-y-2 pt-2 animate-fade-in">
              <label className="text-[13px] font-bold text-sg-ink block">
                2. 座位對應確認
              </label>
              <div className="bg-sg-paper/60 p-3.5 rounded-2xl border border-sg-line/70 space-y-2">
                {seatMappings.map((pair, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-[13px] font-medium py-1 border-b border-sg-line/40 last:border-0"
                  >
                    <span className="font-num font-bold text-sg-brown px-2 py-0.5 rounded bg-white border border-sg-line/60">
                      {pair.from}
                    </span>
                    <ArrowRight className="w-4 h-4 text-sg-muted" />
                    <span className="font-num font-bold text-sg-sage-ink px-2 py-0.5 rounded bg-sg-sage-soft border border-sg-sage/30">
                      {pair.to}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-sg-line/70 bg-sg-paper/40 flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 rounded-2xl border border-sg-line bg-white text-sg-ink font-bold text-[13px] hover:bg-sg-paper transition cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!selectedTableId || submitting}
            onClick={handleSubmit}
            data-testid="confirm-move-group-btn"
            className="flex-1 py-2.5 rounded-2xl bg-sg-brown text-white font-bold text-[13px] hover:bg-sg-brown/90 transition shadow-sm cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? '換桌中…' : '確定換桌'}
          </button>
        </div>
      </div>
    </div>
  );
}

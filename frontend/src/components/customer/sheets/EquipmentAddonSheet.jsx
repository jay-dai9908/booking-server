import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { format } from 'date-fns';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import Stepper from '../Stepper';
import RangeSlider, { BoardTimeBox } from '../RangeSlider';
import { Divider } from '../Card';
import { ErrorBanner, SoftBox } from '../Banners';
import Bead, { BeadLoader } from '../Bead';
import { useToast } from '../Toast';
import api from '../../../api/axios';
import { formatMoney, formatMinus, formatDateShort, formatBookingRef, formatYMD } from '../../../utils/customer/format';
import {
  buildDiscountConfig,
  shortBoardName,
  equipmentUnitPrice,
  groupUnits,
} from '../../../utils/customer/pricing';
import { boardDiscountTexts } from '../../../utils/customer/discountText';
import { canPlace } from '../../../utils/customer/availability';

/**
 * EquipmentAddonSheet (Section 6.10)
 * Modal bottom sheet for adding or modifying smart boards for an existing reservation.
 */
export default function EquipmentAddonSheet({
  isOpen,
  onClose,
  reservation,
  onSuccess,
}) {
  const toast = useToast();
  const [configs, setConfigs] = useState([]);
  const [availBySession, setAvailBySession] = useState({});
  const [allowExceedPax, setAllowExceedPax] = useState(false);
  const [showLiveStock, setShowLiveStock] = useState(true);
  const [discountConfig, setDiscountConfig] = useState(null);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Expand booking sessions
  const bookingSessions = useMemo(() => {
    if (!reservation) return [];
    if (reservation.sessions && reservation.sessions.length > 0) {
      return [...reservation.sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    }
    if (reservation.time_blocks && reservation.time_blocks.length > 0) {
      const expanded = [];
      reservation.time_blocks.forEach((b) => {
        if (!b.start_time || !b.end_time) return;
        const [sH] = b.start_time.split(':').map(Number);
        const [eH] = b.end_time.split(':').map(Number);
        for (let h = sH; h < eH; h++) {
          const s = `${String(h).padStart(2, '0')}:00`;
          const e = `${String(h + 1).padStart(2, '0')}:00`;
          expanded.push({ start_time: s, end_time: e });
        }
      });
      return expanded;
    }
    if (reservation.start_time && reservation.end_time) {
      const [sH] = reservation.start_time.split(':').map(Number);
      const [eH] = reservation.end_time.split(':').map(Number);
      const expanded = [];
      for (let h = sH; h < eH; h++) {
        const s = `${String(h).padStart(2, '0')}:00`;
        const e = `${String(h + 1).padStart(2, '0')}:00`;
        expanded.push({ start_time: s, end_time: e });
      }
      return expanded;
    }
    return [];
  }, [reservation]);

  const H = bookingSessions.length;
  const hourStartTimes = useMemo(() => bookingSessions.map((s) => s.start_time), [bookingSessions]);
  const boundaryTime = useCallback(
    (k) => (H === 0 ? '' : k < H ? bookingSessions[k].start_time : bookingSessions[H - 1].end_time),
    [bookingSessions, H]
  );

  // Original quantities and original records snapshot
  const oldQtys = useMemo(() => {
    const map = {};
    (reservation?.equipments || []).forEach((e) => {
      map[e.equipment_id] = (map[e.equipment_id] || 0) + e.quantity;
    });
    return map;
  }, [reservation]);

  const hasOriginalBoards = useMemo(() => {
    return Object.values(oldQtys).some((q) => q > 0);
  }, [oldQtys]);

  // Lock status (within 1 hour of start time)
  const isLockedForReduction = useMemo(() => {
    if (!reservation) return false;
    const now = new Date();
    const datePart = reservation.session_date || reservation.session?.session_date;
    if (!datePart) return false;
    const cleanDate = String(datePart).split('T')[0];
    const [y, m, d] = cleanDate.split('-').map(Number);
    const [sH, sM] = (reservation.start_time || reservation.session?.start_time || '00:00').split(':').map(Number);
    const startDt = new Date(y, m - 1, d, sH, sM, 0, 0);
    return now.getTime() >= startDt.getTime() - 60 * 60 * 1000;
  }, [reservation]);

  // Load availability
  useEffect(() => {
    if (!isOpen || !reservation || bookingSessions.length === 0) return;

    setLoading(true);
    setErrorMessage('');

    const dateStr = formatYMD(reservation.session_date || reservation.session?.session_date);
    const sessionStarts = hourStartTimes.join(',');
    const url = `/equipment/availability?date=${dateStr}&sessions=${sessionStarts}&per_session=1&exclude_booking_ref=${reservation.booking_ref}`;

    api.get(url)
      .then((res) => {
        const data = res.data || {};
        const equipments = data.equipments || [];
        setConfigs(equipments);
        setAvailBySession(Object.fromEntries(equipments.map((e) => [e.id || e.equipment_id, e.available_by_session || {}])));
        setAllowExceedPax(!!data.allow_exceed_pax);
        setShowLiveStock(data.show_equipment_live_stock !== false);
        setDiscountConfig(buildDiscountConfig(data));

        // Restore initial units from reservation.equipments
        const initialUnits = [];
        (reservation.equipments || []).forEach((e) => {
          let from = 0;
          let to = H;
          if (Array.isArray(e.covered_sessions) && e.covered_sessions.length > 0) {
            const firstCovered = e.covered_sessions[0];
            const startStr = firstCovered.split('-')[0];
            const foundIdx = hourStartTimes.indexOf(startStr);
            if (foundIdx >= 0) {
              from = foundIdx;
              to = Math.min(H, from + e.covered_sessions.length);
            }
          } else if (e.rental_hours) {
            let startIdx = 0;
            if (e.start_time) {
              const foundIdx = hourStartTimes.indexOf(e.start_time);
              if (foundIdx >= 0) startIdx = foundIdx;
            }
            from = startIdx;
            to = Math.min(H, from + e.rental_hours);
          }

          for (let i = 0; i < e.quantity; i++) {
            initialUnits.push({
              uid: Math.random().toString(36).substring(2, 9),
              equipment_id: e.equipment_id,
              from,
              to,
            });
          }
        });

        setUnits(initialUnits);
      })
      .catch((err) => {
        console.error('Failed to fetch availability for sheet', err);
        setErrorMessage('無法載入智能板庫存，請稍後再試。');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isOpen, reservation, bookingSessions.length, hourStartTimes, H]);

  const configsMap = useMemo(() => {
    const map = {};
    configs.forEach((c) => {
      const eqId = c.equipment_id || c.id;
      if (eqId) map[eqId] = c;
    });
    return map;
  }, [configs]);

  const sortedConfigs = useMemo(() => {
    return [...configs]
      .filter((eq) => eq.visibility_status !== 'HIDDEN')
      .sort((a, b) => {
        const aId = a.equipment_id || a.id;
        const bId = b.equipment_id || b.id;
        if (aId === 'bring_own') return 1;
        if (bId === 'bring_own') return -1;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
  }, [configs]);

  // Current count per equipment_id
  const currentQtys = useMemo(() => {
    const map = {};
    units.forEach((u) => {
      map[u.equipment_id] = (map[u.equipment_id] || 0) + 1;
    });
    return map;
  }, [units]);

  // Pax check
  const pax = reservation?.pax || 1;
  const nonBringOwnTotal = useMemo(() => {
    return units.filter((u) => u.equipment_id !== 'bring_own').length;
  }, [units]);

  // Add / remove unit
  const handleAddUnit = (eq) => {
    const eqId = eq.equipment_id || eq.id;
    if (!allowExceedPax && eqId !== 'bring_own' && nonBringOwnTotal >= pax) {
      toast.show(`最多只能租借 ${pax} 台`, { type: 'info' });
      return;
    }

    const minH = Math.min(eq.min_contiguous_hours || 2, H);
    // If reservation has started, check current hour
    let from = 0;
    const now = new Date();
    const datePart = reservation.session_date || reservation.session?.session_date;
    if (datePart) {
      const cleanDate = String(datePart).split('T')[0];
      const [y, m, d] = cleanDate.split('-').map(Number);
      const [curH] = [now.getHours()];
      const isToday = now.getFullYear() === y && now.getMonth() === m - 1 && now.getDate() === d;
      if (isToday) {
        const curIdx = bookingSessions.findIndex((s) => {
          const [sh] = s.start_time.split(':').map(Number);
          return sh === curH;
        });
        if (curIdx >= 0) {
          from = curIdx;
        }
      }
    }

    const candidate = {
      uid: Math.random().toString(36).substring(2, 9),
      equipment_id: eqId,
      from,
      to: H,
    };

    if (candidate.to - candidate.from < minH) {
      candidate.from = Math.max(0, H - minH);
    }

    // Check inventory
    const check = canPlace(units, candidate, availBySession, hourStartTimes);
    if (!check.ok) {
      toast.show(`${shortBoardName(eq.name)} ${check.hour} 已經租完了`, { type: 'error' });
      return;
    }

    setUnits((prev) => [...prev, candidate]);
  };

  const handleRemoveUnit = (equipment_id) => {
    // If locked for reduction
    if (isLockedForReduction) {
      const origQty = oldQtys[equipment_id] || 0;
      const curQty = currentQtys[equipment_id] || 0;
      if (curQty <= origQty) {
        toast.show('開始前 1 小時內只能加租，不能退租', { type: 'info' });
        return;
      }
    }

    setUnits((prev) => {
      // Remove the LAST unit of this type
      const revIdx = [...prev].reverse().findIndex((u) => u.equipment_id === equipment_id);
      if (revIdx === -1) return prev;
      const targetIdx = prev.length - 1 - revIdx;
      return prev.filter((_, i) => i !== targetIdx);
    });
  };

  const handleUnitChange = (uid, newFrom, newTo) => {
    setUnits((prev) =>
      prev.map((u) => (u.uid === uid ? { ...u, from: newFrom, to: newTo } : u))
    );
  };

  // Grouped units and calculation
  const groups = useMemo(() => {
    return groupUnits(units, boundaryTime);
  }, [units, boundaryTime]);

  const discountTexts = useMemo(() => {
    return discountConfig ? boardDiscountTexts(discountConfig) : null;
  }, [discountConfig]);

  const { newEquipmentTotal, lines } = useMemo(() => {
    let eqTotal = 0;
    const detailLines = [];

    for (const group of groups) {
      const cfg = configsMap[group.equipment_id];
      if (!cfg) continue;
      const p = equipmentUnitPrice(cfg, group.hours, discountConfig);
      const isFullDuration = group.hours === H;
      const timeDesc = isFullDuration ? `${group.hours} 小時` : `${group.start} 到 ${group.end}`;
      detailLines.push({
        label: `${shortBoardName(cfg.name)} ×${group.qty} · ${timeDesc}`,
        amount: p.raw * group.qty,
      });

      if (p.discountSaving > 0 && discountTexts) {
        detailLines.push({
          label: discountTexts.lineLabel(group.hours, p.freeHours),
          amount: -p.discountSaving * group.qty,
          tone: 'save',
        });
      }
      if (p.capSaving > 0) {
        detailLines.push({
          label: `智能板單日上限（每台 ${formatMoney(cfg.daily_cap)}）`,
          amount: -p.capSaving * group.qty,
          tone: 'save',
        });
      }
      eqTotal += p.price * group.qty;
    }

    return { newEquipmentTotal: eqTotal, lines: detailLines };
  }, [groups, configsMap, discountConfig, discountTexts, H]);

  // Original total & equipment subtotal
  const origTotal = reservation?.total_amount || 0;
  const origEqSubtotal = useMemo(() => {
    return (reservation?.equipments || []).reduce((acc, e) => acc + (e.subtotal_price || 0), 0);
  }, [reservation]);

  const updatedTotal = Math.max(0, origTotal - origEqSubtotal + newEquipmentTotal);

  // Check if anything changed
  const isChanged = useMemo(() => {
    // Compare currentQtys with oldQtys
    const allKeys = new Set([...Object.keys(oldQtys), ...Object.keys(currentQtys)]);
    for (const k of allKeys) {
      if ((oldQtys[k] || 0) !== (currentQtys[k] || 0)) return true;
    }
    // Check if any unit from/to differs from original
    // If quantity is unchanged and counts match, check if any unit was modified
    return units.length !== (reservation?.equipments || []).reduce((a, b) => a + b.quantity, 0);
  }, [oldQtys, currentQtys, units, reservation]);

  const handleClose = useCallback(() => {
    setUnits([]);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      setUnits([]);
    }
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!reservation) return;
    setSubmitting(true);
    setErrorMessage('');

    try {
      const payloadEquipments = units.map((u) => {
        const cfg = configsMap[u.equipment_id] || {};
        return {
          equipment_id: u.equipment_id,
          name: cfg.name || '',
          quantity: 1,
          rental_hours: u.to - u.from,
          start_time: hourStartTimes[u.from],
        };
      });

      await api.patch(`/reservations/${reservation.booking_ref}/equipment`, {
        equipments: payloadEquipments,
      });

      toast.show('已更新智能拼豆板', { type: 'success' });
      handleClose();
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('Failed to update equipment', err);
      const msg = err.response?.data?.message || err.response?.data?.error || '送出失敗，請稍後再試';
      setErrorMessage(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const sheetTitle = hasOriginalBoards ? '修改智能拼豆板' : '加租智能拼豆板';
  const submitBtnText = hasOriginalBoards ? '確認修改' : '確認加租';

  // Subtitle
  const dateStrShort = reservation?.session_date ? formatDateShort(reservation.session_date) : '';
  const timeDesc = reservation?.start_time && reservation?.end_time ? `${reservation.start_time} 到 ${reservation.end_time}` : '';
  const maxBoardsDesc = allowExceedPax ? '' : `，最多可租 ${pax} 台`;
  const subTitle = `${dateStrShort} ${timeDesc} · ${pax} 位${maxBoardsDesc}`;

  if (!reservation) return null;

  return (
    <BottomSheet isOpen={isOpen} onClose={handleClose} title={sheetTitle}>
      <div className="grid gap-3 min-w-0">
        <div className="sg-small -mt-1">{subTitle}</div>

        {isLockedForReduction && (
          <div className="text-[12px] text-sg-honey-ink bg-sg-honey-soft px-3 py-1.5 rounded-[10px] font-bold">
            開始前 1 小時內只能加租，不能退租
          </div>
        )}

        {errorMessage && <ErrorBanner message={errorMessage} />}

        {loading ? (
          <div className="py-8 flex justify-center">
            <BeadLoader />
          </div>
        ) : (
          <>
            {/* Equipment list */}
            <div className="grid gap-3">
              {sortedConfigs.map((eq) => {
                const eqId = eq.equipment_id || eq.id;
                const isMaintenance = eq.visibility_status === 'MAINTENANCE';
                const maintenanceNote = eq.status_note
                  ? eq.status_note.replace(/^[\p{Extended_Pictographic}️\s]+/u, '')
                  : '維護中，暫停借用';
                const eqUnits = units.filter((u) => u.equipment_id === eqId);
                const count = eqUnits.length;
                const isBringOwn = eqId === 'bring_own';

                // Live stock calculation: min remaining in bookingSessions minus current count
                let stockRemaining = 99;
                if (!isBringOwn && availBySession[eqId]) {
                  const hoursAvail = hourStartTimes.map(
                    (t) => availBySession[eqId][t] ?? 0
                  );
                  stockRemaining = Math.max(0, Math.min(...hoursAvail) - count);
                }

                let stockText = '';
                if (!isBringOwn && showLiveStock) {
                  stockText = stockRemaining <= 0 ? ' · 已租完' : ` · 剩 ${stockRemaining} 台`;
                }

                const nameParts = eq.name.match(/^(.*?)(?:\s*[（(]([^）)]+)[）)])?$/);
                const displayName = nameParts ? nameParts[1].trim() : eq.name;
                const sizePart = nameParts && nameParts[2] ? nameParts[2].trim() : '';

                const canAdd =
                  !isMaintenance &&
                  (allowExceedPax || isBringOwn || nonBringOwnTotal < pax) &&
                  (isBringOwn || stockRemaining > 0);

                const canMinus = isLockedForReduction
                  ? count > (oldQtys[eqId] || 0)
                  : count > 0;

                return (
                  <div key={eqId} className="grid gap-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[14px]">
                          <span className="font-bold">{displayName}</span>
                          {sizePart && (
                            <span className="font-num sg-small ml-1.5">{sizePart}</span>
                          )}
                        </div>
                        <div className="sg-small">
                          {isMaintenance ? (
                            <span className="text-sg-full">{maintenanceNote}</span>
                          ) : (
                            <>
                              <span>{formatMoney(eq.hourly_rate)} / 小時</span>
                              {stockText && (
                                <span className={stockRemaining > 0 && stockRemaining <= 2 ? 'text-sg-honey-ink font-bold' : ''}>
                                  {stockText}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <Stepper
                        value={count}
                        min={0}
                        max={isBringOwn ? 99 : allowExceedPax ? 99 : pax}
                        disabledMinus={!canMinus}
                        disabledPlus={!canAdd}
                        onMinus={() => handleRemoveUnit(eqId)}
                        onPlus={() => handleAddUnit(eq)}
                        label={displayName}
                      />
                    </div>

                    {/* Render BoardTimeBox for each rented unit */}
                    {eqUnits.map((u, uIdx) => (
                      <BoardTimeBox
                        key={u.uid}
                        unit={u}
                        config={eq}
                        boardIndex={uIdx + 1}
                        totalHours={H}
                        boundaryTimes={[...bookingSessions.map((s) => s.start_time), bookingSessions[H - 1]?.end_time]}
                        bookingSessions={bookingSessions}
                        onChange={(newFrom, newTo) => handleUnitChange(u.uid, newFrom, newTo)}
                      />
                    ))}

                    <Divider />
                  </div>
                );
              })}
            </div>

            {/* Discount rule banner */}
            {discountTexts && (
              <SoftBox>
                {discountTexts.rule}
              </SoftBox>
            )}

            {/* Price breakdown box */}
            <div className="grid gap-1 rounded-[12px] bg-sg-bg px-3 py-[10px]">
              <div className="flex justify-between text-[13px] leading-[1.5]">
                <span className="text-sg-muted">原本金額</span>
                <span className="font-num text-sg-ink">{formatMoney(origTotal)}</span>
              </div>

              {lines.map((line, idx) => (
                <div
                  key={idx}
                  className={`flex justify-between text-[13px] leading-[1.5] ${
                    line.tone === 'save' ? 'text-sg-sage-ink font-bold' : ''
                  }`}
                >
                  <span>{line.label}</span>
                  <span className="font-num">
                    {line.amount < 0 ? formatMinus(-line.amount) : formatMoney(line.amount)}
                  </span>
                </div>
              ))}

              <Divider className="my-1" />

              <div className="flex justify-between text-[14px] font-bold">
                <span className="text-sg-ink">更新後金額</span>
                <span className="font-num text-sg-brown text-[16px]">
                  {formatMoney(updatedTotal)}
                </span>
              </div>
            </div>

            <Button
              variant="primary"
              size="md"
              loading={submitting}
              disabled={submitting || !isChanged}
              onClick={handleSubmit}
              className="w-full mt-1"
            >
              {submitBtnText}
            </Button>
          </>
        )}
      </div>
    </BottomSheet>
  );
}

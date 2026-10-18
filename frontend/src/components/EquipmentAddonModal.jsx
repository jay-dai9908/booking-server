import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { X, AlertCircle, ShieldAlert, Check, Plus, Minus, Cpu, Gift } from 'lucide-react';
import api from '../api/axios';
import { calculateEquipmentChargeableHours } from '../utils/equipmentPricing.js';

export default function EquipmentAddonModal({ reservation, isOpen, onClose, onSuccess, isAdmin = false }) {
  if (!isOpen || !reservation) return null;

  const [configs, setConfigs] = useState([]);
  const [selections, setSelections] = useState({});
  const [allowExceedPax, setAllowExceedPax] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [equipmentDiscount, setEquipmentDiscount] = useState({
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    tier2_enabled: false,
    tier2_buy_hours: 8,
    tier2_free_hours: 4
  });

  // Original quantities snapshot
  const oldQtys = React.useMemo(() => {
    const map = {};
    (reservation.equipments || []).forEach(e => {
      map[e.equipment_id] = e.quantity;
    });
    return map;
  }, [reservation]);

  const orderHours = reservation.session_count || (reservation.sessions ? reservation.sessions.length : (reservation.time_blocks ? reservation.time_blocks.length : 1));
  const rentalHours = Math.max(isAdmin ? 1 : 2, orderHours);

  // Determine if inside 1-hour pre-class lock or active session (Admin is immune to lock)
  const now = new Date();
  const sessionDate = new Date(reservation.session_date || reservation.session?.session_date || new Date());
  const [startH, startM] = (reservation.start_time || reservation.session?.start_time || '00:00').split(':').map(Number);
  const startDateTime = new Date(sessionDate);
  startDateTime.setHours(startH, startM, 0, 0);

  const isLockedForReduction = isAdmin ? false : (now.getTime() >= (startDateTime.getTime() - 60 * 60 * 1000));

  const fetchAvailability = async () => {
    setLoading(true);
    setErrorMessage('');
    try {
      const dateStr = format(new Date(reservation.session_date || reservation.session?.session_date || new Date()), 'yyyy-MM-dd');
      let sessionStarts = '';
      if (reservation.sessions && reservation.sessions.length > 0) {
        sessionStarts = reservation.sessions.map(s => s.start_time).join(',');
      } else if (reservation.time_blocks && reservation.time_blocks.length > 0) {
        sessionStarts = reservation.time_blocks.map(b => b.start_time).join(',');
      } else {
        sessionStarts = reservation.start_time || reservation.session?.start_time || '';
      }
      const res = await api.get(`/equipment/availability?date=${dateStr}&sessions=${sessionStarts}`);
      setConfigs(res.data.equipments || []);
      setAllowExceedPax(!!res.data.allow_exceed_pax);
      setEquipmentDiscount({
        enabled: res.data.equipment_discount_enabled !== false,
        buy_hours: res.data.equipment_discount_buy_hours ?? 3,
        free_hours: res.data.equipment_discount_free_hours ?? 1,
        stackable: res.data.equipment_discount_stackable !== false,
        tier2_enabled: !!res.data.equipment_discount2_enabled,
        tier2_buy_hours: res.data.equipment_discount2_buy_hours ?? 8,
        tier2_free_hours: res.data.equipment_discount2_free_hours ?? 4
      });

      // Initialize selections with existing equipment
      const initial = {};
      (reservation.equipments || []).forEach(e => {
        initial[e.equipment_id] = e.quantity;
      });
      setSelections(initial);
    } catch (err) {
      console.error('Failed to load equipment availability:', err);
      setErrorMessage('無法取得智能板庫存資訊');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAvailability();
  }, [reservation]);

  const visibleConfigs = isAdmin ? configs : configs.filter(c => c.visibility_status !== 'HIDDEN');
  const totalBoards = visibleConfigs.reduce((sum, c) => sum + (selections[c.id] || 0), 0);
  const oldTotalBoards = Object.values(oldQtys).reduce((a, b) => a + b, 0);

  const chargeableHours = calculateEquipmentChargeableHours(
    rentalHours,
    equipmentDiscount
  );

  // Calculate pricing difference
  let newEquipmentFee = 0;
  let oldEquipmentFee = 0;
  visibleConfigs.forEach(c => {
    const singlePrice = (c.daily_cap && c.daily_cap > 0)
      ? Math.min(c.hourly_rate * chargeableHours, c.daily_cap)
      : (c.hourly_rate * chargeableHours);
    const qty = selections[c.id] || 0;
    const oldQty = oldQtys[c.id] || 0;
    newEquipmentFee += singlePrice * qty;
    oldEquipmentFee += singlePrice * oldQty;
  });

  const diffFee = newEquipmentFee - oldEquipmentFee;
  const currentOrderTotal = reservation.total_amount || 0;
  const updatedOrderTotal = Math.max(0, currentOrderTotal + diffFee);

  const handleUpdate = async () => {
    setSubmitting(true);
    setErrorMessage('');

    const equipmentsPayload = Object.entries(selections)
      .filter(([_, qty]) => qty > 0)
      .map(([equipment_id, quantity]) => ({
        equipment_id,
        quantity,
        rental_hours: rentalHours
      }));

    try {
      const res = await api.patch(`/reservations/${reservation.booking_ref}/equipment`, {
        equipments: equipmentsPayload
      });
      if (onSuccess) onSuccess(res.data);
      onClose();
    } catch (err) {
      console.error(err);
      if (err.response?.status === 409) {
        setErrorMessage('⚠️ 抱歉！您選擇的「智能拼豆板」在該時段剛被其他預約佔用，系統已為您更新最新可用數量，請重新調整數量。');
        fetchAvailability();
      } else {
        setErrorMessage(err.response?.data?.error || '更新設備失敗，請稍後再試');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/50 backdrop-blur-sm" onClick={onClose} />
      <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-lg overflow-hidden relative z-10 flex flex-col max-h-[92vh] animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#EBE5DF] flex items-center justify-between bg-[#FDFCFA]">
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-xl bg-[#F4EFE6] text-[#8B5B43]">
              <Cpu className="w-5 h-5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-[#2C241E]">
                  {oldTotalBoards > 0 ? '✏️ 追加/修改智能拼豆板' : '➕ 補預約智能拼豆板'}
                </h2>
                {isAdmin && (
                  <span className="text-[11px] bg-indigo-100 text-indigo-700 font-bold px-2 py-0.5 rounded-md">
                    🛡️ 管理員調度
                  </span>
                )}
              </div>
              <p className="text-xs text-[#8C8279]">
                預約時段：{reservation.start_time || reservation.session?.start_time} - {reservation.end_time || reservation.session?.end_time}（{rentalHours} 小時）
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-[#8C8279] hover:text-[#2C241E] rounded-full hover:bg-[#F9F7F3] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {errorMessage && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-red-800 leading-relaxed">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-500 mt-0.5" />
              <div>{errorMessage}</div>
            </div>
          )}

          {/* Admin vs Customer helper message */}
          {isAdmin ? (
            <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex items-start gap-2.5 text-xs text-indigo-900 leading-relaxed font-medium">
              <span className="text-base shrink-0 mt-0.5">🛡️</span>
              <div>
                <strong>後台管理權限模式：</strong>可自由追加、調減或清空退租智能板，不受線上顧客 1 小時退租封鎖限制。確認送出後將同步自動更新訂單結帳金額。
              </div>
            </div>
          ) : isLockedForReduction ? (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-2.5 text-xs text-amber-900 leading-relaxed font-medium">
              <ShieldAlert className="w-4 h-4 shrink-0 text-amber-600 mt-0.5" />
              <div>
                🔒 距離體驗開始已不足 1 小時（或體驗進行中），線上僅開放同行者「追加租用」；如需取消已保留之智能板請洽現場門市人員。
              </div>
            </div>
          ) : null}

          {/* Quota Banner */}
          <div className="bg-[#EDE6DD] text-[#4A3F35] px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-between">
            <span>👥 預約人數：{reservation.pax} 人</span>
            <span>已配置：{totalBoards} 台</span>
            <span className="text-[#8B5B43]">
              尚可追加：{(allowExceedPax || isAdmin) ? '無限制' : `${Math.max(0, reservation.pax - totalBoards)} 台`}
            </span>
          </div>

          {/* Equipment Discount Banner */}
          {equipmentDiscount.enabled && (
            <div className="bg-[#FAF4EB] border border-[#E8DEC8] px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-[#8B5B43]">
              <div className="flex items-center gap-2">
                <Gift className="w-4 h-4 text-[#8B5B43] shrink-0" />
                <span>
                  智能板「買 {equipmentDiscount.buy_hours} 送 {equipmentDiscount.free_hours}
                  {equipmentDiscount.tier2_enabled ? ` ｜ 買 ${equipmentDiscount.tier2_buy_hours} 送 ${equipmentDiscount.tier2_free_hours}（金額自動擇優）` : ''}」生效中
                </span>
              </div>
              {chargeableHours < rentalHours && (
                <span className="bg-[#8B5B43] text-white text-[11px] px-2.5 py-1 rounded-full shrink-0">
                  每台折抵 {rentalHours - chargeableHours}hr（{totalBoards} 台共折抵 {totalBoards * (rentalHours - chargeableHours)} 小時）
                </span>
              )}
            </div>
          )}

          {loading ? (
            <div className="text-center py-10 text-[#8C8279]">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43] mx-auto mb-2"></div>
              載入最新庫存中...
            </div>
          ) : visibleConfigs.length === 0 ? (
            <div className="text-center py-8 text-[#8C8279] text-sm">
              目前暫無開放租借的智能拼豆板設備。
            </div>
          ) : (
            <div className="space-y-3">
              {visibleConfigs.map(c => {
                const qty = selections[c.id] || 0;
                const oldQty = oldQtys[c.id] || 0;
                const isMaintenance = c.visibility_status === 'MAINTENANCE';
                const isHidden = c.visibility_status === 'HIDDEN';
                const isBringOwn = c.id === 'bring_own';
                
                // Allowed reduction check: Admins can reduce/cancel down to 0 anytime!
                const minAllowed = (!isAdmin && isLockedForReduction) ? oldQty : 0;
                const canReduce = qty > minAllowed;

                // Max allowed addition check
                const maxAvailableForThis = isBringOwn 
                  ? 999 
                  : (c.available_qty + oldQty); // Available + what we currently held
                const remainingPaxQuota = (allowExceedPax || isAdmin) ? 999 : Math.max(0, reservation.pax - totalBoards);
                const canAdd = (isAdmin || !isMaintenance) && (qty < maxAvailableForThis) && (allowExceedPax || isAdmin || remainingPaxQuota > 0);

                return (
                  <div
                    key={c.id}
                    className={`p-3.5 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
                      isMaintenance && !isAdmin
                        ? 'bg-[#F2EFE9] border-[#DED7CE] opacity-75'
                        : qty > 0
                          ? 'bg-white border-[#8B5B43] shadow-sm'
                          : 'bg-white/80 border-[#E5DFD7]'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-[15px] text-[#3E332B]">
                          {isBringOwn ? '✨' : '🧩'} {c.name}
                        </span>
                        <span className="text-xs bg-[#F4EFE6] text-[#8B5B43] font-bold px-2 py-0.5 rounded">
                          NT$ {c.hourly_rate} /時
                        </span>
                        {c.daily_cap && c.daily_cap > 0 && (
                          <span className="text-xs text-[#8C8279]">
                            (上限 NT${c.daily_cap})
                          </span>
                        )}
                        {isHidden && (
                          <span className="text-xs bg-gray-200 text-gray-700 font-bold px-1.5 py-0.5 rounded">
                            ⚪ 前台已隱藏
                          </span>
                        )}
                        {isMaintenance && (
                          <span className="text-xs bg-amber-100 text-amber-800 font-bold px-1.5 py-0.5 rounded">
                            🔧 維護中
                          </span>
                        )}
                      </div>
                      {isMaintenance ? (
                        <div className="text-xs text-amber-700 font-bold mt-1">
                          🔧 {c.status_note || '設備維護中，暫停借用'} {isAdmin && '(管理員可調度指派)'}
                        </div>
                      ) : !isBringOwn ? (
                        <div className="text-xs text-[#8C8279] mt-0.5">
                          即時剩餘庫存：<strong className={c.available_qty === 0 ? 'text-red-500' : 'text-[#3E332B]'}>{c.available_qty}</strong> / {c.total_stock}
                        </div>
                      ) : (
                        <div className="text-xs text-[#8C8279] mt-0.5">
                          自備智能拼豆板充電與場地設備費
                        </div>
                      )}
                    </div>

                    {/* Stepper */}
                    <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
                      <div className="flex items-center bg-[#F9F7F3] border border-[#D5CFC9] rounded-lg p-1">
                        <button
                          type="button"
                          disabled={!canReduce}
                          onClick={() => setSelections(prev => ({ ...prev, [c.id]: Math.max(minAllowed, qty - 1) }))}
                          className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                          title={isLockedForReduction && qty <= oldQty ? '已過退租時限，僅可追加' : ''}
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="w-10 text-center font-bold text-sm text-[#3E332B]">
                          {qty} 台
                        </span>
                        <button
                          type="button"
                          disabled={!canAdd}
                          onClick={() => setSelections(prev => ({ ...prev, [c.id]: qty + 1 }))}
                          className="w-7 h-7 flex items-center justify-center rounded bg-white text-[#8B5B43] font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#F0EBE1] transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pricing Preview Banner */}
          {!loading && (
            <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl p-4 space-y-2 text-xs sm:text-sm text-[#6B5A4E]">
              <div className="flex justify-between items-center font-medium">
                <span>原訂單應付：</span>
                <span className="font-bold text-[#3E332B]">NT$ {currentOrderTotal}</span>
              </div>
              <div className="flex justify-between items-center font-medium">
                <span>本次追加/異動差額：</span>
                <span className={`font-bold ${diffFee >= 0 ? 'text-[#8B5B43]' : 'text-emerald-700'}`}>
                  {diffFee >= 0 ? `+ NT$ ${diffFee}` : `- NT$ ${Math.abs(diffFee)}`}
                </span>
              </div>
              <div className="pt-2 border-t border-[#E8DEC8] flex justify-between items-center text-sm sm:text-base font-bold text-[#3E332B]">
                <span>更新後總額：</span>
                <span className="text-[#8B5B43] text-lg">NT$ {updatedOrderTotal}</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-[#FDFCFA] border-t border-[#EBE5DF] flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-5 py-2.5 rounded-full text-sm font-medium text-[#8C8279] hover:bg-[#F4EFE6] transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleUpdate}
            disabled={submitting || loading}
            className="px-6 py-2.5 rounded-full text-sm font-bold bg-[#8B5B43] hover:bg-[#724a35] text-white shadow-sm disabled:opacity-50 transition-colors flex items-center gap-1.5"
          >
            {submitting ? '更新中...' : <><Check className="w-4 h-4" /> 確認送出</>}
          </button>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  format,
  addDays,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  isSameMonth,
  isSameDay,
  addMonths,
  subMonths,
  isBefore,
  startOfDay,
  getDay
} from 'date-fns';
import {
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  RotateCcw,
  Sliders,
  AlertTriangle
} from 'lucide-react';
import api from '../../api/axios';
import HourRangeScrollPicker from '../../components/HourRangeScrollPicker';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import CheckoutWorkbench from '../../components/admin/checkout/CheckoutWorkbench';
import SelfServiceInfoCard from '../../components/customer/SelfServiceInfoCard';
import { ironText as buildIronText } from '../../../../shared/selfService.js';
import { useAdminPermissions } from '../../hooks/admin/useAdminPermissions';

const DEFAULT_CLOSURE_ANNOUNCEMENT =
  '拾光製所 {日期} 臨時公休，您預約的 {時段}（{人數} 位）已取消。{店家說明}造成不便非常抱歉，如需改約請直接回覆這個 LINE。';

function renderClosurePreview(template, { dateStr, timeRange, pax, closedNote }) {
  const raw = template && String(template).trim()
    ? String(template).trim()
    : DEFAULT_CLOSURE_ANNOUNCEMENT;
  const noteText = closedNote && String(closedNote).trim()
    ? `${String(closedNote).trim()}。`
    : '';
  return raw
    .replaceAll('{日期}', dateStr || '')
    .replaceAll('{時段}', timeRange || '')
    .replaceAll('{人數}', String(pax ?? ''))
    .replaceAll('{店家說明}', noteText);
}

export default function SessionsPage() {
  const { can } = useAdminPermissions();
  const canSettings = can('settings');
  const [toastMsg, setToastMsg] = useState(null);
  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 3000);
  };
  const [deleteSessionTargetId, setDeleteSessionTargetId] = useState(null);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);

  const [currentMonth, setCurrentMonth] = useState(startOfMonth(new Date()));
  const [selectedDates, setSelectedDates] = useState([format(new Date(), 'yyyy-MM-dd')]);
  const [listDate, setListDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [monthSessionsMap, setMonthSessionsMap] = useState({});
  const [monthDayInfoMap, setMonthDayInfoMap] = useState({});

  const [startTime, setStartTime] = useState('10:00');
  const [endTime, setEndTime] = useState('21:00');
  const [businessHours, setBusinessHours] = useState({
    weekday: { start: '10:00', end: '21:00' },
    saturday: { start: '09:00', end: '21:00' },
    sunday: { start: '09:00', end: '21:00' }
  });
  const [maxCapacity, setMaxCapacity] = useState(16);
  const [seatCount, setSeatCount] = useState(16);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [allowUnlimited, setAllowUnlimited] = useState(true);

  // Pricing States (read-only display in SessionsPage; unique editor in SettingsPage)
  const [globalWeekdayHourly, setGlobalWeekdayHourly] = useState('');
  const [globalWeekdayUnlimited, setGlobalWeekdayUnlimited] = useState('');
  const [globalWeekendHourly, setGlobalWeekendHourly] = useState('');
  const [globalWeekendUnlimited, setGlobalWeekendUnlimited] = useState('');

  const [dailyHourly, setDailyHourly] = useState('');
  const [dailyUnlimited, setDailyUnlimited] = useState('');

  const [batchMode, setBatchMode] = useState('selected'); // 'selected' | 'range'
  const [batchStartDate, setBatchStartDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchEndDate, setBatchEndDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [batchHourly, setBatchHourly] = useState('');
  const [batchUnlimited, setBatchUnlimited] = useState('');
  const [batchClearHourly, setBatchClearHourly] = useState(false);
  const [batchClearUnlimited, setBatchClearUnlimited] = useState(false);
  const [batchAllowUnlimited, setBatchAllowUnlimited] = useState('unchanged'); // 'unchanged' | 'true' | 'false'
  const [batchConfirmState, setBatchConfirmState] = useState(null);
  const [batchDayType, setBatchDayType] = useState('unchanged'); // 'unchanged' | 'auto' | 'weekday' | 'holiday' | 'self' | 'closed'
  const [batchPriceType, setBatchPriceType] = useState('');
  const [batchClosedNote, setBatchClosedNote] = useState('');
  const [batchSelfAllowEquipment, setBatchSelfAllowEquipment] = useState(false);
  const [batchIronMode, setBatchIronMode] = useState('today');
  const [batchIronDate, setBatchIronDate] = useState('');
  const [isBatching, setIsBatching] = useState(false);

  // Daily Day-Type & Self-Service States (for listDate)
  const [selectedDayType, setSelectedDayType] = useState('auto'); // 'auto' | 'weekday' | 'holiday' | 'self' | 'closed'
  const [selectedPriceType, setSelectedPriceType] = useState(''); // '' | 'weekday' | 'holiday'
  const [closedNote, setClosedNote] = useState('');
  const [affectConfirmState, setAffectConfirmState] = useState(null);
  const [isSelfService, setIsSelfService] = useState(false);
  const [selfAllowHourly, setSelfAllowHourly] = useState(false);
  const [selfAllowEquipment, setSelfAllowEquipment] = useState(false);
  const [ironMode, setIronMode] = useState('today');
  const [ironDate, setIronDate] = useState('');
  const [savingDailySelf, setSavingDailySelf] = useState(false);
  const [dailySelfError, setDailySelfError] = useState('');

  // Closure Impact & Batch Cancel States
  const [closureImpact, setClosureImpact] = useState(null);
  const [closureLoading, setClosureLoading] = useState(false);
  const [selectedClosureRefs, setSelectedClosureRefs] = useState([]);
  const [showClosureCancelModal, setShowClosureCancelModal] = useState(false);
  const [closureNotifyLine, setClosureNotifyLine] = useState(true);
  const [closureAnnouncement, setClosureAnnouncement] = useState(DEFAULT_CLOSURE_ANNOUNCEMENT);
  const [closureCancelling, setClosureCancelling] = useState(false);
  const [closureResult, setClosureResult] = useState(null);
  const [closureCheckoutRef, setClosureCheckoutRef] = useState(null);

  // Shared Kiosk/Self-Service Settings (read-only display in SessionsPage; unique editor in KioskPage)
  const [kioskSettings, setKioskSettings] = useState({
    prepay_deadline_hour: 12,
    early_minutes: 30,
    after_close_minutes: 60,
    max_unpaid_self_bookings: 2
  });
  const [anySelfEquipmentEnabled, setAnySelfEquipmentEnabled] = useState(false);

  useEffect(() => {
    fetchGlobalSetting();
    fetchKioskSettings();
    fetchEquipmentSelfStatus();
  }, []);

  useEffect(() => {
    fetchSessions(listDate);
    fetchDailySetting(listDate);
    fetchSeatCount(listDate);
  }, [listDate]);

  useEffect(() => {
    fetchMonthSessions(currentMonth);
  }, [currentMonth]);

  const fetchSeatCount = async (date = listDate) => {
    try {
      const url = date ? `/seat-layouts/active?date=${date}` : '/seat-layouts/active';
      const layoutRes = await api.get(url);
      const activeCount = layoutRes.data?.capacity ?? (layoutRes.data?.seats || []).filter(s => s.is_active)?.length ?? 16;
      setSeatCount(activeCount);
    } catch (lErr) {
      setSeatCount(16);
    }
  };

  const fetchGlobalSetting = async () => {
    try {
      const res = await api.get('/daily-settings/global');
      setGlobalWeekdayHourly(res.data.weekday_hourly_price ?? '');
      setGlobalWeekdayUnlimited(res.data.weekday_unlimited_price ?? '');
      setGlobalWeekendHourly(res.data.weekend_hourly_price ?? '');
      setGlobalWeekendUnlimited(res.data.weekend_unlimited_price ?? '');
      if (res.data?.business_hours_json) {
        setBusinessHours({
          weekday: {
            start: res.data.business_hours_json.weekday?.start || '10:00',
            end: res.data.business_hours_json.weekday?.end || '21:00'
          },
          saturday: {
            start: res.data.business_hours_json.saturday?.start || '09:00',
            end: res.data.business_hours_json.saturday?.end || '21:00'
          },
          sunday: {
            start: res.data.business_hours_json.sunday?.start || '09:00',
            end: res.data.business_hours_json.sunday?.end || '21:00'
          }
        });
        if (res.data.business_hours_json.weekday?.start) {
          setStartTime(res.data.business_hours_json.weekday.start);
        }
        if (res.data.business_hours_json.weekday?.end) {
          setEndTime(res.data.business_hours_json.weekday.end);
        }
      }
      setMaxCapacity(res.data?.default_session_capacity ?? 16);
      fetchSeatCount(listDate);
    } catch (err) {
      console.error('Error fetching global setting:', err);
    }
  };

  const fetchClosureImpact = async (date = listDate) => {
    setClosureLoading(true);
    try {
      const res = await api.get(`/daily-settings/${date}/closure-impact`);
      setClosureImpact(res.data);
      const directList = res.data?.groups?.direct_cancel || [];
      setSelectedClosureRefs(directList.map((item) => item.booking_ref));
    } catch (err) {
      console.error('Error fetching closure impact:', err);
      setClosureImpact(null);
    } finally {
      setClosureLoading(false);
    }
  };

  const fetchDailySetting = async (date) => {
    try {
      const res = await api.get(`/daily-settings?date=${date}`);
      setAllowUnlimited(res.data.allow_unlimited);
      setDailyHourly(res.data.hourly_price || '');
      setDailyUnlimited(res.data.unlimited_price || '');
      setIsSelfService(Boolean(res.data.is_self_service));
      const rawDt = res.data.raw_day_type;
      setSelectedDayType(rawDt || (res.data.is_self_service ? 'self' : 'auto'));
      setSelectedPriceType(res.data.raw_price_type || '');
      setClosedNote(res.data.closed_note || '');
      setSelfAllowHourly(Boolean(res.data.self_allow_hourly));
      setSelfAllowEquipment(Boolean(res.data.self_allow_equipment));
      setIronMode(res.data.iron_mode || 'today');
      setIronDate(res.data.iron_date ? String(res.data.iron_date).slice(0, 10) : '');
      setDailySelfError('');
      setClosureResult(null);
      if (res.data.day_type === 'closed') {
        fetchClosureImpact(date);
      } else {
        setClosureImpact(null);
      }
    } catch (err) {
      console.error('Error fetching daily setting:', err);
    }
  };

  const fetchKioskSettings = async () => {
    try {
      const res = await api.get('/kiosk/settings');
      if (res.data) {
        setKioskSettings({
          prepay_deadline_hour: res.data.prepay_deadline_hour ?? 12,
          early_minutes: res.data.early_minutes ?? 30,
          after_close_minutes: res.data.after_close_minutes ?? 60,
          max_unpaid_self_bookings: res.data.max_unpaid_self_bookings ?? 2
        });
      }
    } catch (err) {
      console.error('Error fetching kiosk settings:', err);
    }
  };

  const fetchEquipmentSelfStatus = async () => {
    try {
      const res = await api.get('/equipment/admin');
      const list = res.data?.configs || (Array.isArray(res.data) ? res.data : []);
      setAnySelfEquipmentEnabled(list.some(c => Boolean(c.self_enabled) && c.visibility_status !== 'HIDDEN'));
    } catch (err) {
      console.error('Error fetching equipment status:', err);
    }
  };

  const saveDailyDayTypeAndSelf = async (confirmAffected = false) => {
    setSavingDailySelf(true);
    setDailySelfError('');
    try {
      await api.put('/daily-settings/day-type', {
        date: listDate,
        day_type: selectedDayType,
        price_type: (selectedDayType === 'self' || selectedDayType === 'closed') ? (selectedPriceType || null) : null,
        closed_note: selectedDayType === 'closed' ? closedNote : null,
        confirm_affected: confirmAffected
      });

      if (selectedDayType === 'self') {
        await api.put('/daily-settings', {
          date: listDate,
          allow_unlimited: true,
          hourly_price: dailyHourly || null,
          unlimited_price: dailyUnlimited || null,
          is_self_service: true,
          self_allow_hourly: selfAllowHourly,
          self_allow_equipment: selfAllowEquipment,
          iron_mode: ironMode,
          iron_date: ironMode === 'date' ? ironDate : null
        });
        setAllowUnlimited(true);
        setIsSelfService(true);
      } else if (selectedDayType !== 'closed') {
        setIsSelfService(false);
      }

      showToast(selectedDayType === 'self' ? `已儲存 ${listDate} 的半自助日設定` : `已儲存 ${listDate} 的日期類型`);
      fetchDailySetting(listDate);
      fetchMonthSessions(currentMonth);
      fetchSessions(listDate);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409 && data?.code === 'AFFECTS_UNPAID' && !confirmAffected) {
        setAffectConfirmState({
          mode: 'single',
          message: data.error || `這天有 ${data.count} 筆舊預約還沒付款，價格會變動，確定要套用嗎？`
        });
        return;
      }
      const msg = data?.error || '儲存日期設定失敗';
      setDailySelfError(msg);
      showToast(msg);
      fetchDailySetting(listDate);
    } finally {
      setSavingDailySelf(false);
    }
  };

  const handleBatchClosureCancel = async () => {
    if (selectedClosureRefs.length === 0) return;
    setClosureCancelling(true);
    try {
      const res = await api.post(`/daily-settings/${listDate}/closure/cancel`, {
        booking_refs: selectedClosureRefs,
        notify_line: closureNotifyLine,
        message: closureAnnouncement
      });
      setClosureResult(res.data);
      setShowClosureCancelModal(false);
      showToast(`已處理 ${res.data?.cancelled?.length || 0} 筆取消`);
      await fetchClosureImpact(listDate);
      fetchSessions(listDate);
    } catch (err) {
      showToast(err.response?.data?.error || '批次取消失敗');
    } finally {
      setClosureCancelling(false);
    }
  };

  const handleDownloadClosureCsv = async () => {
    try {
      const res = await api.get(`/daily-settings/${listDate}/closure-impact.csv`, {
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `closure-impact-${listDate}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      showToast(err.response?.data?.error || '下載清單失敗');
    }
  };

  const handleSingleClosureNotice = async (bookingRef) => {
    try {
      await api.post(`/daily-settings/${listDate}/closure/notify`, {
        booking_ref: bookingRef,
        message: closureAnnouncement
      });
      showToast('已補發公休公告');
    } catch (err) {
      showToast(err.response?.data?.error || '補發公告失敗');
    }
  };

  const handleSaveDailySelfService = async (e) => {
    if (e) e.preventDefault();
    await saveDailyDayTypeAndSelf(false);
  };

  const fetchMonthSessions = async (monthDate = currentMonth) => {
    try {
      const mStart = format(startOfWeek(startOfMonth(monthDate)), 'yyyy-MM-dd');
      const mEnd = format(endOfWeek(endOfMonth(monthDate)), 'yyyy-MM-dd');
      const [sessRes, rangeRes] = await Promise.all([
        api.get(`/sessions?start_date=${mStart}&end_date=${mEnd}`),
        api.get(`/daily-settings/range?start=${mStart}&end=${mEnd}`).catch(() => ({ data: [] }))
      ]);
      const sessList = Array.isArray(sessRes.data) ? sessRes.data : (sessRes.data?.sessions || []);
      const map = {};
      sessList.forEach(s => {
        const dStr = format(new Date(s.session_date), 'yyyy-MM-dd');
        map[dStr] = (map[dStr] || 0) + 1;
      });
      setMonthSessionsMap(map);

      const infoMap = {};
      (Array.isArray(rangeRes.data) ? rangeRes.data : []).forEach((item) => {
        if (item?.date) infoMap[item.date] = item;
      });
      setMonthDayInfoMap(infoMap);
    } catch (err) {
      console.error('Error fetching month sessions:', err);
    }
  };

  const handleToggleUnlimited = async () => {
    const newValue = !allowUnlimited;
    setAllowUnlimited(newValue);
    try {
      await api.put('/daily-settings', { date: listDate, allow_unlimited: newValue });
    } catch (err) {
      console.error('Error updating daily setting:', err);
      setAllowUnlimited(!newValue);
      showToast('更新設定失敗');
    }
  };

  const handleUpdateDailyPrice = async (e) => {
    e.preventDefault();
    try {
      await api.put('/daily-settings', { 
        date: listDate,
        hourly_price: dailyHourly || null,
        unlimited_price: dailyUnlimited || null
      });
      showToast('單日覆蓋價格更新成功！');
    } catch (err) {
      showToast('更新失敗');
    }
  };

  const handleBatchUpdatePrices = async (e) => {
    e.preventDefault();
    const payload = {};

    let hourlySummary = '不變';
    if (batchClearHourly) {
      payload.clear_hourly_price = true;
      hourlySummary = '清除特價（改回全店價格）';
    } else if (String(batchHourly).trim() !== '') {
      const parsed = /^-?\d+$/.test(String(batchHourly).trim()) ? parseInt(String(batchHourly).trim(), 10) : batchHourly;
      payload.hourly_price = parsed;
      hourlySummary = `NT$ ${parsed}`;
    }

    let unlimitedSummary = '不變';
    if (batchClearUnlimited) {
      payload.clear_unlimited_price = true;
      unlimitedSummary = '清除特價（改回全店價格）';
    } else if (String(batchUnlimited).trim() !== '') {
      const parsed = /^-?\d+$/.test(String(batchUnlimited).trim()) ? parseInt(String(batchUnlimited).trim(), 10) : batchUnlimited;
      payload.unlimited_price = parsed;
      unlimitedSummary = `NT$ ${parsed}`;
    }

    let allowUnlimitedSummary = '不變';
    if (batchAllowUnlimited === 'true') {
      payload.allow_unlimited = true;
      allowUnlimitedSummary = '開放';
    } else if (batchAllowUnlimited === 'false') {
      payload.allow_unlimited = false;
      allowUnlimitedSummary = '不開放';
    }

    const DAY_TYPE_LABELS = {
      unchanged: '不變',
      auto: '自動（依星期與時段）',
      weekday: '平日',
      holiday: '假日',
      self: '半自助日',
      closed: '公休'
    };

    if (batchDayType !== 'unchanged') {
      payload.day_type = batchDayType;
      if (batchDayType === 'self' || batchDayType === 'closed') {
        payload.price_type = batchPriceType || null;
      }
      if (batchDayType === 'closed') {
        payload.closed_note = batchClosedNote || null;
      }
      if (batchDayType === 'self') {
        payload.self_allow_equipment = batchSelfAllowEquipment;
        payload.iron_mode = batchIronMode;
        payload.iron_date = batchIronMode === 'date' ? batchIronDate : null;
      }
    }

    let daysCount = 0;
    if (batchMode === 'selected') {
      if (selectedDates.length === 0) {
        showToast('請先在上方月曆勾選日期');
        return;
      }
      payload.dates = selectedDates;
      daysCount = selectedDates.length;
    } else {
      if (!batchStartDate || !batchEndDate || batchEndDate < batchStartDate) {
        showToast('請選擇有效的起訖日期');
        return;
      }
      payload.start_date = batchStartDate;
      payload.end_date = batchEndDate;
      const startMs = new Date(`${batchStartDate}T00:00:00Z`).getTime();
      const endMs = new Date(`${batchEndDate}T00:00:00Z`).getTime();
      daysCount = Math.max(1, Math.round((endMs - startMs) / 86400000) + 1);
    }

    setBatchConfirmState({
      payload,
      daysCount,
      hourlySummary,
      unlimitedSummary,
      allowUnlimitedSummary,
      selfServiceSummary: DAY_TYPE_LABELS[batchDayType] || '不變'
    });
  };

  const executeBatchSubmit = async (payload, confirmAffected = false) => {
    setIsBatching(true);
    try {
      const res = await api.post('/daily-settings/batch', {
        ...payload,
        ...(confirmAffected ? { confirm_affected: true } : {})
      });
      showToast(`批次修改成功！${res.data?.message || ''}`);
      fetchDailySetting(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      const data = err.response?.data;
      if (err.response?.status === 409 && data?.code === 'AFFECTS_UNPAID' && !confirmAffected) {
        setAffectConfirmState({
          mode: 'batch',
          payload,
          message: data.error || `這些日期中有 ${data.count} 筆舊預約還沒付款，價格會變動，確定套用嗎？`
        });
        return;
      }
      showToast(data?.error || '批次修改失敗');
    } finally {
      setIsBatching(false);
    }
  };

  const handleConfirmBatchSubmit = async () => {
    if (!batchConfirmState) return;
    const { payload } = batchConfirmState;
    setBatchConfirmState(null);
    await executeBatchSubmit(payload, false);
  };

  const fetchSessions = async (date = listDate) => {
    setIsLoading(true);
    try {
      const res = await api.get(`/sessions?date=${date}&include_closed=1`);
      setSessions(res.data);
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateSession = async (e) => {
    e.preventDefault();
    if (selectedDates.length === 0) {
      showToast('請先在月曆上勾選至少一個欲新增時段的日期');
      return;
    }
    setIsSubmitting(true);
    try {
      const sortedDates = [...selectedDates].sort();
      await api.post('/sessions', {
        session_dates: sortedDates,
        start_time: startTime,
        end_time: endTime,
        max_capacity: parseInt(maxCapacity, 10)
      });
      showToast(`時段新增成功！已為 ${sortedDates.length} 天新增 ${startTime} ~ ${endTime} 時段`);
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '新增失敗');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSession = (id) => {
    setDeleteSessionTargetId(id);
  };

  const handleConfirmDeleteSession = async () => {
    if (!deleteSessionTargetId) return;
    try {
      const res = await api.delete(`/sessions/${deleteSessionTargetId}`);
      showToast(res.data?.action === 'closed' ? '此時段有已取消的預約紀錄，已改為關閉' : '時段已刪除');
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '刪除失敗');
    } finally {
      setDeleteSessionTargetId(null);
    }
  };

  const handleDeleteAllForDate = () => {
    if (sessions.length === 0) return;
    setShowDeleteAllConfirm(true);
  };

  const handleConfirmDeleteAllForDate = async () => {
    try {
      const res = await api.delete(`/sessions/date/${listDate}`);
      const deletedCount = res.data?.deletedCount ?? 0;
      const closedCount = res.data?.closedCount ?? 0;
      const keptCount = res.data?.keptCount ?? 0;
      showToast(`刪除 ${deletedCount} 個、關閉 ${closedCount} 個（有已取消的預約紀錄）${keptCount > 0 ? `；另有 ${keptCount} 個確認中時段保留` : ''}`);
      fetchSessions(listDate);
      fetchMonthSessions(currentMonth);
    } catch (err) {
      showToast(err.response?.data?.error || '刪除失敗');
    } finally {
      setShowDeleteAllConfirm(false);
    }
  };

  // Calendar dates computation
  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(monthStart);
  const calendarStartDate = startOfWeek(monthStart);
  const calendarEndDate = endOfWeek(monthEnd);

  const calendarDays = [];
  let dayCursor = calendarStartDate;
  while (dayCursor <= calendarEndDate) {
    calendarDays.push(dayCursor);
    dayCursor = addDays(dayCursor, 1);
  }

  // Quick batch selection helpers for currentMonth
  const getAvailableMonthDays = () => {
    const today = startOfDay(new Date());
    const days = [];
    let d = monthStart;
    while (d <= monthEnd) {
      if (!isBefore(startOfDay(d), today)) {
        days.push(d);
      }
      d = addDays(d, 1);
    }
    return days;
  };

  const handleSelectWeekdays = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day >= 2 && day <= 5;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectMonToFri = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day >= 1 && day <= 5;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectUnscheduledDays = () => {
    const valid = getAvailableMonthDays()
      .map(d => format(d, 'yyyy-MM-dd'))
      .filter(dateStr => !monthSessionsMap[dateStr]);
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectWeekends = () => {
    const valid = getAvailableMonthDays()
      .filter(d => {
        const day = getDay(d);
        return day === 0 || day === 6;
      })
      .map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleSelectAllMonth = () => {
    const valid = getAvailableMonthDays().map(d => format(d, 'yyyy-MM-dd'));
    setSelectedDates(valid);
    if (valid.length > 0) setListDate(valid[0]);
  };

  const handleClearSelected = () => {
    setSelectedDates([]);
  };

  const handleDateCellClick = (date) => {
    const dateStr = format(date, 'yyyy-MM-dd');
    const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
    
    // Always view this date's sessions on the right side
    setListDate(dateStr);

    // If not in the past, toggle multi-select
    if (!isPast) {
      setSelectedDates(prev => {
        if (prev.includes(dateStr)) {
          return prev.filter(d => d !== dateStr);
        } else {
          return [...prev, dateStr].sort();
        }
      });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-4 right-4 z-50 bg-sg-ink text-white px-4 py-2.5 rounded-2xl shadow-lg text-[13px] font-bold animate-fade-in">
          {toastMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
        {/* Left Column: Interactive Multi-Select Calendar & Session Creation Form */}
        <div className="xl:col-span-1">
          <div className="bg-white p-5 sm:p-6 rounded-2xl shadow-sm border border-gray-200 sticky top-8 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Plus className="w-5 h-5 text-[#8B5B43]" />
                新增時段 (多日批次)
              </h2>
              <span className="text-xs bg-[#FAF4EB] text-[#8B5B43] border border-[#E8DEC8] px-2.5 py-1 rounded-full font-bold">
                已選 {selectedDates.length} 天
              </span>
            </div>

            <form onSubmit={handleCreateSession} className="space-y-5">
              {/* Interactive Calendar Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                    <CalendarIcon className="w-4 h-4 text-[#8B5B43]" />
                    點擊月曆選取日期 (可複選)
                  </label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
                      className="p-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                      title="上個月"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-xs font-bold text-gray-800 tracking-wide px-1">
                      {format(currentMonth, 'yyyy年 MM月')}
                    </span>
                    <button
                      type="button"
                      onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
                      className="p-1 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                      title="下個月"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Quick Selection Capsules for Staff */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSelectWeekdays}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    平日 (二~五)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectMonToFri}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    週一~五
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectWeekends}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    週末 (六~日)
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectUnscheduledDays}
                    className="px-2 py-0.5 text-[12px] font-bold bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-600 hover:text-white rounded-full transition-all"
                    title="一鍵選取本月尚未排班的未來日期"
                  >
                    選取未排班日
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectAllMonth}
                    className="px-2 py-0.5 text-[12px] font-medium bg-[#FAF7F2] text-[#6E5D4F] border border-[#E8DEC8] hover:bg-[#8B5B43] hover:text-white rounded-full transition-all"
                  >
                    全選本月
                  </button>
                  <button
                    type="button"
                    onClick={handleClearSelected}
                    className="px-2 py-0.5 text-[12px] font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-red-50 hover:text-red-600 hover:border-red-200 rounded-full transition-all flex items-center gap-0.5"
                  >
                    <RotateCcw className="w-3 h-3" /> 清空
                  </button>
                </div>

                {/* Calendar Grid Container */}
                <div className="bg-[#FAF7F2]/60 border border-[#E8DEC8] rounded-2xl p-2.5 select-none">
                  <div className="grid grid-cols-7 gap-1 text-center mb-1">
                    {['日', '一', '二', '三', '四', '五', '六'].map((dayName, idx) => (
                      <div 
                        key={dayName} 
                        className={`text-[12px] font-bold py-0.5 ${idx === 0 || idx === 6 ? 'text-[#8B5B43]' : 'text-gray-400'}`}
                      >
                        {dayName}
                      </div>
                    ))}
                  </div>

                  <div className="grid grid-cols-7 gap-1">
                    {calendarDays.map((date, i) => {
                      const dateStr = format(date, 'yyyy-MM-dd');
                      const isSelected = selectedDates.includes(dateStr);
                      const isCurrentMonth = isSameMonth(date, currentMonth);
                      const isPast = isBefore(startOfDay(date), startOfDay(new Date()));
                      const isViewingList = dateStr === listDate;
                      const sessionCount = monthSessionsMap[dateStr] || 0;
                      const dayInfo = monthDayInfoMap[dateStr];
                      const typeChar =
                        dayInfo?.day_type === 'closed' ? '休'
                        : dayInfo?.day_type === 'self' ? '半'
                        : dayInfo?.day_type === 'holiday' ? '假'
                        : dayInfo?.day_type === 'weekday' ? '平'
                        : '';
                      const isManualType = dayInfo?.day_type_source === 'manual';
                      const typeBadgeClass = isSelected
                        ? 'text-white/90'
                        : dayInfo?.day_type === 'closed'
                        ? 'text-rose-600'
                        : dayInfo?.day_type === 'self'
                        ? 'text-amber-700'
                        : dayInfo?.day_type === 'holiday'
                        ? 'text-orange-600'
                        : 'text-gray-500';

                      return (
                        <div key={i} className="flex justify-center items-center">
                          <button
                            type="button"
                            data-testid={`admin-calendar-day-${dateStr}`}
                            onClick={() => handleDateCellClick(date)}
                            className={`relative w-9 h-10 sm:w-10 sm:h-11 rounded-xl text-xs font-semibold transition-all duration-150 flex flex-col items-center justify-center ${
                              !isCurrentMonth
                                ? 'text-gray-300 opacity-40 hover:opacity-80'
                                : isPast
                                ? 'text-gray-400 bg-gray-50/60 hover:bg-gray-100'
                                : isSelected
                                ? 'bg-sg-brown text-white shadow-sm font-bold scale-[1.03]'
                                : 'text-gray-700 hover:bg-amber-50 hover:text-amber-900'
                            } ${
                              isViewingList ? 'ring-2 ring-amber-500 ring-offset-1' : ''
                            }`}
                            title={`${dateStr}${typeChar ? ` [${typeChar}${isManualType ? '・手動' : ''}]` : ''}${sessionCount > 0 ? ` (已建立 ${sessionCount} 個時段)` : ''}${isViewingList ? ' [右側時段列表檢視中]' : ''}`}
                          >
                            {isManualType && (
                              <span
                                data-testid={`manual-dot-${dateStr}`}
                                className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500"
                              />
                            )}
                            <span className="leading-none">{format(date, 'd')}</span>
                            <div className="flex items-center gap-0.5 mt-0.5">
                              {typeChar && (
                                <span className={`text-[10px] leading-none font-bold ${typeBadgeClass}`}>
                                  {typeChar}
                                </span>
                              )}
                              {sessionCount > 0 && (
                                <span
                                  className={`w-1.5 h-1.5 rounded-full ${
                                    isSelected ? 'bg-emerald-300' : 'bg-emerald-500'
                                  }`}
                                />
                              )}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Calendar Legend Note */}
                <div className="flex items-center justify-between text-[12px] text-gray-500 px-1">
                  <div className="flex items-center gap-3">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                      已有時段
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded bg-sg-brown inline-block" />
                      已勾選
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2.5 h-2.5 rounded border-2 border-amber-500 inline-block" />
                      右側檢視中
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                      手動類型
                    </span>
                  </div>
                </div>
              </div>

              {/* Quick Time-Range Presets + Hour Range Drum/Scroll Picker */}
              <div className="space-y-2">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                  <span className="text-xs font-semibold text-gray-500">快速時段預設：</span>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      data-testid="preset-weekday-btn"
                      onClick={() => { setStartTime(businessHours.weekday.start); setEndTime(businessHours.weekday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.weekday.start && endTime === businessHours.weekday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      平日 {businessHours.weekday.start} 到 {businessHours.weekday.end}
                    </button>
                    <button
                      type="button"
                      data-testid="preset-saturday-btn"
                      onClick={() => { setStartTime(businessHours.saturday.start); setEndTime(businessHours.saturday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.saturday.start && endTime === businessHours.saturday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      週六 {businessHours.saturday.start} 到 {businessHours.saturday.end}
                    </button>
                    <button
                      type="button"
                      data-testid="preset-sunday-btn"
                      onClick={() => { setStartTime(businessHours.sunday.start); setEndTime(businessHours.sunday.end); }}
                      className={`px-2.5 py-1 text-[12px] font-bold rounded-xl border transition-all ${
                        startTime === businessHours.sunday.start && endTime === businessHours.sunday.end
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:border-sg-brown'
                      }`}
                    >
                      週日 {businessHours.sunday.start} 到 {businessHours.sunday.end}
                    </button>
                  </div>
                </div>
                <HourRangeScrollPicker
                  startTime={startTime}
                  setStartTime={setStartTime}
                  endTime={endTime}
                  setEndTime={setEndTime}
                />
              </div>

              {/* Max Capacity Input */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-semibold text-gray-700">
                    可預約人數
                  </label>
                  <span className="text-xs text-gray-400">
                    目前座位數：{seatCount} 個
                  </span>
                </div>
                <input
                  type="number"
                  min="1"
                  data-testid="session-capacity-input"
                  value={maxCapacity}
                  onChange={(e) => setMaxCapacity(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-bold text-gray-800 focus:outline-none focus:ring-2 focus:ring-sg-brown"
                  placeholder="請輸入可預約人數"
                />
                {parseInt(maxCapacity, 10) > seatCount && (
                  <p className="mt-1.5 text-xs text-amber-600 font-medium flex items-center gap-1" data-testid="capacity-exceed-warning">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                    <span>可預約人數比座位多 {parseInt(maxCapacity, 10) - seatCount} 位，可能會有人沒位子坐</span>
                  </p>
                )}
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isSubmitting || selectedDates.length === 0}
                className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 mt-2 flex justify-center items-center gap-2"
              >
                {isSubmitting ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    確認新增 ({selectedDates.length} 天)
                  </>
                )}
              </button>

              {selectedDates.length === 0 && (
                <p className="text-center text-xs text-red-500 font-medium">
                  請在月曆上勾選至少一個欲新增時段的日期
                </p>
              )}
            </form>
          </div>
        </div>

        {/* Right Column: Sessions List for listDate */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-gray-200 gap-4">
            <div className="flex items-center gap-3">
              <h2 className="font-bold text-gray-900 text-base">
                時段列表
              </h2>
              <span className="text-xs bg-[#FAF4EB] text-[#8B5B43] border border-[#E8DEC8] px-2.5 py-1 rounded-full font-bold">
                {listDate}
              </span>
            </div>
            
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center cursor-pointer">
                <div className="relative">
                  <input type="checkbox" className="sr-only" checked={allowUnlimited} onChange={handleToggleUnlimited} disabled={isLoading} />
                  <div className={`block w-10 h-6 rounded-full transition-colors ${allowUnlimited ? 'bg-sg-brown' : 'bg-gray-300'}`}></div>
                  <div className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${allowUnlimited ? 'transform translate-x-4' : ''}`}></div>
                </div>
                <div className="ml-2.5 text-xs font-semibold text-gray-700">開放不限時</div>
              </label>

              <div className="h-5 w-px bg-gray-200 hidden sm:block"></div>

              <input
                type="date"
                value={listDate}
                onChange={(e) => setListDate(e.target.value)}
                className="px-3 py-1.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none text-xs font-medium text-gray-700 bg-gray-50"
              />

              <button
                onClick={handleDeleteAllForDate}
                disabled={sessions.length === 0}
                className={`p-2 rounded-xl border transition-colors flex items-center justify-center ${
                  sessions.length === 0 
                    ? 'bg-gray-50 border-gray-100 text-gray-300 cursor-not-allowed' 
                    : 'bg-white border-red-200 text-red-500 hover:bg-red-50 hover:border-red-300 shadow-2xs'
                }`}
                title="刪除當日所有未被預約時段"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
            {isLoading ? (
              <div className="p-10 flex justify-center">
                <div className="w-8 h-8 border-4 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                {listDate} 尚無任何時段，可透過左側月曆勾選並快速新增
              </div>
            ) : (
              <>
                {/* Desktop Table (>= 768px) */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left whitespace-nowrap">
                    <thead>
                      <tr className="bg-gray-50 text-gray-500 text-sm border-b border-gray-200">
                        <th className="px-6 py-4 font-medium">時段</th>
                        <th className="px-6 py-4 font-medium">可預約</th>
                        <th className="px-6 py-4 font-medium">剩餘</th>
                        <th className="px-6 py-4 font-medium">狀態</th>
                        <th className="px-6 py-4 font-medium text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sessions.map(s => {
                        const isClosed = Boolean(s.closed_at);
                        const isFull = s.remaining_capacity === 0;
                        return (
                          <tr key={s.id} className={`transition-colors group ${isClosed ? 'bg-gray-50/70 text-gray-400' : 'hover:bg-gray-50'}`}>
                            <td className="px-6 py-4 font-semibold text-gray-800">{s.start_time} - {s.end_time}</td>
                            <td className="px-6 py-4 text-gray-500">{s.max_capacity} 人</td>
                            <td className="px-6 py-4">
                              <span className={`font-bold ${isClosed || isFull ? 'text-gray-300' : 'text-gray-900'}`}>
                                {s.remaining_capacity}
                              </span>
                            </td>
                            <td className="px-6 py-4">
                              {isClosed ? (
                                <span className="inline-flex items-center gap-1.5 text-gray-500 text-xs font-bold bg-gray-100 px-2 py-0.5 rounded-lg">
                                  已關閉
                                </span>
                              ) : isFull ? (
                                <span className="inline-flex items-center gap-1.5 text-gray-400 text-sm">
                                  <XCircle className="w-4 h-4"/>已額滿
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-gray-900 text-sm font-medium">
                                  <CheckCircle2 className="w-4 h-4 text-emerald-600"/>開放中
                                </span>
                              )}
                            </td>
                            <td className="px-6 py-4 text-right">
                              <button 
                                disabled={isClosed}
                                onClick={() => handleDeleteSession(s.id)}
                                className="text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:pointer-events-none p-2 rounded-lg transition-colors"
                                title={isClosed ? '已關閉' : '刪除時段'}
                              >
                                <Trash2 className="w-5 h-5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List (< 768px) */}
                <div className="md:hidden divide-y divide-gray-100">
                  {sessions.map(s => {
                    const isClosed = Boolean(s.closed_at);
                    const isFull = s.remaining_capacity === 0;
                    return (
                      <div key={s.id} className={`p-4 flex items-center justify-between gap-3 ${isClosed ? 'bg-gray-50/70 opacity-75' : ''}`}>
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-900 text-sm">
                              {s.start_time} - {s.end_time}
                            </span>
                            {isClosed ? (
                              <span className="inline-flex items-center gap-1 text-gray-500 text-xs font-bold bg-gray-100 px-2 py-0.5 rounded-lg">
                                已關閉
                              </span>
                            ) : isFull ? (
                              <span className="inline-flex items-center gap-1 text-gray-400 text-xs">
                                <XCircle className="w-3.5 h-3.5" /> 已額滿
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-emerald-600 text-xs font-bold">
                                <CheckCircle2 className="w-3.5 h-3.5" /> 開放中
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500">
                            剩餘 <strong className={`font-bold ${isFull ? 'text-gray-400' : 'text-gray-900'}`}>{s.remaining_capacity}</strong> / 可預約 {s.max_capacity} 人
                          </div>
                        </div>

                        <button
                          type="button"
                          disabled={isClosed}
                          onClick={() => handleDeleteSession(s.id)}
                          className="text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:pointer-events-none p-2.5 rounded-xl transition-colors shrink-0"
                          title={isClosed ? '已關閉' : '刪除時段'}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Bottom Grid: Price Settings & Overrides */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 mt-8">
        {/* Global Prices (Read-only; unique editor is SettingsPage) */}
        <div
          data-testid="sessions-global-prices-card"
          className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 flex flex-col justify-between space-y-5"
        >
          <div>
            <div className="flex items-start justify-between gap-2 mb-1">
              <h2 className="text-lg font-bold text-gray-900">
                預設全店價格
              </h2>
              <Link
                to="/admin/settings"
                data-testid="link-to-global-settings"
                className="text-xs font-bold text-[#8B5B43] hover:underline shrink-0"
              >
                到系統設定修改 →
              </Link>
            </div>
            <p className="text-xs text-gray-500">
              唯讀顯示；為避免互相覆蓋，全店預設價格統一於「系統設定」修改
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">平日 / 時</div>
              <div className="text-base font-bold text-gray-900" data-testid="readonly-weekday-hourly">
                NT$ {globalWeekdayHourly !== '' ? globalWeekdayHourly : '—'}
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">平日 / 上限</div>
              <div className="text-base font-bold text-gray-900" data-testid="readonly-weekday-unlimited">
                NT$ {globalWeekdayUnlimited !== '' ? globalWeekdayUnlimited : '—'}
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">假日 / 時</div>
              <div className="text-base font-bold text-gray-900" data-testid="readonly-weekend-hourly">
                NT$ {globalWeekendHourly !== '' ? globalWeekendHourly : '—'}
              </div>
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-3">
              <div className="text-xs font-semibold text-gray-500 mb-1">假日 / 上限</div>
              <div className="text-base font-bold text-gray-900" data-testid="readonly-weekend-unlimited">
                NT$ {globalWeekendUnlimited !== '' ? globalWeekendUnlimited : '—'}
              </div>
            </div>
          </div>

          <Link
            to="/admin/settings"
            className="block w-full text-center bg-[#FAF7F2] hover:bg-[#F2ECE4] text-[#8B5B43] border border-[#E8DEC8] font-bold py-3 rounded-xl transition-all text-sm"
          >
            到系統設定修改
          </Link>
        </div>

        {/* Daily Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <h2 className="text-lg font-bold text-gray-900 mb-6 flex items-center gap-2">
            {format(new Date(listDate), 'yyyy-MM-dd')} 單日覆蓋設定
          </h2>
          <form onSubmit={handleUpdateDailyPrice} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">每小時價格 (留空使用預設)</label>
              <input type="number" value={dailyHourly} onChange={e => setDailyHourly(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">不限時價格 (留空使用預設)</label>
              <input type="number" value={dailyUnlimited} onChange={e => setDailyUnlimited(e.target.value)} placeholder="留空使用預設" className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"/>
            </div>
            <button type="submit" className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm">儲存單日覆蓋</button>
          </form>
        </div>

        {/* Batch Prices Overrides */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-600" />
              批次修改價格覆蓋
            </h2>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center gap-1.5 bg-gray-100 p-1 rounded-xl mb-4 text-xs font-semibold">
            <button
              type="button"
              onClick={() => setBatchMode('selected')}
              className={`flex-1 py-1.5 px-2 rounded-lg transition-all ${
                batchMode === 'selected'
                  ? 'bg-white text-gray-900 shadow-2xs font-bold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              套用月曆已選 ({selectedDates.length} 天)
            </button>
            <button
              type="button"
              onClick={() => setBatchMode('range')}
              className={`flex-1 py-1.5 px-2 rounded-lg transition-all ${
                batchMode === 'range'
                  ? 'bg-white text-gray-900 shadow-2xs font-bold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              自訂起訖日期
            </button>
          </div>

          <form onSubmit={handleBatchUpdatePrices} className="space-y-4">
            {batchMode === 'selected' ? (
              <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-3 text-xs text-amber-900">
                <span className="font-bold">將套用至上方月曆勾選的日期：</span>
                {selectedDates.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {selectedDates.map(d => (
                      <span key={d} className="bg-white border border-amber-200/90 px-1.5 py-0.5 rounded text-[12px] font-mono font-medium shadow-2xs">
                        {d}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1 text-red-500 font-medium">尚未在月曆上勾選任何日期，請先至上方月曆勾選日期</p>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">開始日期</label>
                  <input
                    type="date"
                    required
                    value={batchStartDate}
                    onChange={e => {
                      setBatchStartDate(e.target.value);
                      if (e.target.value > batchEndDate) setBatchEndDate(e.target.value);
                    }}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-700 mb-1.5">結束日期</label>
                  <input
                    type="date"
                    required
                    min={batchStartDate}
                    value={batchEndDate}
                    onChange={e => setBatchEndDate(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-sm font-semibold text-gray-700">每小時價格</label>
                <input
                  type="number"
                  data-testid="batch-hourly-input"
                  disabled={batchClearHourly}
                  value={batchHourly}
                  onChange={e => setBatchHourly(e.target.value)}
                  placeholder="留空＝不變"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm disabled:bg-gray-100 disabled:text-gray-400"
                />
                {!batchClearHourly && String(batchHourly).trim() === '' && (
                  <p className="text-[11px] text-gray-500">留空＝不變</p>
                )}
                <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none pt-0.5">
                  <input
                    type="checkbox"
                    data-testid="batch-clear-hourly"
                    checked={batchClearHourly}
                    onChange={(e) => {
                      setBatchClearHourly(e.target.checked);
                      if (e.target.checked) setBatchHourly('');
                    }}
                    className="w-3.5 h-3.5 accent-[#8B5B43]"
                  />
                  <span>清除特價（改回全店價格）</span>
                </label>
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-semibold text-gray-700">不限時價格</label>
                <input
                  type="number"
                  data-testid="batch-unlimited-input"
                  disabled={batchClearUnlimited}
                  value={batchUnlimited}
                  onChange={e => setBatchUnlimited(e.target.value)}
                  placeholder="留空＝不變"
                  className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:outline-none transition-all text-sm disabled:bg-gray-100 disabled:text-gray-400"
                />
                {!batchClearUnlimited && String(batchUnlimited).trim() === '' && (
                  <p className="text-[11px] text-gray-500">留空＝不變</p>
                )}
                <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none pt-0.5">
                  <input
                    type="checkbox"
                    data-testid="batch-clear-unlimited"
                    checked={batchClearUnlimited}
                    onChange={(e) => {
                      setBatchClearUnlimited(e.target.checked);
                      if (e.target.checked) setBatchUnlimited('');
                    }}
                    className="w-3.5 h-3.5 accent-[#8B5B43]"
                  />
                  <span>清除特價（改回全店價格）</span>
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="text-sm font-semibold text-gray-700">不限時</div>
              <div className="flex flex-wrap gap-2" data-testid="batch-allow-unlimited-group">
                {[
                  { id: 'unchanged', label: '不變' },
                  { id: 'true', label: '開放' },
                  { id: 'false', label: '不開放' }
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`batch-allow-unlimited-${opt.id}`}
                    onClick={() => setBatchAllowUnlimited(opt.id)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-bold transition ${
                      batchAllowUnlimited === opt.id
                        ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                        : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 p-3 space-y-2.5">
              <div className="space-y-1.5">
                <label className="block text-sm font-bold text-gray-800">日期類型</label>
                <select
                  data-testid="batch-day-type-select"
                  value={batchDayType}
                  onChange={(e) => setBatchDayType(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-800"
                >
                  <option value="unchanged">不變</option>
                  <option value="auto">自動（依星期與時段）</option>
                  <option value="weekday">平日</option>
                  <option value="holiday">假日</option>
                  <option value="self">半自助日</option>
                  <option value="closed">公休</option>
                </select>
              </div>
              {(batchDayType === 'self' || batchDayType === 'closed') && (
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-gray-700">價格比照</label>
                  <select
                    data-testid="batch-price-type-select"
                    value={batchPriceType}
                    onChange={(e) => setBatchPriceType(e.target.value)}
                    className="w-full px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs"
                  >
                    <option value="">依星期</option>
                    <option value="weekday">平日</option>
                    <option value="holiday">假日</option>
                  </select>
                </div>
              )}
              {batchDayType === 'closed' && (
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-gray-700">給顧客看的說明（最多 60 字）</label>
                  <input
                    type="text"
                    maxLength={60}
                    data-testid="batch-closed-note-input"
                    value={batchClosedNote}
                    onChange={(e) => setBatchClosedNote(e.target.value)}
                    placeholder="例如：設備維修、員工旅遊"
                    className="w-full px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs"
                  />
                </div>
              )}
              {batchDayType === 'self' && (
                <div className="space-y-2.5 pt-1 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-semibold text-gray-700">
                    <input
                      type="checkbox"
                      checked={batchSelfAllowEquipment}
                      onChange={(e) => setBatchSelfAllowEquipment(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span>開放加租智能板</span>
                  </label>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-gray-700">熨燙時間</div>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { id: 'today', label: '當日下午' },
                        { id: 'next', label: '隔日' },
                        { id: 'date', label: '指定日期' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setBatchIronMode(opt.id)}
                          className={`px-2.5 py-1 rounded-lg border font-bold ${
                            batchIronMode === opt.id
                              ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                              : 'bg-white text-gray-700 border-gray-200'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    {batchIronMode === 'date' && (
                      <input
                        type="date"
                        value={batchIronDate}
                        onChange={(e) => setBatchIronDate(e.target.value)}
                        className="mt-1 px-3 py-1.5 bg-white border border-gray-200 rounded-lg text-xs"
                      />
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="submit"
              data-testid="batch-submit-btn"
              disabled={isBatching || (batchMode === 'selected' && selectedDates.length === 0)}
              className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
            >
              {isBatching ? (
                <div className="w-5 h-5 mx-auto border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                batchMode === 'selected' ? `批次儲存覆蓋 (${selectedDates.length} 天)` : '批次儲存覆蓋'
              )}
            </button>
          </form>
        </div>
      </div>

      {/* Self-Service Settings Grid (Single Day + Global Kiosk Rules) */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 mt-8">
        {/* Daily Day-Type & Self-Service Card */}
        <form onSubmit={handleSaveDailySelfService} className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4">
          <div className="space-y-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">
                {listDate} 日期類型與營業設定
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                已預約的客人照預約時的價格，新預約才用新的類型
              </p>
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-semibold text-gray-700">日期類型</label>
              <div className="flex flex-wrap gap-1.5" data-testid="day-type-selector">
                {[
                  { id: 'auto', label: '自動（依星期與時段）' },
                  { id: 'weekday', label: '平日' },
                  { id: 'holiday', label: '假日' },
                  { id: 'self', label: '半自助' },
                  { id: 'closed', label: '公休' }
                ].map((opt) => {
                  const active = selectedDayType === opt.id;
                  if (opt.id === 'self') {
                    return (
                      <label
                        key={opt.id}
                        data-testid="day-type-opt-self"
                        className={`cursor-pointer px-3 py-1.5 rounded-xl border text-xs font-bold transition select-none ${
                          active
                            ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                            : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          data-testid="daily-self-service-toggle"
                          className="sr-only"
                          checked={selectedDayType === 'self'}
                          onChange={(e) => {
                            const next = e.target.checked ? 'self' : 'auto';
                            setSelectedDayType(next);
                            setIsSelfService(next === 'self');
                            setDailySelfError('');
                          }}
                        />
                        <span>{opt.label}</span>
                      </label>
                    );
                  }
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`day-type-opt-${opt.id}`}
                      onClick={() => {
                        setSelectedDayType(opt.id);
                        setIsSelfService(opt.id === 'self');
                        setDailySelfError('');
                      }}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition ${
                        active
                          ? (opt.id === 'closed'
                              ? 'bg-rose-600 text-white border-rose-600'
                              : 'bg-[#8B5B43] text-white border-[#8B5B43]')
                          : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {(selectedDayType === 'self' || selectedDayType === 'closed') && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-700">價格比照</label>
                <select
                  data-testid="price-type-select"
                  value={selectedPriceType}
                  onChange={(e) => setSelectedPriceType(e.target.value)}
                  className="w-full sm:w-64 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                >
                  <option value="">依星期</option>
                  <option value="weekday">平日</option>
                  <option value="holiday">假日</option>
                </select>
              </div>
            )}

            {selectedDayType === 'closed' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-700">給顧客看的說明（最多 60 字）</label>
                <input
                  type="text"
                  maxLength={60}
                  data-testid="closed-note-input"
                  value={closedNote}
                  onChange={(e) => setClosedNote(e.target.value)}
                  placeholder="例如：設備維修、員工旅遊"
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                />
              </div>
            )}
          </div>

          {dailySelfError && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-medium rounded-xl px-3 py-2">
              {dailySelfError}
            </div>
          )}

          {selectedDayType === 'self' ? (
            <div className="space-y-4 pt-2 border-t border-gray-100">
              {/* Plans */}
              <div className="space-y-2 text-sm">
                <div className="font-semibold text-gray-700">開放方案</div>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-gray-800 font-medium">
                    <input type="checkbox" checked readOnly className="w-4 h-4 accent-[#8B5B43]" />
                    <span>不限時（沿用上方價格）</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-gray-800 font-medium">
                    <input
                      type="checkbox"
                      data-testid="daily-self-allow-hourly-toggle"
                      checked={selfAllowHourly}
                      onChange={(e) => setSelfAllowHourly(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span>一般計時</span>
                    <span className="text-xs text-gray-400">前期先不開放</span>
                  </label>
                </div>
              </div>

              {/* Equipment toggle */}
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-gray-700">開放加租智能板</div>
                    <div className="text-xs text-gray-400">價格和數量在「智能板庫存管理」設定。</div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      data-testid="daily-self-allow-equipment-toggle"
                      checked={selfAllowEquipment}
                      onChange={(e) => setSelfAllowEquipment(e.target.checked)}
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                    <span className="text-xs font-bold text-gray-700">{selfAllowEquipment ? '已開放' : '未開放'}</span>
                  </label>
                </div>
                {selfAllowEquipment && !anySelfEquipmentEnabled && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                    <span>目前沒有任何一款智能板在半自助日開放租借，顧客端仍看不到板子。</span>
                    <a href="/admin/equipment" className="font-bold text-[#8B5B43] underline shrink-0">
                      前往智能板庫存管理 →
                    </a>
                  </div>
                )}
              </div>

              {/* Iron mode */}
              <div className="space-y-2 text-sm">
                <div className="font-semibold text-gray-700">熨燙時間</div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { id: 'today', label: '當日下午' },
                    { id: 'next', label: '隔日' },
                    { id: 'date', label: '指定日期' }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`iron-mode-${opt.id}`}
                      onClick={() => setIronMode(opt.id)}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition ${
                        ironMode === opt.id
                          ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                          : 'bg-gray-50 text-gray-700 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {ironMode === 'date' && (
                  <input
                    type="date"
                    min={listDate}
                    value={ironDate}
                    onChange={(e) => setIronDate(e.target.value)}
                    className="mt-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                  />
                )}
              </div>

              {/* Preview InfoCard */}
              <div className="space-y-1.5">
                <div className="text-xs font-semibold text-gray-500">預覽：顧客在預約頁會看到的說明卡</div>
                <div className="max-w-sm">
                  <SelfServiceInfoCard
                    ironText={buildIronText({ iron_mode: ironMode, iron_date: ironDate, date: listDate })}
                    earlyMinutes={kioskSettings.early_minutes}
                    deadlineHour={kioskSettings.prepay_deadline_hour}
                    showPaymentLine
                  />
                </div>
              </div>
            </div>
          ) : selectedDayType === 'closed' ? (
            <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">
              臨時公休：這天會停止接受新預約，且報到機不開門。已存在的預約不受影響，請於下方處理。
            </div>
          ) : (
            <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-xl p-3">
              一般營業日：照設定的平假日價格和不限時開關運作，顧客現場報到、離場結帳。
            </div>
          )}

          <button
            type="submit"
            disabled={savingDailySelf}
            data-testid="save-daily-self-service-btn"
            className="w-full bg-sg-brown hover:bg-sg-brown-hover text-white font-medium py-3 rounded-xl transition-all shadow-sm disabled:opacity-50"
          >
            {savingDailySelf ? '儲存中...' : `儲存 ${listDate} 日期與營業設定`}
          </button>

          {/* Closure Impact Handling Panel */}
          {closureImpact?.is_closed && (
            <div
              data-testid="closure-impact-panel"
              className="pt-4 mt-4 border-t border-rose-200 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-base font-bold text-gray-900">
                    當天預約處理（{listDate}）
                  </h3>
                  <p className="text-xs text-gray-500">
                    {closureLoading ? '載入受影響預約中...' : `共 ${closureImpact.counts?.total || 0} 筆確認中預約`}
                  </p>
                </div>
                {(closureImpact.counts?.need_refund > 0 ||
                  closureImpact.counts?.pass_deducted > 0 ||
                  closureImpact.counts?.pending_reconcile > 0) && (
                  <button
                    type="button"
                    data-testid="download-closure-csv-btn"
                    onClick={handleDownloadClosureCsv}
                    className="px-3 py-1.5 rounded-xl border border-gray-300 bg-white text-xs font-bold text-gray-700 hover:bg-gray-50"
                  >
                    下載需處理清單
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-2">
                  <div className="text-emerald-700 font-semibold">可以直接取消</div>
                  <div className="text-lg font-extrabold text-emerald-900" data-testid="impact-count-direct">
                    {closureImpact.counts?.direct_cancel ?? 0}
                  </div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-2">
                  <div className="text-amber-700 font-semibold">需退款</div>
                  <div className="text-lg font-extrabold text-amber-900" data-testid="impact-count-refund">
                    {closureImpact.counts?.need_refund ?? 0}
                  </div>
                </div>
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-2">
                  <div className="text-purple-700 font-semibold">卡券已扣</div>
                  <div className="text-lg font-extrabold text-purple-900" data-testid="impact-count-pass">
                    {closureImpact.counts?.pass_deducted ?? 0}
                  </div>
                </div>
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-2">
                  <div className="text-sky-700 font-semibold">半自助待對帳</div>
                  <div className="text-lg font-extrabold text-sky-900" data-testid="impact-count-pending">
                    {closureImpact.counts?.pending_reconcile ?? 0}
                  </div>
                </div>
              </div>

              {closureResult && (
                <div
                  data-testid="closure-cancel-result"
                  className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs space-y-1 text-emerald-900"
                >
                  <div className="font-bold">
                    處理結果：已取消 {closureResult.cancelled?.length || 0} 筆、已推播 LINE {(closureResult.cancelled || []).filter((c) => c.line_status === 'sent').length} 筆、沒有 LINE {(closureResult.cancelled || []).filter((c) => c.line_status === 'no_line').length} 筆、略過 {closureResult.skipped?.length || 0} 筆、失敗 {closureResult.failed?.length || 0} 筆
                  </div>
                  {(closureResult.cancelled || []).map((c) => (
                    <div key={c.booking_ref}>
                      • {c.user_name}（{c.booking_ref.slice(0, 8)}）：已取消 ·{' '}
                      {c.line_status === 'sent'
                        ? '已推播 LINE'
                        : c.line_status === 'no_line'
                        ? '沒有 LINE'
                        : c.line_status === 'failed'
                        ? `LINE 推播失敗（${c.line_error || ''}）`
                        : '未推播'}
                    </div>
                  ))}
                  {(closureResult.skipped || []).map((s) => (
                    <div key={s.booking_ref} className="text-amber-800">
                      • {s.booking_ref.slice(0, 8)}：已略過（{s.reason}）
                    </div>
                  ))}
                </div>
              )}

              {/* Group 1: Direct Cancel */}
              {(closureImpact.groups?.direct_cancel || []).length > 0 && (
                <div className="space-y-2 border border-gray-200 rounded-xl p-3 bg-gray-50/70">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold text-gray-800">
                      可以直接取消（沒有有效收款）
                    </span>
                    <button
                      type="button"
                      data-testid="open-closure-cancel-btn"
                      disabled={selectedClosureRefs.length === 0}
                      onClick={() => setShowClosureCancelModal(true)}
                      className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold disabled:opacity-50"
                    >
                      批次取消並推送 LINE 公告 ({selectedClosureRefs.length})
                    </button>
                  </div>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {closureImpact.groups.direct_cancel.map((item) => {
                      const checked = selectedClosureRefs.includes(item.booking_ref);
                      return (
                        <label
                          key={item.booking_ref}
                          className="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-lg px-2.5 py-2 text-xs cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              data-testid={`closure-select-${item.booking_ref}`}
                              checked={checked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedClosureRefs((prev) => [...prev, item.booking_ref]);
                                } else {
                                  setSelectedClosureRefs((prev) => prev.filter((r) => r !== item.booking_ref));
                                }
                              }}
                              className="w-4 h-4 accent-[#8B5B43]"
                            />
                            <span className="font-bold text-gray-900 truncate">{item.user_name}</span>
                            <span className="text-gray-500">{item.time_range}（{item.pax} 位）</span>
                          </div>
                          <span className={`px-1.5 py-0.5 rounded font-semibold shrink-0 ${item.has_line ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
                            {item.has_line ? '可推 LINE' : '無 LINE'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Group 2: Need Refund */}
              {(closureImpact.groups?.need_refund || []).length > 0 && (
                <div className="space-y-2 border border-amber-200 rounded-xl p-3 bg-amber-50/40">
                  <div className="text-xs font-bold text-amber-900">需退款（請先至結帳工作台退款後再取消）</div>
                  <div className="space-y-1.5">
                    {closureImpact.groups.need_refund.map((item) => (
                      <div key={item.booking_ref} className="flex flex-wrap items-center justify-between gap-2 bg-white border border-amber-200 rounded-lg px-2.5 py-2 text-xs">
                        <div>
                          <span className="font-bold text-gray-900">{item.user_name}</span>{' '}
                          <span className="text-gray-500">{item.time_range}（{item.pax} 位）</span>{' '}
                          <span className="font-bold text-amber-800">
                            已收 NT${item.paid_amount}（{(item.payments || []).map((p) => p.method_label).join('、')}）
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setClosureCheckoutRef(item.booking_ref)}
                            className="px-2.5 py-1 rounded-lg bg-amber-600 text-white font-bold hover:bg-amber-700"
                          >
                            結帳／退款
                          </button>
                          {item.has_line && (
                            <button
                              type="button"
                              onClick={() => handleSingleClosureNotice(item.booking_ref)}
                              className="px-2 py-1 rounded-lg border border-gray-300 text-gray-700 font-semibold hover:bg-gray-50"
                            >
                              補發公告
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Group 3: Pass Deducted */}
              {(closureImpact.groups?.pass_deducted || []).length > 0 && (
                <div className="space-y-2 border border-purple-200 rounded-xl p-3 bg-purple-50/40">
                  <div className="text-xs font-bold text-purple-900">卡券已扣（需先作廢收款退回次數才能取消）</div>
                  <div className="space-y-1.5">
                    {closureImpact.groups.pass_deducted.map((item) => (
                      <div key={item.booking_ref} className="flex flex-wrap items-center justify-between gap-2 bg-white border border-purple-200 rounded-lg px-2.5 py-2 text-xs">
                        <div>
                          <span className="font-bold text-gray-900">{item.user_name}</span>{' '}
                          <span className="text-gray-500">{item.time_range}（{item.pax} 位）</span>{' '}
                          <span className="text-purple-800 font-semibold">
                            {(item.passes || []).map((p) => `末4碼 ${p.last4} 扣 ${p.units} 次`).join('、')}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setClosureCheckoutRef(item.booking_ref)}
                          className="px-2.5 py-1 rounded-lg bg-purple-600 text-white font-bold hover:bg-purple-700"
                        >
                          結帳／作廢
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Group 4: Pending Reconcile */}
              {(closureImpact.groups?.pending_reconcile || []).length > 0 && (
                <div className="space-y-2 border border-sky-200 rounded-xl p-3 bg-sky-50/40">
                  <div className="text-xs font-bold text-sky-900">半自助待對帳（需先到對帳區確認實收金額）</div>
                  <div className="space-y-1.5">
                    {closureImpact.groups.pending_reconcile.map((item) => (
                      <div key={item.booking_ref} className="flex flex-wrap items-center justify-between gap-2 bg-white border border-sky-200 rounded-lg px-2.5 py-2 text-xs">
                        <div>
                          <span className="font-bold text-gray-900">{item.user_name}</span>{' '}
                          <span className="text-gray-500">{item.time_range}（{item.pax} 位）</span>{' '}
                          <span className="text-sky-800 font-semibold">
                            {item.remittance_last5 ? `末五碼 ${item.remittance_last5}` : item.prepay_status}
                          </span>
                        </div>
                        <Link
                          to="/admin/reservations"
                          className="px-2.5 py-1 rounded-lg bg-sky-600 text-white font-bold hover:bg-sky-700"
                        >
                          前往對帳
                        </Link>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </form>

        {/* Shared Kiosk / Self-Service Settings (Read-only; unique editor is KioskPage) */}
        <div
          className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200 space-y-4 flex flex-col justify-between"
          data-testid="sessions-kiosk-settings-card"
        >
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-bold text-gray-900">半自助日共用設定（進場規則）</h2>
                <p className="text-xs text-gray-500 mt-0.5">唯讀顯示；全店共用，統一於「報到機設定」修改</p>
              </div>
              {canSettings ? (
                <Link
                  to="/admin/kiosk"
                  data-testid="link-to-kiosk-settings"
                  className="text-xs font-bold text-[#8B5B43] hover:underline shrink-0"
                >
                  到報到機頁修改 →
                </Link>
              ) : (
                <span
                  data-testid="kiosk-settings-readonly-notice"
                  className="text-xs font-bold text-gray-400 shrink-0"
                >
                  需要系統全域設定權限
                </span>
              )}
            </div>

            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">付款期限：前一日</span>
                <span className="font-bold text-gray-900">{kioskSettings.prepay_deadline_hour}:00</span>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">最早提前進場</span>
                <span className="font-bold text-gray-900">{kioskSettings.early_minutes} 分鐘進場</span>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">打烊後仍可進門</span>
                <span className="font-bold text-gray-900">{kioskSettings.after_close_minutes} 分鐘內</span>
              </div>

              <div className="flex items-center justify-between gap-3 bg-gray-50 p-3 rounded-xl border border-gray-100">
                <span className="font-semibold text-gray-700">同一位會員最多同時待付款預約</span>
                <span className="font-bold text-gray-900">{kioskSettings.max_unpaid_self_bookings} 筆</span>
              </div>
            </div>
          </div>

          {canSettings ? (
            <Link
              to="/admin/kiosk"
              className="block w-full text-center bg-[#FAF7F2] hover:bg-[#F2ECE4] text-[#8B5B43] border border-[#E8DEC8] font-bold py-3 rounded-xl transition-all text-sm"
            >
              到報到機頁修改
            </Link>
          ) : (
            <div className="w-full text-center py-3 bg-gray-50 text-gray-400 border border-gray-200 font-bold rounded-xl text-sm">
              需要系統全域設定權限
            </div>
          )}
        </div>
      </div>

      {/* Shortcut Banner to Dedicated System Settings Page */}
      <div className="bg-[#FAF7F2] p-5 sm:p-6 rounded-2xl shadow-xs border border-[#E8DEC8] mt-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-white border border-[#E8DEC8] text-[#8B5B43] shrink-0">
            <Sliders className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-[#3E332B]">
              顧客端首頁顯示、LINE 每次登入驗證與空位預覽開關已整合至「系統全域設定」
            </h2>
            <p className="text-xs text-[#6D5D52] mt-0.5 leading-relaxed">
              欲調整頂部公告欄、入場價格說明卡、官方 LINE 按鈕、空位預覽頁 (`/preview`) 維護開關或「每次使用皆須從 LINE 登入」，請前往系統全域設定頁面。
            </p>
          </div>
        </div>
        <a
          href="/admin/settings"
          className="px-5 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm shadow-xs transition-all text-center shrink-0"
        >
          前往系統全域設定 →
        </a>
      </div>

      {/* Delete Single Session Confirmation */}
      <ConfirmPanel
        isOpen={Boolean(deleteSessionTargetId)}
        onClose={() => setDeleteSessionTargetId(null)}
        onConfirm={handleConfirmDeleteSession}
        title="刪除時段"
        message="確定要刪除此時段嗎？"
        confirmText="刪除"
        danger
      />

      {/* Delete All Sessions Confirmation */}
      <ConfirmPanel
        isOpen={showDeleteAllConfirm}
        onClose={() => setShowDeleteAllConfirm(false)}
        onConfirm={handleConfirmDeleteAllForDate}
        title="刪除當日所有時段"
        message={`確定要刪除 ${listDate} 的所有未被預約時段嗎？已有預約的時段會自動保留。`}
        confirmText="確認刪除"
        danger
      />

      {/* Legacy Unpaid Bookings Price Change Confirmation */}
      <ConfirmPanel
        isOpen={Boolean(affectConfirmState)}
        onClose={() => setAffectConfirmState(null)}
        onConfirm={async () => {
          const state = affectConfirmState;
          setAffectConfirmState(null);
          if (!state) return;
          if (state.mode === 'single') {
            await saveDailyDayTypeAndSelf(true);
          } else if (state.mode === 'batch' && state.payload) {
            await executeBatchSubmit(state.payload, true);
          }
        }}
        title="變更將影響舊未付款預約"
        message={affectConfirmState?.message || ''}
        confirmText="確定套用"
      />

      {/* Batch Update Confirmation Modal */}
      {batchConfirmState && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="batch-confirm-modal"
        >
          <div className="bg-white rounded-3xl p-6 max-w-md w-full space-y-4 shadow-xl animate-fade-in">
            <h3 className="text-lg font-bold text-gray-900">確認批次修改日期設定？</h3>
            <div className="bg-amber-50/70 border border-amber-200 rounded-2xl p-4 space-y-2 text-sm text-gray-800">
              <div className="flex justify-between">
                <span className="text-gray-500">套用天數</span>
                <span className="font-bold">{batchConfirmState.daysCount} 天</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">每小時價格</span>
                <span className="font-bold">{batchConfirmState.hourlySummary}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">不限時價格</span>
                <span className="font-bold">{batchConfirmState.unlimitedSummary}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">不限時開放</span>
                <span className="font-bold">{batchConfirmState.allowUnlimitedSummary}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">半自助日設定</span>
                <span className="font-bold">{batchConfirmState.selfServiceSummary}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                data-testid="batch-confirm-cancel-btn"
                onClick={() => setBatchConfirmState(null)}
                className="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-xl"
              >
                先不要
              </button>
              <button
                type="button"
                data-testid="batch-confirm-submit-btn"
                onClick={handleConfirmBatchSubmit}
                className="px-5 py-2 text-sm font-bold text-white bg-[#8B5B43] hover:bg-[#724a35] rounded-xl shadow-xs"
              >
                確認送出
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Closure Batch Cancel & LINE Announcement Modal */}
      {showClosureCancelModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="closure-cancel-modal"
        >
          <div className="bg-white rounded-3xl p-6 max-w-lg w-full space-y-4 shadow-xl border border-gray-200">
            <h3 className="text-lg font-bold text-gray-900">
              批次取消並推送 LINE 公告（{selectedClosureRefs.length} 筆）
            </h3>

            <label className="flex items-center gap-2 cursor-pointer text-sm font-bold text-gray-800">
              <input
                type="checkbox"
                data-testid="closure-notify-checkbox"
                checked={closureNotifyLine}
                onChange={(e) => setClosureNotifyLine(e.target.checked)}
                className="w-4 h-4 accent-[#8B5B43]"
              />
              <span>取消成功後同時推送 LINE 公告給有綁定帳號的客人</span>
            </label>

            {closureNotifyLine && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-semibold text-gray-700">公告文字（可使用 {'{日期}'} {'{時段}'} {'{人數}'} {'{店家說明}'}）</span>
                    <span className="text-gray-400">{closureAnnouncement.length}/300</span>
                  </div>
                  <textarea
                    rows={4}
                    maxLength={300}
                    data-testid="closure-announcement-input"
                    value={closureAnnouncement}
                    onChange={(e) => setClosureAnnouncement(e.target.value)}
                    className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm"
                  />
                </div>

                {(() => {
                  const firstTarget = (closureImpact?.groups?.direct_cancel || []).find((i) =>
                    selectedClosureRefs.includes(i.booking_ref)
                  ) || closureImpact?.groups?.direct_cancel?.[0];
                  const previewText = firstTarget
                    ? renderClosurePreview(closureAnnouncement, {
                        dateStr: listDate,
                        timeRange: firstTarget.time_range,
                        pax: firstTarget.pax,
                        closedNote: closureImpact?.closed_note || closedNote
                      })
                    : '';
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
                      <div className="text-xs font-bold text-amber-900">
                        公告預覽{firstTarget ? `（以 ${firstTarget.user_name} 帶入）` : ''}
                      </div>
                      <p className="text-xs text-gray-800 whitespace-pre-wrap" data-testid="closure-announcement-preview">
                        {previewText}
                      </p>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowClosureCancelModal(false)}
                className="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-xl"
              >
                先不要
              </button>
              <button
                type="button"
                data-testid="closure-cancel-submit-btn"
                disabled={closureCancelling}
                onClick={handleBatchClosureCancel}
                className="px-5 py-2 text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl shadow-xs disabled:opacity-50"
              >
                {closureCancelling ? '處理中...' : '確認取消'}
              </button>
            </div>
          </div>
        </div>
      )}

      {closureCheckoutRef && (
        <CheckoutWorkbench
          isOpen={Boolean(closureCheckoutRef)}
          bookingRef={closureCheckoutRef}
          onClose={() => {
            setClosureCheckoutRef(null);
            fetchClosureImpact(listDate);
          }}
          onPaymentSuccess={() => {
            fetchClosureImpact(listDate);
          }}
        />
      )}
    </div>
  );
}

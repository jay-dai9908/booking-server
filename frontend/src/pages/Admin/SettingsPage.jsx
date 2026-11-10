import React, { useState, useEffect } from 'react';
import {
  Settings,
  ShieldCheck,
  Eye,
  Bell,
  CreditCard,
  MessageSquare,
  Cpu,
  Gift,
  Check,
  ExternalLink,
  RotateCcw,
  Sliders,
  Lock,
  MessageCircle,
  Key,
  ShoppingBag,
  Printer,
  Clock,
  Tag,
  Plus,
  Trash2,
  GripVertical,
  ArrowUp,
  ArrowDown,
  AlertTriangle
} from 'lucide-react';
import api from '../../api/axios';
import ConfirmPanel from '../../components/admin/ConfirmPanel';
import { setPrintGloballyEnabled } from '../../utils/sunmiPrinter';

const DEFAULT_PREVIEW_DISABLED_TEXT = '系統維護中，請點擊下方按鈕使用 LINE 進行預約';
const DEFAULT_ANNOUNCEMENT_TEXT = '歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠';
const DEFAULT_PRICE_NOTICE_TEXT = '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品';
const DEFAULT_LINE_URL = 'https://lin.ee/vsZhRW5';
const DEFAULT_BOOKING_NOTE_CHIPS = ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起'];
const DEFAULT_GUEST_LINE_HINT_TEXT = '會打開拾光製所的官方 LINE，從選單點『預約』就能登入';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState('');
  const [unpairingStation, setUnpairingStation] = useState(null);
  const [renamingStation, setRenamingStation] = useState(null);
  const [renameInput, setRenameInput] = useState('');

  // 1. Access & Preview Controls
  const [requireLineLoginEveryTime, setRequireLineLoginEveryTime] = useState(false);
  const [enablePreviewPage, setEnablePreviewPage] = useState(true);
  const [previewDisabledText, setPreviewDisabledText] = useState(DEFAULT_PREVIEW_DISABLED_TEXT);

  // 2. Customer Page Display Settings
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const [announcementText, setAnnouncementText] = useState(DEFAULT_ANNOUNCEMENT_TEXT);
  const [showPriceCards, setShowPriceCards] = useState(true);
  const [priceNoticeText, setPriceNoticeText] = useState(DEFAULT_PRICE_NOTICE_TEXT);
  const [showLineButton, setShowLineButton] = useState(true);
  const [showShopButton, setShowShopButton] = useState(true);
  const [lineButtonUrl, setLineButtonUrl] = useState(DEFAULT_LINE_URL);
  const [guestLineHintText, setGuestLineHintText] = useState(DEFAULT_GUEST_LINE_HINT_TEXT);
  const [bookingNoteChips, setBookingNoteChips] = useState(DEFAULT_BOOKING_NOTE_CHIPS);
  const [draggedChipIdx, setDraggedChipIdx] = useState(null);

  // 3. Global Store Default Prices
  const [weekdayHourly, setWeekdayHourly] = useState(100);
  const [weekdayUnlimited, setWeekdayUnlimited] = useState(550);
  const [weekendHourly, setWeekendHourly] = useState(150);
  const [weekendUnlimited, setWeekendUnlimited] = useState(800);

  // 3.1 Business Hours Presets & Session Capacity
  const [businessHours, setBusinessHours] = useState({
    weekday: { start: '10:00', end: '21:00' },
    saturday: { start: '09:00', end: '21:00' },
    sunday: { start: '09:00', end: '21:00' }
  });
  const [defaultSessionCapacity, setDefaultSessionCapacity] = useState(16);
  const [layoutSeatCount, setLayoutSeatCount] = useState(16);

  // 4. Smart Board Global Rules
  const [allowEquipmentExceedPax, setAllowEquipmentExceedPax] = useState(false);
  const [showEquipmentLiveStock, setShowEquipmentLiveStock] = useState(true);
  const [equipmentDiscountEnabled, setEquipmentDiscountEnabled] = useState(true);
  const [equipmentDiscountBuyHours, setEquipmentDiscountBuyHours] = useState(3);
  const [equipmentDiscountFreeHours, setEquipmentDiscountFreeHours] = useState(1);
  const [equipmentDiscount2Enabled, setEquipmentDiscount2Enabled] = useState(false);
  const [equipmentDiscount2BuyHours, setEquipmentDiscount2BuyHours] = useState(8);
  const [equipmentDiscount2FreeHours, setEquipmentDiscount2FreeHours] = useState(4);
  const [equipmentDiscountStackable, setEquipmentDiscountStackable] = useState(true);

  // 5. LINE Messaging API & Push Notifications
  const [hasLineMessagingToken, setHasLineMessagingToken] = useState(false);
  const [lineMessagingTokenMasked, setLineMessagingTokenMasked] = useState('');
  const [lineMessagingTokenInput, setLineMessagingTokenInput] = useState('');
  const [lineAutoNotifyBooking, setLineAutoNotifyBooking] = useState(false);
  const [lineAutoNotifyCancel, setLineAutoNotifyCancel] = useState(false);

  // 6. Checkout & Timer Rules (Spec 6.25)
  const [billingGraceMinutes, setBillingGraceMinutes] = useState(10);
  const [billingBlockMinutes, setBillingBlockMinutes] = useState(30);
  const [earlyLeaveMode, setEarlyLeaveMode] = useState('booked');
  const [boardSwapGraceMinutes, setBoardSwapGraceMinutes] = useState(10);
  const [defaultSplitMode, setDefaultSplitMode] = useState('proportional');
  const [cashFloatAmount, setCashFloatAmount] = useState(2000);
  const [paymentMethods, setPaymentMethods] = useState([
    { key: 'cash', label: '現金', enabled: true },
    { key: 'linepay', label: 'LINE Pay', enabled: true },
    { key: 'transfer', label: '銀行轉帳', enabled: true }
  ]);
  const [draggedMethodIdx, setDraggedMethodIdx] = useState(null);

  // 7. Printing & Station Settings (Spec 6.25)
  const [printEnabled, setPrintEnabled] = useState(true);
  const [confirmDisablePrint, setConfirmDisablePrint] = useState(null);
  const [autoPrintReceipt, setAutoPrintReceipt] = useState(true);
  const [autoPrintSummary, setAutoPrintSummary] = useState(true);
  const [receiptFooterText, setReceiptFooterText] = useState('謝謝光臨，作品記得帶回家');
  const [printStations, setPrintStations] = useState([]);

  useEffect(() => {
    fetchGlobalSettings();
  }, []);

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
  };

  const handleTogglePrintEnabled = async (checked) => {
    if (!checked) {
      try {
        const res = await api.get('/print/jobs');
        const unprinted = (res.data?.jobs || []).filter(j => j.status === 'queued' || j.status === 'claimed');
        if (unprinted.length > 0) {
          setConfirmDisablePrint({ count: unprinted.length });
          return;
        }
      } catch (e) {
        console.warn('Failed to check unprinted jobs:', e);
      }
      setPrintEnabled(false);
      setPrintGloballyEnabled(false);
      await handleSaveAll({ print_enabled: false });
    } else {
      setPrintEnabled(true);
      setPrintGloballyEnabled(true);
      await handleSaveAll({ print_enabled: true });
    }
  };

  const fetchGlobalSettings = async () => {
    setLoading(true);
    try {
      const res = await api.get('/daily-settings/global');
      const d = res.data || {};
      setRequireLineLoginEveryTime(!!d.require_line_login_every_time);
      setEnablePreviewPage(d.enable_preview_page !== false);
      setPreviewDisabledText(d.preview_disabled_text ?? DEFAULT_PREVIEW_DISABLED_TEXT);

      setShowAnnouncement(d.show_announcement !== false);
      setAnnouncementText(d.announcement_text ?? DEFAULT_ANNOUNCEMENT_TEXT);
      setShowPriceCards(d.show_price_cards !== false);
      setPriceNoticeText(d.price_notice_text ?? DEFAULT_PRICE_NOTICE_TEXT);
      setShowLineButton(d.show_line_button !== false);
      setShowShopButton(d.show_shop_button !== false && d.shop_enabled !== false);
      setLineButtonUrl(d.official_line_url || d.line_button_url || DEFAULT_LINE_URL);
      setGuestLineHintText(d.guest_line_hint_text ?? DEFAULT_GUEST_LINE_HINT_TEXT);
      if (Array.isArray(d.booking_note_chips) && d.booking_note_chips.length > 0) {
        setBookingNoteChips(d.booking_note_chips);
      } else {
        setBookingNoteChips(DEFAULT_BOOKING_NOTE_CHIPS);
      }

      setWeekdayHourly(d.weekday_hourly_price ?? 100);
      setWeekdayUnlimited(d.weekday_unlimited_price ?? 550);
      setWeekendHourly(d.weekend_hourly_price ?? 150);
      setWeekendUnlimited(d.weekend_unlimited_price ?? 800);

      if (d.business_hours_json) {
        setBusinessHours({
          weekday: {
            start: d.business_hours_json.weekday?.start || '10:00',
            end: d.business_hours_json.weekday?.end || '21:00'
          },
          saturday: {
            start: d.business_hours_json.saturday?.start || '09:00',
            end: d.business_hours_json.saturday?.end || '21:00'
          },
          sunday: {
            start: d.business_hours_json.sunday?.start || '09:00',
            end: d.business_hours_json.sunday?.end || '21:00'
          }
        });
      }

      setDefaultSessionCapacity(d.default_session_capacity ?? 16);
      try {
        const lRes = await api.get('/seat-layouts/active');
        const count = lRes.data?.capacity ?? (lRes.data?.seats || []).filter(s => s.is_active)?.length ?? 16;
        setLayoutSeatCount(count);
      } catch (e) {}

      setAllowEquipmentExceedPax(!!d.allow_equipment_exceed_pax);
      setShowEquipmentLiveStock(d.show_equipment_live_stock !== false);
      setEquipmentDiscountEnabled(d.equipment_discount_enabled !== false);
      setEquipmentDiscountBuyHours(d.equipment_discount_buy_hours ?? 3);
      setEquipmentDiscountFreeHours(d.equipment_discount_free_hours ?? 1);
      setEquipmentDiscount2Enabled(!!d.equipment_discount2_enabled);
      setEquipmentDiscount2BuyHours(d.equipment_discount2_buy_hours ?? 8);
      setEquipmentDiscount2FreeHours(d.equipment_discount2_free_hours ?? 4);
      setEquipmentDiscountStackable(d.equipment_discount_stackable !== false);

      setHasLineMessagingToken(!!d.has_line_messaging_token);
      setLineMessagingTokenMasked(d.line_messaging_token_masked || '');
      setLineAutoNotifyBooking(!!d.line_auto_notify_booking);
      setLineAutoNotifyCancel(!!d.line_auto_notify_cancel);
      setLineMessagingTokenInput('');

      setBillingGraceMinutes(d.billing_grace_minutes ?? 10);
      setBillingBlockMinutes(d.billing_block_minutes ?? 30);
      setEarlyLeaveMode(d.early_leave_mode || 'booked');
      setBoardSwapGraceMinutes(d.board_swap_grace_minutes ?? 10);
      setDefaultSplitMode(d.default_split_mode || 'proportional');
      setCashFloatAmount(d.cash_float_amount ?? 2000);
      if (Array.isArray(d.payment_methods_json) && d.payment_methods_json.length > 0) {
        setPaymentMethods(d.payment_methods_json.filter(m => String(m.key || m.code || '').trim().toLowerCase() !== 'pass'));
      } else {
        setPaymentMethods([
          { key: 'cash', label: '現金', enabled: true },
          { key: 'linepay', label: 'LINE Pay', enabled: true },
          { key: 'transfer', label: '銀行轉帳', enabled: true }
        ]);
      }

      const pe = d.print_enabled !== false;
      setPrintEnabled(pe);
      setPrintGloballyEnabled(pe);
      setAutoPrintReceipt(d.auto_print_receipt !== false);
      setAutoPrintSummary(d.auto_print_summary !== false);
      setReceiptFooterText(d.receipt_footer_text ?? '謝謝光臨，作品記得帶回家');

      try {
        const stRes = await api.get('/print/stations');
        setPrintStations(stRes.data?.stations || []);
      } catch (stErr) {}
    } catch (err) {
      console.error('Failed to fetch global settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAll = async (overridePatch = {}) => {
    setSaving(true);
    try {
      const payload = {
        require_line_login_every_time: requireLineLoginEveryTime,
        enable_preview_page: enablePreviewPage,
        preview_disabled_text: previewDisabledText || DEFAULT_PREVIEW_DISABLED_TEXT,
        show_announcement: showAnnouncement,
        announcement_text: announcementText,
        show_price_cards: showPriceCards,
        price_notice_text: priceNoticeText,
        show_line_button: showLineButton,
        show_shop_button: showShopButton,
        line_button_url: lineButtonUrl,
        official_line_url: lineButtonUrl,
        guest_line_hint_text: guestLineHintText,
        booking_note_chips: bookingNoteChips.map(s => String(s || '').trim()).filter(Boolean).map(s => s.slice(0, 12)).slice(0, 8),
        weekday_hourly_price: parseInt(weekdayHourly, 10) || 100,
        weekday_unlimited_price: parseInt(weekdayUnlimited, 10) || 550,
        weekend_hourly_price: parseInt(weekendHourly, 10) || 150,
        weekend_unlimited_price: parseInt(weekendUnlimited, 10) || 800,
        allow_equipment_exceed_pax: allowEquipmentExceedPax,
        show_equipment_live_stock: showEquipmentLiveStock,
        equipment_discount_enabled: equipmentDiscountEnabled,
        equipment_discount_buy_hours: Math.max(1, parseInt(equipmentDiscountBuyHours, 10) || 3),
        equipment_discount_free_hours: Math.max(1, parseInt(equipmentDiscountFreeHours, 10) || 1),
        equipment_discount2_enabled: equipmentDiscount2Enabled,
        equipment_discount2_buy_hours: Math.max(1, parseInt(equipmentDiscount2BuyHours, 10) || 8),
        equipment_discount2_free_hours: Math.max(1, parseInt(equipmentDiscount2FreeHours, 10) || 4),
        equipment_discount_stackable: equipmentDiscountStackable,
        line_auto_notify_booking: lineAutoNotifyBooking,
        line_auto_notify_cancel: lineAutoNotifyCancel,
        billing_grace_minutes: parseInt(billingGraceMinutes, 10) || 10,
        billing_block_minutes: parseInt(billingBlockMinutes, 10) || 30,
        early_leave_mode: earlyLeaveMode,
        board_swap_grace_minutes: parseInt(boardSwapGraceMinutes, 10) || 10,
        default_split_mode: defaultSplitMode,
        cash_float_amount: parseInt(cashFloatAmount, 10) || 2000,
        payment_methods_json: paymentMethods,
        print_enabled: printEnabled,
        auto_print_receipt: autoPrintReceipt,
        auto_print_summary: autoPrintSummary,
        receipt_footer_text: receiptFooterText,
        business_hours_json: businessHours,
        default_session_capacity: parseInt(defaultSessionCapacity, 10) || 16,
        ...overridePatch
      };

      if (lineMessagingTokenInput.trim() && !lineMessagingTokenInput.includes('•') && !lineMessagingTokenInput.includes('****')) {
        payload.line_messaging_token = lineMessagingTokenInput.trim();
      }

      await api.put('/daily-settings/global', payload);
      try {
        localStorage.removeItem('shiguang_booking_global_settings_cache');
      } catch (e) {}
      showToast('系統設定已成功儲存並立即生效！');

      if (payload.line_messaging_token) {
        setHasLineMessagingToken(true);
        const t = payload.line_messaging_token;
        setLineMessagingTokenMasked(`••••••••${t.slice(-4)}`);
        setLineMessagingTokenInput('');
      }
    } catch (err) {
      console.error('Failed to save global settings:', err);
      alert(err.response?.data?.error || '儲存系統設定失敗');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickToggle = async (field, nextValue, setter) => {
    setter(nextValue);
    await handleSaveAll({ [field]: nextValue });
  };

  const handleRenameStation = (st) => {
    setRenamingStation(st);
    setRenameInput(st.name || '');
  };

  const handleSaveRename = async () => {
    if (!renamingStation) return;
    const newName = renameInput.trim();
    if (!newName) {
      alert('請輸入列印站名稱');
      return;
    }
    try {
      await api.patch(`/print/stations/${renamingStation.id}`, { name: newName });
      setPrintStations(prev => prev.map(s => s.id === renamingStation.id ? { ...s, name: newName } : s));
      showToast('已修改列印站名稱');
      setRenamingStation(null);
    } catch (err) {
      alert(err.response?.data?.error || '修改名稱失敗');
    }
  };

  const handleToggleStationAccepting = async (st) => {
    const nextAccepting = st.accepting === false ? true : false;
    try {
      await api.patch(`/print/stations/${st.id}`, { accepting: nextAccepting });
      setPrintStations(prev => prev.map(s => s.id === st.id ? { ...s, accepting: nextAccepting } : s));
      showToast(nextAccepting ? '已恢復接單' : '已暫停接單');
    } catch (err) {
      alert(err.response?.data?.error || '操作失敗');
    }
  };

  const handleTestStationPrint = async (st) => {
    try {
      await api.post(`/print/stations/${st.id}/test`);
      showToast(`已對「${st.name}」送出測試列印工作！`);
    } catch (err) {
      alert(err.response?.data?.error || '測試列印失敗');
    }
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-4 border-[#E8DEC8] border-t-[#8B5B43] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-fade-in">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-6 right-6 z-50 bg-emerald-700 text-white px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-sm font-bold">
          <Check className="w-4 h-4" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Page Header Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-end gap-4 pb-2">
        <button
          type="button"
          onClick={() => handleSaveAll()}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#724a35] text-white px-6 py-2.5 rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-50 shrink-0"
        >
          {saving ? '儲存設定中...' : '儲存全部系統設定'}
        </button>
      </div>

      {/* SECTION 1: 登入驗證機制與空位預覽頁開關 */}
      <div className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] p-6 space-y-6">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-[#8B5B43]" />
              1. 顧客登入驗證與公開空位預覽控制
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              控制顧客進入系統時是否必須每次重新由 LINE 登入，以及公開空位預覽頁 (`/preview`) 的開放狀態
            </p>
          </div>
          <a
            href="/preview"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-bold text-[#8B5B43] bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] px-3 py-1.5 rounded-xl transition-colors"
          >
            <span>預覽空位頁面 (/preview)</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Card 1A: Require LINE Login Every Time */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <span className="font-bold text-base text-[#3E332B] flex items-center gap-2">
                  <Lock className="w-4 h-4 text-[#8B5B43]" />
                  顧客每次使用皆須從 LINE 進行登入
                </span>
                <p className="text-xs text-[#6D5D52] leading-relaxed">
                  開啟後，系統<strong>不沿用舊有登入紀錄</strong>（不自動記住上次登入 Cookie），顧客每次開啟預約網頁時皆須點擊「使用 LINE 登入」重新驗證。
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                <input
                  type="checkbox"
                  checked={requireLineLoginEveryTime}
                  onChange={e =>
                    handleQuickToggle('require_line_login_every_time', e.target.checked, setRequireLineLoginEveryTime)
                  }
                  className="sr-only peer"
                />
                <div className="w-12 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#8B5B43]"></div>
              </label>
            </div>

            <div className={`text-xs font-semibold p-3 rounded-xl border ${
              requireLineLoginEveryTime
                ? 'bg-amber-50/90 text-amber-900 border-amber-300'
                : 'bg-white text-gray-600 border-gray-200'
            }`}>
              {requireLineLoginEveryTime
                ? '目前狀態：【強制每次 LINE 登入】顧客每次打開網頁皆不使用舊有登入紀錄，須透過 LINE 重新登入'
                : '目前狀態：【一般便利模式】顧客登入後保留 7 天登入紀錄，期間再次開啟可直接進入預約頁面'}
            </div>
          </div>

          {/* Card 1B: Public Preview Page Switch & Custom Message */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <span className="font-bold text-base text-[#3E332B] flex items-center gap-2">
                  <Eye className="w-4 h-4 text-[#8B5B43]" />
                  開放「空位預覽網頁 (`/preview`)」查詢功能
                </span>
                <p className="text-xs text-[#6D5D52] leading-relaxed">
                  關閉時，空位預覽網頁將隱藏日曆與時段空位表，顯示下方自訂文字，且顧客只能點擊下方按鈕透過 LINE 登入查看與預約。
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                <input
                  type="checkbox"
                  checked={enablePreviewPage}
                  onChange={e =>
                    handleQuickToggle('enable_preview_page', e.target.checked, setEnablePreviewPage)
                  }
                  className="sr-only peer"
                />
                <div className="w-12 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>

            <div className="pt-3 border-t border-[#E8DEC8]/80 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-[#3E332B]">
                  關閉預覽時顯示的提示內容（可自行修改）：
                </label>
                <button
                  type="button"
                  onClick={() => setPreviewDisabledText(DEFAULT_PREVIEW_DISABLED_TEXT)}
                  className="text-[11px] font-bold text-[#8B5B43] hover:underline flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  恢復預設文字
                </button>
              </div>
              <textarea
                rows="2"
                value={previewDisabledText}
                onChange={e => setPreviewDisabledText(e.target.value)}
                placeholder={DEFAULT_PREVIEW_DISABLED_TEXT}
                className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl text-[#3E332B] focus:border-[#8B5B43] focus:outline-none leading-relaxed"
              />
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className={`text-[11px] font-semibold ${enablePreviewPage ? 'text-emerald-700' : 'text-amber-800'}`}>
                  {enablePreviewPage
                    ? '目前狀態：公開空位預覽功能【開放中】'
                    : '目前狀態：公開空位預覽【已關閉】，僅顯示上方提示並引導點擊下方按鈕登入 LINE'}
                </span>
                <button
                  type="button"
                  onClick={() => handleSaveAll()}
                  disabled={saving}
                  className="px-3 py-1 bg-[#8B5B43] hover:bg-[#724a35] text-white text-xs font-bold rounded-lg transition shrink-0"
                >
                  儲存文字
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 2: 顧客預約首頁與預覽頁區塊顯示設定 (Moved from SessionsPage) */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#E8DEC8]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
              <Sliders className="w-5 h-5 text-[#8B5B43]" />
              2. 顧客預約首頁與預覽頁區塊顯示設定
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              自訂顧客端頁面各區塊的顯示或隱藏（頂部系統公告欄、入場價格表雙卡片、官方 LINE 連結按鈕）
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleSaveAll()}
            disabled={saving}
            className="px-5 py-2 bg-[#3E332B] hover:bg-[#2C241E] text-white font-semibold rounded-xl text-xs sm:text-sm shadow-sm transition-all shrink-0 disabled:opacity-50"
          >
            儲存顯示設定
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          {/* Switch 1: Announcement */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                  <Bell className="w-4 h-4 text-amber-600" />
                  頂部系統公告欄
                </span>
                <p className="text-xs text-[#6D5D52] mt-1">
                  顧客頁面最上方的橫幅公告（點擊可展開完整公告彈窗）
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={showAnnouncement}
                  onChange={e => handleQuickToggle('show_announcement', e.target.checked, setShowAnnouncement)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>
            {showAnnouncement && (
              <div className="pt-3 border-t border-[#E8DEC8]">
                <label className="block text-xs font-semibold text-[#3E332B] mb-1.5">公告文字內容</label>
                <textarea
                  rows="3"
                  value={announcementText}
                  onChange={e => setAnnouncementText(e.target.value)}
                  placeholder="留空將顯示系統預設公告"
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl focus:border-[#8B5B43] focus:outline-none leading-relaxed"
                />
              </div>
            )}
            <div className="text-[11px] text-[#6D5D52] bg-white p-2 rounded-lg border border-[#E8DEC8]">
              {showAnnouncement ? '目前狀態：顧客端顯示頂部系統公告欄' : '目前狀態：顧客端隱藏公告欄'}
            </div>
          </div>

          {/* Switch 2: Price Cards */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-[#8B5B43]" />
                  首頁入場價格表雙卡片
                </span>
                <p className="text-xs text-[#6D5D52] mt-1">
                  控制顧客預約頁與預覽頁的平日/假日收費說明雙卡片
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={showPriceCards}
                  onChange={e => handleQuickToggle('show_price_cards', e.target.checked, setShowPriceCards)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>
            {showPriceCards && (
              <div className="pt-3 border-t border-[#E8DEC8]">
                <label className="block text-xs font-semibold text-[#3E332B] mb-1.5">價格卡下方備註提醒文字</label>
                <textarea
                  rows="3"
                  value={priceNoticeText}
                  onChange={e => setPriceNoticeText(e.target.value)}
                  placeholder="留空將顯示系統預設備註提醒"
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl focus:border-[#8B5B43] focus:outline-none leading-relaxed"
                />
              </div>
            )}
            <div className="text-[11px] text-[#6D5D52] bg-white p-2 rounded-lg border border-[#E8DEC8]">
              {showPriceCards ? '目前狀態：顧客端顯示平假日價格說明卡' : '目前狀態：顧客端隱藏價格說明卡'}
            </div>
          </div>

          {/* Switch 3: LINE Button */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                  <MessageSquare className="w-4 h-4 text-emerald-600" />
                  官方 LINE 連結與按鈕設定
                </span>
                <p className="text-xs text-[#6D5D52] mt-1">
                  控制預約頁頂部「官方 LINE」按鈕顯示，以及空位預覽頁下方綠色按鈕跳轉網址
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={showLineButton}
                  onChange={e => handleQuickToggle('show_line_button', e.target.checked, setShowLineButton)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              </label>
            </div>
            <div className="pt-3 border-t border-[#E8DEC8] space-y-2">
              <div>
                <label className="block text-xs font-semibold text-[#3E332B] mb-1.5">官方 LINE 連結網址</label>
                <input
                  type="url"
                  value={lineButtonUrl}
                  onChange={e => setLineButtonUrl(e.target.value)}
                  placeholder="https://lin.ee/..."
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl focus:border-[#8B5B43] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#3E332B] mb-1.5">未登入按鈕下方提示小字</label>
                <input
                  type="text"
                  value={guestLineHintText}
                  onChange={e => setGuestLineHintText(e.target.value)}
                  placeholder="會打開拾光製所的官方 LINE，從選單點『預約』就能登入"
                  className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl focus:border-[#8B5B43] focus:outline-none"
                />
              </div>
            </div>
            <div className="text-[11px] text-[#6D5D52] bg-white p-2 rounded-lg border border-[#E8DEC8]">
              {showLineButton ? '目前狀態：顧客端頂部顯示官方 LINE 按鈕' : '目前狀態：顧客端頂部隱藏官方 LINE 按鈕'}
            </div>
          </div>

          {/* Switch 4: Shop Preorder Button */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] flex flex-col justify-between space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="font-bold text-sm text-[#3E332B] flex items-center gap-1.5">
                  <ShoppingBag className="w-4 h-4 text-[#8B5B43]" />
                  前台「商品預購」入口按鈕
                </span>
                <p className="text-xs text-[#6D5D52] mt-1">
                  控制顧客預約頁面頂部的「商品預購」按鈕顯示。關閉時預約頁頂部隱藏此按鈕，避免擠壓手機排版或未開放預購時被誤點
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-0.5">
                <input
                  type="checkbox"
                  checked={showShopButton}
                  onChange={e => handleQuickToggle('show_shop_button', e.target.checked, setShowShopButton)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#8B5B43]"></div>
              </label>
            </div>
            <div className="text-[11px] text-[#6D5D52] bg-white p-2 rounded-lg border border-[#E8DEC8]">
              {showShopButton ? '目前狀態：顧客預約頁頂部顯示「商品預購」按鈕' : '目前狀態：顧客預約頁頂部隱藏此按鈕'}
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 2.5: 預約備註快速選項 (Round 9 Section 2) */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#E8DEC8]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6 pb-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
              <Tag className="w-5 h-5 text-[#8B5B43]" />
              預約備註快速選項
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              顧客在預約確認頁可點選的快速備註標籤，最多 8 個，每個最多 12 字。可新增、刪除、修改與拖曳排序。
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleSaveAll()}
            disabled={saving}
            data-testid="save-note-chips-btn"
            className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white font-semibold rounded-xl text-xs sm:text-sm shadow-sm transition-all shrink-0 disabled:opacity-50"
          >
            {saving ? '儲存中...' : '儲存備註選項'}
          </button>
        </div>

        <div className="space-y-6">
          {/* Chip Editor List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-700">
                標籤清單（目前 {bookingNoteChips.length} / 8 個）
              </span>
              <button
                type="button"
                onClick={() => {
                  if (bookingNoteChips.length < 8) {
                    setBookingNoteChips([...bookingNoteChips, '']);
                  }
                }}
                disabled={bookingNoteChips.length >= 8}
                data-testid="add-note-chip-btn"
                className="px-3 py-1 bg-[#FAF7F2] text-[#8B5B43] hover:bg-[#E8DEC8]/60 border border-[#E8DEC8] rounded-lg text-xs font-bold flex items-center gap-1 transition disabled:opacity-40"
              >
                <Plus className="w-3.5 h-3.5" />
                新增選項
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="note-chips-editor-list">
              {bookingNoteChips.map((chip, idx) => (
                <div
                  key={idx}
                  draggable
                  onDragStart={() => setDraggedChipIdx(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (draggedChipIdx === null || draggedChipIdx === idx) return;
                    const items = [...bookingNoteChips];
                    const [moved] = items.splice(draggedChipIdx, 1);
                    items.splice(idx, 0, moved);
                    setBookingNoteChips(items);
                    setDraggedChipIdx(null);
                  }}
                  className="flex items-center gap-2 p-2.5 bg-[#FAF7F2] rounded-xl border border-[#E8DEC8] transition hover:border-[#8B5B43]"
                >
                  <span className="cursor-grab text-gray-400 hover:text-gray-600">
                    <GripVertical className="w-4 h-4" />
                  </span>
                  <div className="flex-1 relative">
                    <input
                      type="text"
                      value={chip}
                      maxLength={12}
                      onChange={(e) => {
                        const updated = [...bookingNoteChips];
                        updated[idx] = e.target.value.slice(0, 12);
                        setBookingNoteChips(updated);
                      }}
                      data-testid={`note-chip-input-${idx}`}
                      placeholder={`選項 ${idx + 1}`}
                      className="w-full px-3 py-1.5 pr-12 text-xs bg-white border border-[#E8DEC8] rounded-lg focus:border-[#8B5B43] focus:outline-none"
                    />
                    <span className="absolute right-2 top-2 text-[10px] text-gray-400">
                      {chip.length}/12
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => {
                        if (idx > 0) {
                          const items = [...bookingNoteChips];
                          const tmp = items[idx - 1];
                          items[idx - 1] = items[idx];
                          items[idx] = tmp;
                          setBookingNoteChips(items);
                        }
                      }}
                      className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-20"
                      title="上移"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === bookingNoteChips.length - 1}
                      onClick={() => {
                        if (idx < bookingNoteChips.length - 1) {
                          const items = [...bookingNoteChips];
                          const tmp = items[idx + 1];
                          items[idx + 1] = items[idx];
                          items[idx] = tmp;
                          setBookingNoteChips(items);
                        }
                      }}
                      className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-20"
                      title="下移"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setBookingNoteChips(bookingNoteChips.filter((_, i) => i !== idx));
                      }}
                      data-testid={`delete-note-chip-${idx}`}
                      className="p-1 text-red-500 hover:text-red-700"
                      title="刪除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Preview */}
          <div className="p-4 bg-gray-50 rounded-2xl border border-gray-200 space-y-2">
            <span className="text-xs font-bold text-gray-600 block">
              即時預覽（顧客預約確認頁顯示效果）
            </span>
            <div className="flex flex-wrap gap-[6px] p-3 bg-white rounded-xl border border-gray-200" data-testid="note-chips-live-preview">
              {bookingNoteChips.length === 0 ? (
                <span className="text-xs text-gray-400 py-1">目前沒有任何備註選項</span>
              ) : (
                bookingNoteChips.map((chip, idx) => (
                  <span
                    key={idx}
                    className="min-h-[32px] px-[10px] py-[3px] rounded-full text-[12px] font-bold bg-[#FAF7F2] text-[#8B5B43] border border-[#E8DEC8] flex items-center select-none"
                  >
                    {chip || '（空白）'}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: 全店預設入場收費與智能拼豆板全域規則 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 3A: Store Default Pricing */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#E8DEC8] flex flex-col justify-between space-y-5">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2 mb-1">
              <CreditCard className="w-5 h-5 text-[#8B5B43]" />
              3. 全店預設入場收費標準
            </h2>
            <p className="text-xs text-gray-500">
              設定平日與假日的基礎計時與不限時封頂價格（單日特殊覆蓋可於「營業時段設定」調整）
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]">
              <label className="block text-xs font-bold text-[#3E332B] mb-1">平日每小時 ($/hr)</label>
              <input
                type="number"
                value={weekdayHourly}
                onChange={e => setWeekdayHourly(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
              />
            </div>
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]">
              <label className="block text-xs font-bold text-[#3E332B] mb-1">平日不限時封頂 ($/人)</label>
              <input
                type="number"
                value={weekdayUnlimited}
                onChange={e => setWeekdayUnlimited(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
              />
            </div>
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]">
              <label className="block text-xs font-bold text-[#3E332B] mb-1">假日每小時 ($/hr)</label>
              <input
                type="number"
                value={weekendHourly}
                onChange={e => setWeekendHourly(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
              />
            </div>
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8]">
              <label className="block text-xs font-bold text-[#3E332B] mb-1">假日不限時封頂 ($/人)</label>
              <input
                type="number"
                value={weekendUnlimited}
                onChange={e => setWeekendUnlimited(e.target.value)}
                className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleSaveAll()}
            disabled={saving}
            className="w-full py-2.5 bg-[#3E332B] hover:bg-[#2C241E] text-white font-bold rounded-xl text-xs sm:text-sm transition-all"
          >
            儲存全店預設價格
          </button>
        </div>

        {/* 3B: Smart Board Global Rules */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#E8DEC8] flex flex-col justify-between space-y-4">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2 mb-1">
              <Cpu className="w-5 h-5 text-[#8B5B43]" />
              4. 智能拼豆板全域租借與買送規則
            </h2>
            <p className="text-xs text-gray-500">
              設定單筆訂單租借台數上限、即時庫存顯示與滿時數買送方案
            </p>
          </div>

          <div className="space-y-3">
            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8] flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold text-[#3E332B]">允許單筆訂單設備總數超過預約人數</div>
                <div className="text-[11px] text-[#6D5D52]">
                  {allowEquipmentExceedPax ? '目前允許自由加購超過人數' : '目前限制總台數不可超過預約人數'}
                </div>
              </div>
              <input
                type="checkbox"
                checked={allowEquipmentExceedPax}
                onChange={e =>
                  handleQuickToggle('allow_equipment_exceed_pax', e.target.checked, setAllowEquipmentExceedPax)
                }
                className="w-4 h-4 accent-[#8B5B43]"
              />
            </div>

            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8] flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold text-[#3E332B]">於顧客預約頁顯示「即時庫存狀況卡片」</div>
                <div className="text-[11px] text-[#6D5D52]">
                  {showEquipmentLiveStock ? '顯示各規格剩餘庫存' : '隱藏即時庫存卡片'}
                </div>
              </div>
              <input
                type="checkbox"
                checked={showEquipmentLiveStock}
                onChange={e =>
                  handleQuickToggle('show_equipment_live_stock', e.target.checked, setShowEquipmentLiveStock)
                }
                className="w-4 h-4 accent-[#8B5B43]"
              />
            </div>

            <div className="bg-[#FAF7F2] p-3.5 rounded-xl border border-[#E8DEC8] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#3E332B] flex items-center gap-1.5">
                  <Gift className="w-4 h-4 text-[#8B5B43]" />
                  智能板時數優惠方案（買 X 小時送 Y 小時）
                </span>
                <input
                  type="checkbox"
                  checked={equipmentDiscountEnabled}
                  onChange={e =>
                    handleQuickToggle('equipment_discount_enabled', e.target.checked, setEquipmentDiscountEnabled)
                  }
                  className="w-4 h-4 accent-[#8B5B43]"
                />
              </div>

              {equipmentDiscountEnabled && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  <div className="bg-white p-2.5 rounded-lg border border-[#E8DEC8] flex items-center gap-1.5 text-xs font-bold text-[#3E332B]">
                    <span>一階：買</span>
                    <input
                      type="number"
                      min="1"
                      value={equipmentDiscountBuyHours}
                      onChange={e => setEquipmentDiscountBuyHours(e.target.value)}
                      className="w-11 px-1.5 py-0.5 text-center border border-[#E8DEC8] rounded"
                    />
                    <span>送</span>
                    <input
                      type="number"
                      min="1"
                      value={equipmentDiscountFreeHours}
                      onChange={e => setEquipmentDiscountFreeHours(e.target.value)}
                      className="w-11 px-1.5 py-0.5 text-center border border-[#E8DEC8] rounded"
                    />
                    <span>hr</span>
                  </div>

                  <div className="bg-white p-2.5 rounded-lg border border-[#E8DEC8] flex items-center gap-1.5 text-xs font-bold text-[#3E332B]">
                    <input
                      type="checkbox"
                      checked={equipmentDiscount2Enabled}
                      onChange={e => setEquipmentDiscount2Enabled(e.target.checked)}
                      className="accent-[#8B5B43]"
                    />
                    <span>二階：買</span>
                    <input
                      type="number"
                      min="1"
                      value={equipmentDiscount2BuyHours}
                      onChange={e => setEquipmentDiscount2BuyHours(e.target.value)}
                      className="w-11 px-1.5 py-0.5 text-center border border-[#E8DEC8] rounded"
                    />
                    <span>送</span>
                    <input
                      type="number"
                      min="1"
                      value={equipmentDiscount2FreeHours}
                      onChange={e => setEquipmentDiscount2FreeHours(e.target.value)}
                      className="w-11 px-1.5 py-0.5 text-center border border-[#E8DEC8] rounded"
                    />
                    <span>hr</span>
                  </div>

                  <div className="sm:col-span-2 bg-white p-2.5 rounded-lg border border-[#E8DEC8] flex items-center justify-between text-xs font-bold text-[#3E332B]">
                    <span>允許買送優惠連續累贈（如租 8 小時套用 2 次買 3 送 1）</span>
                    <input
                      type="checkbox"
                      checked={equipmentDiscountStackable}
                      onChange={e =>
                        handleQuickToggle('equipment_discount_stackable', e.target.checked, setEquipmentDiscountStackable)
                      }
                      className="w-4 h-4 accent-[#8B5B43]"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => handleSaveAll()}
            disabled={saving}
            className="w-full py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm transition-all"
          >
            儲存智能板全域規則
          </button>
        </div>
      </div>

      {/* SECTION 4.1: 營業時間預設（時段快選範本） */}
      <div className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] p-6 space-y-5" data-testid="business-hours-setting-card">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2 mb-1">
              <Clock className="w-5 h-5 text-[#8B5B43]" />
              營業時間預設（時段快選範本）
            </h2>
            <p className="text-xs text-gray-500">
              設定平日、週六與週日的標準營業時段。在「營業時段設定」中，快捷按鈕將直接帶入此處設定的時間。
            </p>
          </div>
          <button
            type="button"
            data-testid="save-business-hours-btn"
            onClick={() => handleSaveAll()}
            disabled={saving}
            className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm transition-all"
          >
            {saving ? '儲存中...' : '儲存營業時間預設'}
          </button>
        </div>

        {/* 每個時段可預約人數（預設） */}
        <div className="bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <label className="block text-sm font-bold text-[#3E332B] mb-0.5">
              每個時段可預約人數（預設）
            </label>
            <div className="text-xs">
              {(parseInt(defaultSessionCapacity, 10) || 0) > layoutSeatCount ? (
                <span className="text-amber-700 font-bold flex items-center gap-1" data-testid="capacity-exceed-warning">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
                  <span>比座位多 {(parseInt(defaultSessionCapacity, 10) || 0) - layoutSeatCount} 個，可能會有人沒位子坐</span>
                </span>
              ) : (
                <span className="text-gray-500">
                  座位 {layoutSeatCount} 個，保留 {layoutSeatCount - (parseInt(defaultSessionCapacity, 10) || 0)} 個給現場
                </span>
              )}
            </div>
          </div>
          <div className="w-full sm:w-36">
            <input
              type="number"
              min="1"
              data-testid="default-session-capacity-input"
              value={defaultSessionCapacity}
              onChange={e => setDefaultSessionCapacity(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* 平日 */}
          <div className="bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8] space-y-3">
            <span className="block text-sm font-bold text-[#3E332B]">平日（週一至週五）</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">開始時間</label>
                <input
                  type="time"
                  data-testid="weekday-start-input"
                  value={businessHours.weekday.start}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    weekday: { ...prev.weekday, start: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">結束時間</label>
                <input
                  type="time"
                  data-testid="weekday-end-input"
                  value={businessHours.weekday.end}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    weekday: { ...prev.weekday, end: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
            </div>
          </div>

          {/* 週六 */}
          <div className="bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8] space-y-3">
            <span className="block text-sm font-bold text-[#3E332B]">週六</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">開始時間</label>
                <input
                  type="time"
                  data-testid="saturday-start-input"
                  value={businessHours.saturday.start}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    saturday: { ...prev.saturday, start: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">結束時間</label>
                <input
                  type="time"
                  data-testid="saturday-end-input"
                  value={businessHours.saturday.end}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    saturday: { ...prev.saturday, end: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
            </div>
          </div>

          {/* 週日 */}
          <div className="bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8] space-y-3">
            <span className="block text-sm font-bold text-[#3E332B]">週日</span>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">開始時間</label>
                <input
                  type="time"
                  data-testid="sunday-start-input"
                  value={businessHours.sunday.start}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    sunday: { ...prev.sunday, start: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">結束時間</label>
                <input
                  type="time"
                  data-testid="sunday-end-input"
                  value={businessHours.sunday.end}
                  onChange={e => setBusinessHours(prev => ({
                    ...prev,
                    sunday: { ...prev.sunday, end: e.target.value }
                  }))}
                  className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-sm font-bold text-[#8B5B43]"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 5: LINE 官方帳號推播 (Messaging API) 與自動通知 */}
      <div className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-[#06C755]" />
              5. LINE 官方帳號推播 (Messaging API) 設定
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              串接 LINE 官方帳號 Messaging API，啟用預約成功/取消自動推播憑證，以及後台向顧客發送提醒與自訂訊息
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${
                hasLineMessagingToken
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-amber-50 text-amber-700 border-amber-200'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  hasLineMessagingToken ? 'bg-[#06C755]' : 'bg-amber-500'
                }`}
              />
              {hasLineMessagingToken ? '已設定 Token' : '未設定 Token'}
            </span>
          </div>
        </div>

        <div className="space-y-5">
          {/* Channel Access Token Input */}
          <div className="bg-[#FAF7F2] p-5 rounded-2xl border border-[#E8DEC8] space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label className="text-sm font-bold text-[#3E332B] flex items-center gap-2">
                <Key className="w-4 h-4 text-[#8B5B43]" />
                Messaging API Channel Access Token (long-lived)
              </label>
              {hasLineMessagingToken && lineMessagingTokenMasked && (
                <span className="text-xs text-[#6D5D52] font-mono bg-white px-2.5 py-1 rounded-md border border-[#E8DEC8]">
                  目前儲存：{lineMessagingTokenMasked}
                </span>
              )}
            </div>
            <div>
              <input
                type="password"
                value={lineMessagingTokenInput}
                onChange={e => setLineMessagingTokenInput(e.target.value)}
                placeholder={
                  hasLineMessagingToken
                    ? `已設定長效 Token（${lineMessagingTokenMasked}）。若需更換請直接在此貼上新 Token`
                    : '請貼上 LINE Messaging API Channel access token (long-lived)'
                }
                className="w-full px-4 py-2.5 bg-white border border-[#E8DEC8] rounded-xl text-sm font-mono text-[#3E332B] placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-[#8B5B43]/30"
              />
            </div>
            <p className="text-[11px] text-[#6D5D52] leading-relaxed">
              <strong>如何取得 Token？</strong> 請前往{' '}
              <a
                href="https://developers.line.biz/console/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#8B5B43] font-bold underline hover:text-[#724a35]"
              >
                LINE Developers Console
              </a>{' '}
              → 進入您的 <strong>Messaging API Channel</strong> → 點選 <strong>Messaging API</strong> 分頁 → 拉至最下方 <strong>Channel access token (long-lived)</strong> 點擊 <strong>Issue</strong> 產生長效 Token。<br />
              請確保「LINE Login Channel」與「Messaging API Channel」位於同一個 <strong>Provider</strong> 底下，且 LINE Login 已綁定 Linked OA，推播即可 100% 精準送達。
            </p>
          </div>

          {/* Automated Notification Toggles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Toggle 1: Auto Booking Confirmation */}
            <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-bold text-[#3E332B] flex items-center gap-1.5">
                  <span>預約成立時自動發送 LINE 電子憑證通知給顧客</span>
                </div>
                <p className="text-xs text-[#6D5D52] leading-relaxed">
                  線上預約成立時，官方帳號自動發送《拾光製所》大地暖木色預約憑證 Flex 卡片（<strong>絕不透露任何座位號碼</strong>）。
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                <input
                  type="checkbox"
                  checked={lineAutoNotifyBooking}
                  onChange={e =>
                    handleQuickToggle('line_auto_notify_booking', e.target.checked, setLineAutoNotifyBooking)
                  }
                  className="sr-only peer"
                />
                <div className="w-12 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#06C755]"></div>
              </label>
            </div>

            {/* Toggle 2: Auto Booking Cancellation */}
            <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-bold text-[#3E332B] flex items-center gap-1.5">
                  <span>預約取消時自動發送 LINE 取消通知給顧客</span>
                </div>
                <p className="text-xs text-[#6D5D52] leading-relaxed">
                  顧客自行或管理員於後台取消預約時，自動推播預約已取消之 Flex 暖心關懷通知給顧客。
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                <input
                  type="checkbox"
                  checked={lineAutoNotifyCancel}
                  onChange={e =>
                    handleQuickToggle('line_auto_notify_cancel', e.target.checked, setLineAutoNotifyCancel)
                  }
                  className="sr-only peer"
                />
                <div className="w-12 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#06C755]"></div>
              </label>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => handleSaveAll()}
              disabled={saving}
              className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm shadow-xs transition-all disabled:opacity-50"
            >
              {saving ? '儲存中...' : '儲存 LINE 官方帳號推播設定'}
            </button>
          </div>
        </div>
      </div>

      {/* 6. Checkout & Timer Settings (Spec 6.25) */}
      <div className="bg-white rounded-3xl border border-gray-200 shadow-xs overflow-hidden">
        <div className="p-5 sm:p-6 bg-[#FAF7F2] border-b border-gray-200">
          <div className="flex items-center gap-2 text-[#8B5B43] font-bold text-base mb-1">
            <Clock className="w-5 h-5" />
            <h2>結帳與計時設定</h2>
          </div>
          <p className="text-xs text-gray-500">
            設定現場計時寬限期、超時加收單位、提早離開計費規則、分攤方式與收銀機預設零用金。
          </p>
        </div>

        <div className="p-5 sm:p-6 space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {/* Grace minutes */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">超時寬限（分鐘）</label>
              <input
                type="number"
                value={billingGraceMinutes}
                onChange={(e) => setBillingGraceMinutes(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
              />
              <span className="text-[11px] text-gray-400 mt-0.5 block">超過預約在此分鐘內不加收，預設 10 分</span>
            </div>

            {/* Block minutes */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">計費單位（分鐘）</label>
              <select
                value={billingBlockMinutes}
                onChange={(e) => setBillingBlockMinutes(parseInt(e.target.value, 10) || 30)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white"
              >
                <option value={15}>15 分鐘</option>
                <option value={30}>30 分鐘（預設）</option>
                <option value={60}>60 分鐘</option>
              </select>
              <span className="text-[11px] text-gray-400 mt-0.5 block">每達到此區間加收 0.5 小時</span>
            </div>

            {/* Board swap grace */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">換板寬限（分鐘）</label>
              <input
                type="number"
                value={boardSwapGraceMinutes}
                onChange={(e) => setBoardSwapGraceMinutes(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
              />
              <span className="text-[11px] text-gray-400 mt-0.5 block">10/30 換板時間取整寬限，預設 10 分</span>
            </div>

            {/* Early leave mode */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">提早離開計費</label>
              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="early_leave"
                    checked={earlyLeaveMode === 'booked'}
                    onChange={() => setEarlyLeaveMode('booked')}
                    className="text-[#8B5B43] focus:ring-[#8B5B43]"
                  />
                  <span>照預約時數收（預設）</span>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                  <input
                    type="radio"
                    name="early_leave"
                    checked={earlyLeaveMode === 'actual'}
                    onChange={() => setEarlyLeaveMode('actual')}
                    className="text-[#8B5B43] focus:ring-[#8B5B43]"
                  />
                  <span>照實際時數收（最少 1 小時）</span>
                </label>
              </div>
            </div>

            {/* Split mode */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">整單金額預設怎麼分</label>
              <select
                value={defaultSplitMode}
                onChange={(e) => setDefaultSplitMode(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white"
              >
                <option value="proportional">依金額比例（預設）</option>
                <option value="even">平均分攤</option>
                <option value="first">全算第 1 位</option>
              </select>
            </div>

            {/* Cash Float */}
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">收銀機起始零用金（元）</label>
              <input
                type="number"
                value={cashFloatAmount}
                onChange={(e) => setCashFloatAmount(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
              />
              <span className="text-[11px] text-gray-400 mt-0.5 block">每日交班基準零用金額，預設 NT$2,000</span>
            </div>
          </div>

          {/* Payment Methods Config (Round 16 Item 2) */}
          <div className="space-y-3 pt-4 border-t border-gray-200">
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-0.5">現場付款方式清單</label>
              <span className="text-[11px] text-gray-400 block">
                設定現場結帳時可使用的付款方式與顯示順序。每項一列，支援拖曳或上下箭頭排序。「現金」為必要付款方式無法停用。
              </span>
            </div>

            <div className="space-y-2 max-w-xl" data-testid="payment-methods-list">
              {paymentMethods.map((pm, idx) => {
                const isCash = pm.key === 'cash';
                return (
                  <div
                    key={pm.key}
                    draggable
                    onDragStart={() => setDraggedMethodIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (draggedMethodIdx === null || draggedMethodIdx === idx) return;
                      const items = [...paymentMethods];
                      const [moved] = items.splice(draggedMethodIdx, 1);
                      items.splice(idx, 0, moved);
                      setPaymentMethods(items);
                      setDraggedMethodIdx(null);
                    }}
                    data-testid={`payment-method-row-${pm.key}`}
                    className="flex items-center justify-between p-3 bg-[#FAF7F2] rounded-xl border border-[#E8DEC8] hover:border-[#8B5B43] transition gap-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="cursor-grab text-gray-400 hover:text-gray-600" title="拖曳排序">
                        <GripVertical className="w-4 h-4" />
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => {
                            if (idx > 0) {
                              const items = [...paymentMethods];
                              const tmp = items[idx - 1];
                              items[idx - 1] = items[idx];
                              items[idx] = tmp;
                              setPaymentMethods(items);
                            }
                          }}
                          className="p-1 text-gray-400 hover:text-[#8B5B43] disabled:opacity-30 disabled:hover:text-gray-400 transition"
                          title="往上移"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === paymentMethods.length - 1}
                          onClick={() => {
                            if (idx < paymentMethods.length - 1) {
                              const items = [...paymentMethods];
                              const tmp = items[idx + 1];
                              items[idx + 1] = items[idx];
                              items[idx] = tmp;
                              setPaymentMethods(items);
                            }
                          }}
                          className="p-1 text-gray-400 hover:text-[#8B5B43] disabled:opacity-30 disabled:hover:text-gray-400 transition"
                          title="往下移"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <span className="text-sm font-bold text-[#3E332B]">{pm.label}</span>
                      {isCash && (
                        <span className="text-[10px] bg-[#E8DEC8]/60 text-[#8B5B43] font-bold px-1.5 py-0.5 rounded">
                          固定開啟
                        </span>
                      )}
                    </div>

                    <label className={`relative inline-flex items-center ${isCash ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} shrink-0`}>
                      <input
                        type="checkbox"
                        checked={isCash ? true : Boolean(pm.enabled)}
                        disabled={isCash}
                        data-testid={`payment-method-toggle-${pm.key}`}
                        onChange={(e) => {
                          if (isCash) return;
                          const updated = [...paymentMethods];
                          updated[idx] = { ...updated[idx], enabled: e.target.checked };
                          setPaymentMethods(updated);
                        }}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                    </label>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              data-testid="save-billing-settings-btn"
              onClick={() => handleSaveAll()}
              disabled={saving}
              className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm shadow-xs transition-all disabled:opacity-50"
            >
              {saving ? '儲存中...' : '儲存結帳與計時設定'}
            </button>
          </div>
        </div>
      </div>

      {/* 7. Printing & Station Settings (Spec 6.25) */}
      <div className="bg-white rounded-3xl border border-gray-200 shadow-xs overflow-hidden">
        <div className="p-5 sm:p-6 bg-[#FAF7F2] border-b border-gray-200">
          <div className="flex items-center gap-2 text-[#8B5B43] font-bold text-base mb-1">
            <Printer className="w-5 h-5" />
            <h2>列印與商米列印站設定</h2>
          </div>
          <p className="text-xs text-gray-500">
            管理結帳自動出單行為、收據頁尾自訂文字與店內配對之商米列印站。
          </p>
        </div>

        <div className="p-5 sm:p-6 space-y-6">
          {/* 啟用列印總開關 */}
          <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-center justify-between">
            <div>
              <span className="text-sm font-bold text-[#3E332B] block">啟用列印</span>
              <span className="text-xs text-[#6D5D52]">關閉後，結帳不會出單，商米和這台裝置都不會列印</span>
            </div>
            <input
              type="checkbox"
              data-testid="toggle-print-enabled"
              checked={printEnabled}
              onChange={(e) => handleTogglePrintEnabled(e.target.checked)}
              className="w-5 h-5 rounded text-[#8B5B43] focus:ring-[#8B5B43] cursor-pointer"
            />
          </div>

          <div className={`space-y-6 transition-opacity ${!printEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-center justify-between">
                <div>
                  <span className="text-sm font-bold text-[#3E332B] block">完成結帳就列印</span>
                  <span className="text-xs text-[#6D5D52]">門市收款完成後自動派送收據列印工作</span>
                </div>
                <input
                  type="checkbox"
                  disabled={!printEnabled}
                  checked={autoPrintReceipt}
                  onChange={(e) => setAutoPrintReceipt(e.target.checked)}
                  className="w-5 h-5 rounded text-[#8B5B43] focus:ring-[#8B5B43]"
                />
              </div>

              <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-center justify-between">
                <div>
                  <span className="text-sm font-bold text-[#3E332B] block">整組結清時自動印整單總表</span>
                  <span className="text-xs text-[#6D5D52]">若分多人付款，結清時自動多印一張總表</span>
                </div>
                <input
                  type="checkbox"
                  disabled={!printEnabled}
                  checked={autoPrintSummary}
                  onChange={(e) => setAutoPrintSummary(e.target.checked)}
                  className="w-5 h-5 rounded text-[#8B5B43] focus:ring-[#8B5B43]"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">收據底部文字</label>
              <input
                type="text"
                disabled={!printEnabled}
                value={receiptFooterText}
                onChange={(e) => setReceiptFooterText(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm disabled:bg-gray-100"
                placeholder="預設：謝謝光臨，作品記得帶回家"
              />
            </div>

          {/* Station list */}
          <div className="space-y-3 pt-2 border-t border-gray-200">
            <span className="text-xs font-bold text-gray-700 block">已配對的商米列印站</span>
            {printStations.length === 0 ? (
              <div className="p-4 rounded-2xl bg-gray-50 text-center text-xs text-gray-400">
                目前尚未配對任何商米列印站
              </div>
            ) : (
              <div className="space-y-3">
                {printStations.map((st) => {
                  const isOnline = Boolean(st.last_seen_at && (Date.now() - new Date(st.last_seen_at).getTime() <= 75000));
                  const lastSeen = st.last_seen_at
                    ? new Date(st.last_seen_at).toLocaleTimeString('zh-TW', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                        timeZone: 'Asia/Taipei'
                      })
                    : '從未';
                  const isAccepting = st.accepting !== false;

                  return (
                    <div
                      key={st.id}
                      data-testid={`station-card-${st.id}`}
                      className="p-4 rounded-2xl border border-gray-200 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                    >
                      <div className="space-y-1">
                        <div className="text-sm font-bold text-gray-800 flex items-center gap-2 flex-wrap">
                          <Printer className="w-4 h-4 text-[#8B5B43]" />
                          <span>{st.name} · {isOnline ? '在線' : '離線'} · 最後回報 {lastSeen}</span>
                          {st.is_default && (
                            <span className="text-[10px] bg-[#FAF7F2] text-[#8B5B43] font-bold px-1.5 py-0.5 rounded border border-[#E8DEC8]">
                              預設
                            </span>
                          )}
                          {!isAccepting && (
                            <span className="text-[10px] bg-amber-50 text-amber-700 font-bold px-1.5 py-0.5 rounded border border-amber-200">
                              暫停接單中
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 flex-wrap shrink-0">
                        <button
                          type="button"
                          onClick={() => handleRenameStation(st)}
                          className="px-2.5 py-1 text-xs font-bold text-[#8B5B43] bg-[#FAF7F2] hover:bg-[#E8DEC8]/50 border border-[#E8DEC8] rounded-lg transition"
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          disabled={!printEnabled}
                          onClick={() => handleToggleStationAccepting(st)}
                          className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition ${
                            isAccepting
                              ? 'text-gray-700 bg-white hover:bg-gray-50 border-gray-200'
                              : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'
                          }`}
                        >
                          {isAccepting ? '暫停接單' : '恢復接單'}
                        </button>
                        {printEnabled && (
                          <button
                            type="button"
                            onClick={() => handleTestStationPrint(st)}
                            className="px-2.5 py-1 text-xs font-bold text-gray-700 bg-white hover:bg-gray-50 border border-gray-200 rounded-lg transition"
                          >
                            測試列印
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={!printEnabled}
                          onClick={() => setUnpairingStation(st)}
                          className="px-2.5 py-1 text-xs font-bold text-red-600 hover:text-red-700 hover:underline transition"
                        >
                          解除配對
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-xs text-[#8B5B43] bg-[#FAF7F2] p-3 rounded-2xl border border-[#E8DEC8]">
              設定新的列印站：在商米上打開拾光 App，登入後台，進入「列印站」頁面，按「把這台設為列印站」。
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={() => handleSaveAll()}
              disabled={saving}
              className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl text-xs sm:text-sm shadow-xs transition-all disabled:opacity-50"
            >
              {saving ? '儲存中...' : '儲存列印設定'}
            </button>
          </div>
          </div>
        </div>
      </div>

      {confirmDisablePrint && (
        <ConfirmPanel
          isOpen={Boolean(confirmDisablePrint)}
          title="關閉啟用列印"
          message={`目前有 ${confirmDisablePrint.count} 張單還沒印，要一起取消嗎？`}
          confirmText="確認"
          cancelText="先不要"
          danger={true}
          onClose={() => setConfirmDisablePrint(null)}
          onConfirm={async () => {
            setConfirmDisablePrint(null);
            setPrintEnabled(false);
            setPrintGloballyEnabled(false);
            await handleSaveAll({ print_enabled: false, cancel_pending_jobs: true });
          }}
        />
      )}

      {unpairingStation && (
        <ConfirmPanel
          open={!!unpairingStation}
          title="解除配對列印站"
          message={`確定要解除配對「${unpairingStation.name}」嗎？解除後該列印站將停止背景接單服務。`}
          confirmText="確認解除配對"
          confirmVariant="danger"
          onCancel={() => setUnpairingStation(null)}
          onConfirm={async () => {
            try {
              await api.post(`/print/stations/${unpairingStation.id}/unpair`);
              setUnpairingStation(null);
              fetchGlobalSettings();
            } catch (err) {
              setToastMsg('解除配對失敗');
            }
          }}
        />
      )}

      {renamingStation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full space-y-4 shadow-xl animate-fade-in">
            <h3 className="text-base font-bold text-gray-900">修改列印站名稱</h3>
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:border-[#8B5B43] focus:outline-none"
              placeholder="例如：櫃檯商米主機"
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setRenamingStation(null)}
                className="px-4 py-2 text-xs font-bold text-gray-500 hover:text-gray-700"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveRename}
                className="px-4 py-2 text-xs font-bold text-white bg-[#8B5B43] hover:bg-[#724a35] rounded-xl"
              >
                儲存名稱
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

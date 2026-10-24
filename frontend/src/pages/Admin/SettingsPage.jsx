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
  Key
} from 'lucide-react';
import api from '../../api/axios';

const DEFAULT_PREVIEW_DISABLED_TEXT = '系統維護中，請點擊下方按鈕使用 LINE 進行預約';
const DEFAULT_ANNOUNCEMENT_TEXT = '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠';
const DEFAULT_PRICE_NOTICE_TEXT = '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品';
const DEFAULT_LINE_URL = 'https://lin.ee/vsZhRW5';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

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
  const [lineButtonUrl, setLineButtonUrl] = useState(DEFAULT_LINE_URL);

  // 3. Global Store Default Prices
  const [weekdayHourly, setWeekdayHourly] = useState(100);
  const [weekdayUnlimited, setWeekdayUnlimited] = useState(550);
  const [weekendHourly, setWeekendHourly] = useState(150);
  const [weekendUnlimited, setWeekendUnlimited] = useState(800);

  // 4. Smart Board Global Rules
  const [allowEquipmentExceedPax, setAllowEquipmentExceedPax] = useState(false);
  const [showEquipmentLiveStock, setShowEquipmentLiveStock] = useState(true);
  const [equipmentDiscountEnabled, setEquipmentDiscountEnabled] = useState(true);
  const [equipmentDiscountBuyHours, setEquipmentDiscountBuyHours] = useState(3);
  const [equipmentDiscountFreeHours, setEquipmentDiscountFreeHours] = useState(1);
  const [equipmentDiscount2Enabled, setEquipmentDiscount2Enabled] = useState(false);
  const [equipmentDiscount2BuyHours, setEquipmentDiscount2BuyHours] = useState(8);
  const [equipmentDiscount2FreeHours, setEquipmentDiscount2FreeHours] = useState(4);

  // 5. LINE Messaging API & Push Notifications
  const [hasLineMessagingToken, setHasLineMessagingToken] = useState(false);
  const [lineMessagingTokenMasked, setLineMessagingTokenMasked] = useState('');
  const [lineMessagingTokenInput, setLineMessagingTokenInput] = useState('');
  const [lineAutoNotifyBooking, setLineAutoNotifyBooking] = useState(false);
  const [lineAutoNotifyCancel, setLineAutoNotifyCancel] = useState(false);

  useEffect(() => {
    fetchGlobalSettings();
  }, []);

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3000);
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
      setLineButtonUrl(d.line_button_url || DEFAULT_LINE_URL);

      setWeekdayHourly(d.weekday_hourly_price ?? 100);
      setWeekdayUnlimited(d.weekday_unlimited_price ?? 550);
      setWeekendHourly(d.weekend_hourly_price ?? 150);
      setWeekendUnlimited(d.weekend_unlimited_price ?? 800);

      setAllowEquipmentExceedPax(!!d.allow_equipment_exceed_pax);
      setShowEquipmentLiveStock(d.show_equipment_live_stock !== false);
      setEquipmentDiscountEnabled(d.equipment_discount_enabled !== false);
      setEquipmentDiscountBuyHours(d.equipment_discount_buy_hours ?? 3);
      setEquipmentDiscountFreeHours(d.equipment_discount_free_hours ?? 1);
      setEquipmentDiscount2Enabled(!!d.equipment_discount2_enabled);
      setEquipmentDiscount2BuyHours(d.equipment_discount2_buy_hours ?? 8);
      setEquipmentDiscount2FreeHours(d.equipment_discount2_free_hours ?? 4);

      setHasLineMessagingToken(!!d.has_line_messaging_token);
      setLineMessagingTokenMasked(d.line_messaging_token_masked || '');
      setLineAutoNotifyBooking(!!d.line_auto_notify_booking);
      setLineAutoNotifyCancel(!!d.line_auto_notify_cancel);
      setLineMessagingTokenInput('');
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
        line_button_url: lineButtonUrl,
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
        line_auto_notify_booking: lineAutoNotifyBooking,
        line_auto_notify_cancel: lineAutoNotifyCancel,
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

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-4 border-[#E8DEC8] border-t-[#8B5B43] rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-8 animate-fade-in">
      {/* Toast Notification */}
      {toastMsg && (
        <div className="fixed top-6 right-6 z-50 bg-emerald-700 text-white px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-sm font-bold">
          <Check className="w-4 h-4" />
          <span>{toastMsg}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-200 pb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="p-2.5 rounded-2xl bg-[#F4EFE6] text-[#8B5B43]">
              <Settings className="w-6 h-6" />
            </span>
            <h1 className="text-2xl font-bold text-[#2C241E]">
              系統全域設定中心
            </h1>
          </div>
          <p className="text-sm text-gray-500">
            集中管理 LINE 每次登入驗證開關、空位預覽網頁開關與維護公告、顧客端首頁顯示區塊、全店預設收費與智能板優惠規則。
          </p>
        </div>

        <button
          type="button"
          onClick={() => handleSaveAll()}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#724a35] text-white px-6 py-2.5 rounded-xl font-bold text-sm shadow-sm transition-all disabled:opacity-50 shrink-0"
        >
          {saving ? '儲存設定中...' : '💾 儲存全部系統設定'}
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
                ? '🔒 目前狀態：【強制每次 LINE 登入】顧客每次打開網頁皆不使用舊有登入紀錄，須透過 LINE 重新登入'
                : '🟢 目前狀態：【一般便利模式】顧客登入後保留 7 天登入紀錄，期間再次開啟可直接進入預約頁面'}
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
                    ? '🟢 目前狀態：公開空位預覽功能【開放中】'
                    : '🟠 目前狀態：公開空位預覽【已關閉】，僅顯示上方提示並引導點擊下方按鈕登入 LINE'}
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
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
              {showAnnouncement ? '🟢 目前狀態：顧客端顯示頂部系統公告欄' : '⚪ 目前狀態：顧客端隱藏公告欄'}
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
              {showPriceCards ? '🟢 目前狀態：顧客端顯示平假日價格說明卡' : '⚪ 目前狀態：顧客端隱藏價格說明卡'}
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
                  控制預約頁頂部「💬 官方 LINE」按鈕顯示，以及空位預覽頁下方綠色按鈕跳轉網址
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
            <div className="pt-3 border-t border-[#E8DEC8]">
              <label className="block text-xs font-semibold text-[#3E332B] mb-1.5">官方 LINE 連結網址</label>
              <input
                type="url"
                value={lineButtonUrl}
                onChange={e => setLineButtonUrl(e.target.value)}
                placeholder="https://lin.ee/..."
                className="w-full px-3 py-2 text-xs bg-white border border-[#E8DEC8] rounded-xl focus:border-[#8B5B43] focus:outline-none"
              />
            </div>
            <div className="text-[11px] text-[#6D5D52] bg-white p-2 rounded-lg border border-[#E8DEC8]">
              {showLineButton ? '🟢 目前狀態：顧客端頂部顯示官方 LINE 按鈕' : '⚪ 目前狀態：顧客端頂部隱藏官方 LINE 按鈕'}
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

      {/* SECTION 5: LINE 官方帳號推播 (Messaging API) 與自動通知 */}
      <div className="bg-white rounded-2xl shadow-sm border border-[#E8DEC8] p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-[#3E332B] flex items-center gap-2">
              <MessageCircle className="w-5 h-5 text-[#06C755]" />
              5. 💬 LINE 官方帳號推播 (Messaging API) 設定
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
              💡 <strong>如何取得 Token？</strong> 請前往{' '}
              <a
                href="https://developers.line.biz/console/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#8B5B43] font-bold underline hover:text-[#724a35]"
              >
                LINE Developers Console
              </a>{' '}
              ➔ 進入您的 <strong>Messaging API Channel</strong> ➔ 點選 <strong>Messaging API</strong> 分頁 ➔ 拉至最下方 <strong>Channel access token (long-lived)</strong> 點擊 <strong>Issue</strong> 產生長效 Token。<br />
              ⚠️ 請確保「LINE Login Channel」與「Messaging API Channel」位於同一個 <strong>Provider</strong> 底下，且 LINE Login 已綁定 Linked OA，推播即可 100% 精準送達。
            </p>
          </div>

          {/* Automated Notification Toggles */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Toggle 1: Auto Booking Confirmation */}
            <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="text-sm font-bold text-[#3E332B] flex items-center gap-1.5">
                  <span>🎟️ 預約成立時自動發送 LINE 電子憑證通知給顧客</span>
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
                  <span>❌ 預約取消時自動發送 LINE 取消通知給顧客</span>
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
              {saving ? '儲存中...' : '💾 儲存 LINE 官方帳號推播設定'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

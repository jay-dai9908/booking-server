import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  Eye,
  EyeOff,
  Save,
  KeyRound,
  MessageCircle,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Image as ImageIcon,
  Upload,
  ArrowUp,
  ArrowDown,
  Trash2,
  Cpu,
  Bell,
  CheckSquare,
  Square
} from 'lucide-react';
import api from '../../api/axios';
import { toTaipeiDateString } from '@shared/time.js';
import { rgbaToRgb565, rgb565ToRgba, SLIDE_WIDTH, SLIDE_HEIGHT } from '../../utils/admin/rgb565';

const METHOD_LABELS = {
  qr: '條碼',
  phone: '電話',
  backup_code: '備用密碼',
  keypad: '鍵盤'
};

const RESULT_LABELS = {
  FIRST_CHECKIN: '報到成功',
  RE_ENTRY: '再次進門',
  TOO_EARLY: '還沒開放',
  UNVERIFIED: '款項核對中',
  QR_EXPIRED: '條碼過期',
  NOT_FOUND: '查無預約',
  ENDED: '已結束',
  NORMAL_DAY: '一般營業日',
  BACKUP_OPEN: '備用密碼開門',
  PAD_LOCKED: '鍵盤連續輸錯，已鎖定'
};

const RESULT_STYLES = {
  FIRST_CHECKIN: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RE_ENTRY: 'bg-sky-50 text-sky-700 border-sky-200',
  BACKUP_OPEN: 'bg-amber-50 text-amber-800 border-amber-200',
  TOO_EARLY: 'bg-stone-100 text-stone-700 border-stone-200',
  UNVERIFIED: 'bg-orange-50 text-orange-700 border-orange-200',
  QR_EXPIRED: 'bg-rose-50 text-rose-700 border-rose-200',
  NOT_FOUND: 'bg-stone-100 text-stone-600 border-stone-200',
  ENDED: 'bg-stone-100 text-stone-600 border-stone-200',
  NORMAL_DAY: 'bg-stone-100 text-stone-600 border-stone-200',
  PAD_LOCKED: 'bg-rose-50 text-rose-700 border-rose-200'
};

const MODE_LABELS = {
  self: '半自助日',
  normal: '一般營業日',
  closed: '今日公休'
};

function formatSignal(rssi) {
  if (rssi === null || rssi === undefined || Number.isNaN(Number(rssi))) return '未知';
  const val = Number(rssi);
  if (val >= -65) return `良好 (${val} dBm)`;
  if (val >= -78) return `普通 (${val} dBm)`;
  return `弱 (${val} dBm)`;
}

function formatUptime(uptimeSec) {
  if (uptimeSec === null || uptimeSec === undefined || Number.isNaN(Number(uptimeSec))) return '—';
  const totalSec = Math.max(0, Math.floor(Number(uptimeSec)));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小時`;
  if (hours > 0) return `${hours} 小時 ${mins} 分`;
  return `${mins} 分鐘`;
}

function formatTaipeiDateTime(iso, withDate = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return withDate ? `${map.month}/${map.day} ${map.hour}:${map.minute}` : `${map.hour}:${map.minute}`;
}

function formatRelativeSync(iso) {
  if (!iso) return '從未同步';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const mins = Math.floor(sec / 60);
  if (mins < 60) return `${mins} 分鐘前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小時前`;
  return formatTaipeiDateTime(iso, true);
}

export default function KioskPage() {
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [logDate, setLogDate] = useState(() => toTaipeiDateString(new Date()));
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const [rulesForm, setRulesForm] = useState({
    early_minutes: 30,
    after_close_minutes: 60,
    prepay_deadline_hour: 12,
    max_unpaid_self_bookings: 2
  });
  const [savingRules, setSavingRules] = useState(false);

  const [contactForm, setContactForm] = useState({ line_url: '', line_id: '' });
  const [savingContact, setSavingContact] = useState(false);

  const [newBackupCode, setNewBackupCode] = useState('');
  const [backupCodeErr, setBackupCodeErr] = useState('');
  const [savingBackupCode, setSavingBackupCode] = useState(false);
  const [revealedCode, setRevealedCode] = useState(null);
  const [revealingCode, setRevealingCode] = useState(false);

  const [newSetupPin, setNewSetupPin] = useState('');
  const [setupPinErr, setSetupPinErr] = useState('');
  const [savingSetupPin, setSavingSetupPin] = useState(false);

  // 待機輪播圖（Item 3）
  const [slides, setSlides] = useState([]);
  const [loadingSlides, setLoadingSlides] = useState(false);
  const [slideTitle, setSlideTitle] = useState('');
  const [slideDuration, setSlideDuration] = useState(8);
  const [slideCropMode, setSlideCropMode] = useState('cover');
  const [slidePreviewDataUrl, setSlidePreviewDataUrl] = useState('');
  const [slideImageData, setSlideImageData] = useState(null);
  const [uploadingSlide, setUploadingSlide] = useState(false);
  const [slideError, setSlideError] = useState('');

  const [notice, setNotice] = useState(null);

  const showNotice = (type, text) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 4000);
  };

  const fetchOverview = useCallback(async () => {
    try {
      const res = await api.get('/kiosk/admin/overview');
      const data = res.data;
      setOverview(data);
      if (data?.settings) {
        setRulesForm({
          early_minutes: data.settings.early_minutes ?? 30,
          after_close_minutes: data.settings.after_close_minutes ?? 60,
          prepay_deadline_hour: data.settings.prepay_deadline_hour ?? 12,
          max_unpaid_self_bookings: data.settings.max_unpaid_self_bookings ?? 2
        });
        setContactForm({
          line_url: data.settings.line_url || '',
          line_id: data.settings.line_id || ''
        });
      }
    } catch (err) {
      showNotice('error', err.response?.data?.error || '載入報到機總覽失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async (dateStr) => {
    setLogsLoading(true);
    try {
      const res = await api.get('/kiosk/admin/access-logs', { params: { date: dateStr } });
      setLogs(Array.isArray(res.data?.logs) ? res.data.logs : []);
    } catch (err) {
      showNotice('error', err.response?.data?.error || '載入進出紀錄失敗');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const fetchSlides = useCallback(async () => {
    setLoadingSlides(true);
    try {
      const res = await api.get('/kiosk/admin/slides');
      setSlides(Array.isArray(res.data?.slides) ? res.data.slides : []);
    } catch (err) {
      console.warn('Failed to load slides:', err);
    } finally {
      setLoadingSlides(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    fetchSlides();
  }, [fetchOverview, fetchSlides]);

  useEffect(() => {
    fetchLogs(logDate);
  }, [logDate, fetchLogs]);

  // 處理圖片選擇與裁切預覽（Cover / Contain 轉 800x480）
  const processImageFile = (file, mode = slideCropMode) => {
    if (!file) return;
    setSlideError('');
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = SLIDE_WIDTH;
        canvas.height = SLIDE_HEIGHT;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);

        const imgRatio = img.width / img.height;
        const targetRatio = SLIDE_WIDTH / SLIDE_HEIGHT; // 800 / 480 = 1.6667

        let drawW, drawH, drawX, drawY;

        if (mode === 'cover') {
          if (imgRatio > targetRatio) {
            drawH = SLIDE_HEIGHT;
            drawW = SLIDE_HEIGHT * imgRatio;
            drawX = (SLIDE_WIDTH - drawW) / 2;
            drawY = 0;
          } else {
            drawW = SLIDE_WIDTH;
            drawH = SLIDE_WIDTH / imgRatio;
            drawX = 0;
            drawY = (SLIDE_HEIGHT - drawH) / 2;
          }
        } else {
          // contain: 保持比例留黑邊
          if (imgRatio > targetRatio) {
            drawW = SLIDE_WIDTH;
            drawH = SLIDE_WIDTH / imgRatio;
            drawX = 0;
            drawY = (SLIDE_HEIGHT - drawH) / 2;
          } else {
            drawH = SLIDE_HEIGHT;
            drawW = SLIDE_HEIGHT * imgRatio;
            drawX = (SLIDE_WIDTH - drawW) / 2;
            drawY = 0;
          }
        }

        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        const imgData = ctx.getImageData(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
        setSlideImageData(imgData);
        setSlidePreviewDataUrl(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };

  const handleUploadSlide = async () => {
    if (!slideImageData) {
      setSlideError('請先選取圖片');
      return;
    }
    setUploadingSlide(true);
    setSlideError('');
    try {
      const rgb565Bytes = rgbaToRgb565(slideImageData, { dither: true });
      let binaryStr = '';
      const len = rgb565Bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        const chunk = rgb565Bytes.subarray(i, Math.min(i + 8192, len));
        binaryStr += String.fromCharCode.apply(null, chunk);
      }
      const b64 = btoa(binaryStr);

      await api.post('/kiosk/admin/slides', {
        title: slideTitle || '輪播圖片',
        duration_sec: Number(slideDuration) || 8,
        raw_base64: b64,
        enabled: true
      });

      showNotice('success', '待機輪播圖片上傳成功');
      setSlidePreviewDataUrl('');
      setSlideImageData(null);
      setSlideTitle('');
      fetchSlides();
    } catch (err) {
      setSlideError(err.response?.data?.message || err.response?.data?.error || '上傳輪播圖失敗');
    } finally {
      setUploadingSlide(false);
    }
  };

  const handleToggleSlide = async (slide) => {
    try {
      await api.patch(`/kiosk/admin/slides/${slide.id}`, { enabled: !slide.enabled });
      fetchSlides();
    } catch (err) {
      showNotice('error', err.response?.data?.message || '更新狀態失敗');
    }
  };

  const handleMoveSlide = async (index, dir) => {
    const targetIdx = index + dir;
    if (targetIdx < 0 || targetIdx >= slides.length) return;
    const newSlides = [...slides];
    const temp = newSlides[index];
    newSlides[index] = newSlides[targetIdx];
    newSlides[targetIdx] = temp;

    const orders = newSlides.map((s, idx) => ({ id: s.id, sort_order: idx }));
    try {
      await api.put('/kiosk/admin/slides/order', { orders });
      fetchSlides();
    } catch (err) {
      showNotice('error', '重排順序失敗');
    }
  };

  const handleDeleteSlide = async (slideId) => {
    if (!window.confirm('確定要刪除這張待機輪播圖片嗎？')) return;
    try {
      await api.delete(`/kiosk/admin/slides/${slideId}`);
      showNotice('success', '已刪除輪播圖');
      fetchSlides();
    } catch (err) {
      showNotice('error', '刪除失敗');
    }
  };

  const handleSaveRules = async (e) => {
    e.preventDefault();
    setSavingRules(true);
    try {
      await api.put('/kiosk/settings', {
        early_minutes: Number(rulesForm.early_minutes),
        after_close_minutes: Number(rulesForm.after_close_minutes),
        prepay_deadline_hour: Number(rulesForm.prepay_deadline_hour),
        max_unpaid_self_bookings: Number(rulesForm.max_unpaid_self_bookings)
      });
      showNotice('success', '進場規則已儲存，報到機會在 3 分鐘內同步');
      fetchOverview();
    } catch (err) {
      showNotice('error', err.response?.data?.error || '儲存進場規則失敗');
    } finally {
      setSavingRules(false);
    }
  };

  const handleSaveContact = async (e) => {
    e.preventDefault();
    setSavingContact(true);
    try {
      await api.put('/kiosk/settings', {
        line_url: contactForm.line_url,
        line_id: contactForm.line_id
      });
      showNotice('success', '客服資訊已儲存，報到機會在 3 分鐘內同步');
      fetchOverview();
    } catch (err) {
      showNotice('error', err.response?.data?.error || '儲存客服資訊失敗');
    } finally {
      setSavingContact(false);
    }
  };

  const handleToggleRevealCode = async () => {
    if (revealedCode !== null) {
      setRevealedCode(null);
      return;
    }
    setRevealingCode(true);
    try {
      const res = await api.get('/kiosk/admin/backup-code');
      setRevealedCode(res.data?.code || '（尚未設定）');
    } catch (err) {
      showNotice('error', err.response?.data?.error || '讀取備用密碼失敗');
    } finally {
      setRevealingCode(false);
    }
  };

  const handleChangeBackupCode = async (e) => {
    e.preventDefault();
    const clean = newBackupCode.trim();
    if (!/^\d{10}$/.test(clean)) {
      setBackupCodeErr('必須為 10 碼純數字');
      return;
    }
    if (clean.startsWith('09')) {
      setBackupCodeErr('不能以 09 開頭，以免與電話號碼混淆');
      return;
    }
    setBackupCodeErr('');
    setSavingBackupCode(true);
    try {
      await api.put('/kiosk/admin/backup-code', { code: clean });
      setNewBackupCode('');
      setRevealedCode(null);
      showNotice('success', '新備用密碼已儲存，等待報到機同步');
      fetchOverview();
    } catch (err) {
      const msg = err.response?.data?.error || '更換備用密碼失敗';
      setBackupCodeErr(msg);
    } finally {
      setSavingBackupCode(false);
    }
  };

  const handleChangeSetupPin = async (e) => {
    e.preventDefault();
    const clean = newSetupPin.trim();
    if (!/^\d{6}$/.test(clean)) {
      setSetupPinErr('設定模式密碼必須為 6 碼數字');
      return;
    }
    setSetupPinErr('');
    setSavingSetupPin(true);
    try {
      await api.put('/kiosk/admin/setup-pin', { pin: clean });
      setNewSetupPin('');
      showNotice('success', '設定模式密碼已儲存');
      fetchOverview();
    } catch (err) {
      setSetupPinErr(err.response?.data?.error || '儲存設定模式密碼失敗');
    } finally {
      setSavingSetupPin(false);
    }
  };

  const devices = overview?.devices || [];
  const primaryDevice = devices.find((d) => d.is_active) || devices[0] || null;
  const backupStatus = overview?.backup_code_status;
  const todayMode = overview?.today_mode;

  const pairOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3001';

  return (
    <div className="space-y-5 max-w-full overflow-x-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-stone-800 flex items-center gap-2">
            <MonitorSmartphone className="w-6 h-6 text-sg-brown" />
            門口報到機
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            查看門口報到機連線狀態、管理進場規則、備用開門密碼與進出紀錄
          </p>
        </div>
        <button
          type="button"
          onClick={() => { fetchOverview(); fetchLogs(logDate); }}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-50 text-sm font-medium text-stone-700"
        >
          <RefreshCw className="w-4 h-4" />
          重新整理
        </button>
      </div>

      {notice && (
        <div
          className={`px-4 py-3 rounded-xl border text-sm font-medium flex items-center gap-2 ${
            notice.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {notice.type === 'error' ? <AlertTriangle className="w-4 h-4 shrink-0" /> : <CheckCircle2 className="w-4 h-4 shrink-0" />}
          <span>{notice.text}</span>
        </div>
      )}

      {loading ? (
        <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-stone-500">
          載入報到機資料中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. 門口報到機狀態 */}
          <section className="bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-stone-800">門口報到機</h2>
              {primaryDevice ? (
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                    primaryDevice.online
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-stone-100 text-stone-600 border-stone-300'
                  }`}
                >
                  {primaryDevice.online ? '上線' : '離線'}
                </span>
              ) : (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                  尚未配對
                </span>
              )}
            </div>

            {!primaryDevice ? (
              <div className="space-y-2 text-sm text-stone-600 bg-stone-50 border border-stone-200 rounded-lg p-3.5">
                <p className="font-semibold text-stone-800">尚未配對任何報到機，請依以下步驟完成配對：</p>
                <ol className="list-decimal list-inside space-y-1 text-xs leading-relaxed">
                  <li>
                    在伺服器終端機執行：
                    <code className="block mt-1 p-2 rounded bg-stone-900 text-stone-100 font-mono text-[11px] break-all">
                      {`node backend/scripts/kiosk-pair.mjs --name "門口報到機" --url ${pairOrigin}`}
                    </code>
                  </li>
                  <li>報到機進入設定模式後，掃描終端機顯示的配對 QR 條碼即完成加密配對。</li>
                </ol>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-sm">
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">上次同步</div>
                    <div className="font-semibold text-stone-800 mt-0.5">{formatRelativeSync(primaryDevice.last_seen_at)}</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">韌體版本</div>
                    <div className="font-semibold text-stone-800 mt-0.5 font-mono text-xs">{primaryDevice.fw_version || '—'}</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">Wi-Fi 訊號</div>
                    <div className="font-semibold text-stone-800 mt-0.5">{formatSignal(primaryDevice.rssi)}</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">已開機</div>
                    <div className="font-semibold text-stone-800 mt-0.5">{formatUptime(primaryDevice.uptime_s)}</div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">掃碼頭</div>
                    <div className="font-semibold text-stone-800 mt-0.5">
                      {primaryDevice.scanner_ok === true ? '正常' : primaryDevice.scanner_ok === false ? '異常' : '未知'}
                    </div>
                  </div>
                  <div className="bg-stone-50 rounded-lg p-2.5 border border-stone-100">
                    <div className="text-xs text-stone-500">今日模式</div>
                    <div className="font-semibold text-stone-800 mt-0.5">{MODE_LABELS[todayMode?.mode] || '—'}</div>
                  </div>
                </div>
                {primaryDevice.reset_reason && (
                  <p className="text-xs text-stone-500">
                    裝置：{primaryDevice.name} · 上次重開機原因：<span className="font-mono">{primaryDevice.reset_reason}</span>
                  </p>
                )}
              </>
            )}
          </section>

          {/* 2. 進場規則（與營業時段設定頁共用同一份資料） */}
          <section className="bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-sg-brown" />
              <h2 className="text-base font-bold text-stone-800">進場規則</h2>
            </div>
            <form onSubmit={handleSaveRules} className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>最早提前</span>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={rulesForm.early_minutes}
                  onChange={(e) => setRulesForm((f) => ({ ...f, early_minutes: e.target.value }))}
                  className="w-20 px-2.5 py-1.5 border border-stone-300 rounded-lg text-center font-mono"
                />
                <span>分鐘進場</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span>打烊後</span>
                <input
                  type="number"
                  min={0}
                  max={240}
                  value={rulesForm.after_close_minutes}
                  onChange={(e) => setRulesForm((f) => ({ ...f, after_close_minutes: e.target.value }))}
                  className="w-20 px-2.5 py-1.5 border border-stone-300 rounded-lg text-center font-mono"
                />
                <span>分鐘內仍可進門</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span>付款期限：前一日</span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={rulesForm.prepay_deadline_hour}
                  onChange={(e) => setRulesForm((f) => ({ ...f, prepay_deadline_hour: e.target.value }))}
                  className="w-20 px-2.5 py-1.5 border border-stone-300 rounded-lg text-center font-mono"
                />
                <span>:00</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span>同一位會員最多同時</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={rulesForm.max_unpaid_self_bookings}
                  onChange={(e) => setRulesForm((f) => ({ ...f, max_unpaid_self_bookings: e.target.value }))}
                  className="w-20 px-2.5 py-1.5 border border-stone-300 rounded-lg text-center font-mono"
                />
                <span>筆待付款的預約</span>
              </div>
              <div className="pt-1">
                <button
                  type="submit"
                  disabled={savingRules}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sg-brown text-white text-sm font-medium hover:opacity-95 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {savingRules ? '儲存中...' : '儲存'}
                </button>
              </div>
            </form>
          </section>

          {/* 3. 備用開門密碼 */}
          <section className="bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-sg-brown" />
                備用開門密碼
              </h2>
              {backupStatus?.is_set && (
                <button
                  type="button"
                  onClick={handleToggleRevealCode}
                  disabled={revealingCode}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-stone-300 text-xs font-medium text-stone-700 hover:bg-stone-50"
                >
                  {revealedCode !== null ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  {revealedCode !== null ? '隱藏' : '顯示'}
                </button>
              )}
            </div>

            {backupStatus?.is_set && (
              <div className="text-sm font-mono tracking-wider px-3 py-2 rounded-lg bg-stone-50 border border-stone-200 text-stone-800">
                目前密碼：{revealedCode !== null ? revealedCode : '••••••••••'}
              </div>
            )}

            {!backupStatus?.is_set ? (
              overview?.has_self_service_in_7_days ? (
                <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm font-medium">
                  還沒設定備用開門密碼（未來 7 天內有半自助日，請盡快設定）
                </div>
              ) : (
                <div className="px-3 py-2 rounded-lg bg-stone-50 border border-stone-200 text-stone-600 text-sm">
                  尚未設定備用開門密碼
                </div>
              )
            ) : backupStatus.used_count_since_set > 0 ? (
              <div className="px-3 py-2 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 text-sm font-semibold">
                {formatTaipeiDateTime(backupStatus.last_used_at, true)} 用過 {backupStatus.used_count_since_set} 次，請換一組新的
              </div>
            ) : backupStatus.synced ? (
              <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium">
                報到機已在 {formatTaipeiDateTime(backupStatus.synced_at, false)} 同步新密碼，還沒被使用過
              </div>
            ) : (
              <div className="px-3 py-2 rounded-lg bg-sky-50 border border-sky-200 text-sky-800 text-sm font-medium">
                新密碼已儲存，等報到機同步（3 分鐘內）
              </div>
            )}

            <form onSubmit={handleChangeBackupCode} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={10}
                  value={newBackupCode}
                  onChange={(e) => { setNewBackupCode(e.target.value); setBackupCodeErr(''); }}
                  placeholder="輸入 10 碼數字（不能 09 開頭）"
                  className="flex-1 min-w-[200px] px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono"
                />
                <button
                  type="submit"
                  disabled={savingBackupCode}
                  className="px-4 py-2 rounded-lg bg-sg-brown text-white text-sm font-medium hover:opacity-95 disabled:opacity-50"
                >
                  {savingBackupCode ? '更換中...' : '更換'}
                </button>
              </div>
              {backupCodeErr && <p className="text-xs text-rose-600 font-medium">{backupCodeErr}</p>}
            </form>

            <p className="text-xs text-stone-500">
              在報到機的電話鍵盤輸入這組數字就會開門，報到機斷線時也能用。每次使用都會記在進出紀錄。
            </p>
          </section>

          {/* 4. 設定模式密碼 & 客服資訊 */}
          <div className="space-y-4">
            <section className="bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-sg-brown" />
                設定模式密碼
              </h2>
              <form onSubmit={handleChangeSetupPin} className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={newSetupPin}
                    onChange={(e) => { setNewSetupPin(e.target.value); setSetupPinErr(''); }}
                    placeholder={overview?.setup_pin_status?.is_set ? '已設定（輸入新 6 碼數字更換）' : '輸入 6 碼數字'}
                    className="flex-1 min-w-[180px] px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono"
                  />
                  <button
                    type="submit"
                    disabled={savingSetupPin}
                    className="px-4 py-2 rounded-lg bg-stone-800 text-white text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                  >
                    {savingSetupPin ? '儲存中...' : '儲存'}
                  </button>
                </div>
                {setupPinErr && <p className="text-xs text-rose-600 font-medium">{setupPinErr}</p>}
              </form>
              <p className="text-xs text-stone-500">在報到機長按左上角 3 秒後輸入。</p>
            </section>

            <section className="bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-sg-brown" />
                客服資訊
              </h2>
              <form onSubmit={handleSaveContact} className="space-y-2.5 text-sm">
                <div>
                  <label className="block text-xs text-stone-500 mb-1">LINE 連結</label>
                  <input
                    type="url"
                    value={contactForm.line_url}
                    onChange={(e) => setContactForm((c) => ({ ...c, line_url: e.target.value }))}
                    placeholder="https://lin.ee/..."
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-stone-500 mb-1">LINE ID</label>
                  <input
                    type="text"
                    value={contactForm.line_id}
                    onChange={(e) => setContactForm((c) => ({ ...c, line_id: e.target.value }))}
                    placeholder="@example"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
                  />
                </div>
                <p className="text-xs text-stone-500">
                  報到機「聯絡我們」的條碼由這個連結產生，改了不用重新燒錄。
                </p>
                <button
                  type="submit"
                  disabled={savingContact}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sg-brown text-white text-sm font-medium hover:opacity-95 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  {savingContact ? '儲存中...' : '儲存'}
                </button>
              </form>
            </section>
          </div>

          {/* 5. 待機輪播圖（Item 3） */}
          <section
            data-testid="kiosk-carousel-section"
            className="lg:col-span-2 bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-sg-brown" />
                待機輪播圖（ESP32-P4）
              </h2>
              <span className="text-xs text-stone-500 font-mono">
                {slides.filter((s) => s.enabled).length}/5 張啟用中 · 800×480 RGB565
              </span>
            </div>

            {/* 現有輪播圖清單 */}
            {loadingSlides ? (
              <div className="py-4 text-center text-sm text-stone-400">載入輪播圖中...</div>
            ) : slides.length === 0 ? (
              <div className="py-6 text-center text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg">
                目前沒有待機輪播圖，機台將顯示預設待機畫面
              </div>
            ) : (
              <div className="grid gap-3">
                {slides.map((slide, idx) => (
                  <div
                    key={slide.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border border-stone-200 bg-stone-50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-stone-400 w-4 text-center">#{idx + 1}</span>
                      <div className="w-16 h-10 bg-black rounded overflow-hidden flex items-center justify-center border border-stone-300">
                        <img
                          src={`/api/kiosk/files/slides/${slide.id}.bin`}
                          alt={slide.title}
                          className="w-full h-full object-cover hidden"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                        <span className="text-[10px] text-stone-400 font-mono">800×480</span>
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-stone-800">{slide.title}</div>
                        <div className="text-xs text-stone-500 font-mono">
                          播放 {slide.duration_sec} 秒 · SHA: {slide.sha256.slice(0, 8)}...
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleToggleSlide(slide)}
                        className={`px-2.5 py-1 rounded-full text-xs font-medium border ${
                          slide.enabled
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                            : 'bg-stone-100 text-stone-500 border-stone-300'
                        }`}
                      >
                        {slide.enabled ? '啟用中' : '已停用'}
                      </button>
                      <button
                        type="button"
                        disabled={idx === 0}
                        onClick={() => handleMoveSlide(idx, -1)}
                        className="p-1 rounded hover:bg-stone-200 text-stone-600 disabled:opacity-30"
                        title="上移"
                      >
                        <ArrowUp className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        disabled={idx === slides.length - 1}
                        onClick={() => handleMoveSlide(idx, 1)}
                        className="p-1 rounded hover:bg-stone-200 text-stone-600 disabled:opacity-30"
                        title="下移"
                      >
                        <ArrowDown className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSlide(slide.id)}
                        className="p-1 rounded hover:bg-rose-100 text-rose-600"
                        title="刪除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 上傳新輪播圖 */}
            <div className="border-t border-stone-100 pt-4 space-y-3">
              <h3 className="text-sm font-bold text-stone-700 flex items-center gap-1.5">
                <Upload className="w-4 h-4 text-sg-brown" />
                新增輪播圖
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">圖片檔案（PNG / JPG / WEBP）</label>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => processImageFile(e.target.files?.[0])}
                      className="text-xs file:mr-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:bg-stone-800 file:text-white file:text-xs"
                    />
                  </div>
                  <div className="flex gap-4 text-xs text-stone-700">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="cropMode"
                        value="cover"
                        checked={slideCropMode === 'cover'}
                        onChange={(e) => {
                          setSlideCropMode(e.target.value);
                          if (slidePreviewDataUrl) processImageFile(document.querySelector('input[type="file"]')?.files?.[0], 'cover');
                        }}
                      />
                      裁切填滿（Cover）
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="cropMode"
                        value="contain"
                        checked={slideCropMode === 'contain'}
                        onChange={(e) => {
                          setSlideCropMode(e.target.value);
                          if (slidePreviewDataUrl) processImageFile(document.querySelector('input[type="file"]')?.files?.[0], 'contain');
                        }}
                      />
                      等比留黑（Contain）
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs text-stone-500 mb-1">圖片標題</label>
                      <input
                        type="text"
                        value={slideTitle}
                        onChange={(e) => setSlideTitle(e.target.value)}
                        placeholder="例：今日精選咖啡"
                        className="w-full px-2.5 py-1.5 border border-stone-300 rounded text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-stone-500 mb-1">播放秒數 (5~30)</label>
                      <input
                        type="number"
                        min={5}
                        max={30}
                        value={slideDuration}
                        onChange={(e) => setSlideDuration(e.target.value)}
                        className="w-full px-2.5 py-1.5 border border-stone-300 rounded text-xs"
                      />
                    </div>
                  </div>
                  {slideError && <p className="text-xs text-rose-600 font-medium">{slideError}</p>}
                  <button
                    type="button"
                    onClick={handleUploadSlide}
                    disabled={!slideImageData || uploadingSlide || slides.filter((s) => s.enabled).length >= 5}
                    className="px-4 py-2 bg-sg-brown text-white text-xs font-bold rounded-lg hover:opacity-95 disabled:opacity-50"
                  >
                    {uploadingSlide ? '轉檔編碼並上傳中...' : '轉為 RGB565 並上傳至機台'}
                  </button>
                  {slides.filter((s) => s.enabled).length >= 5 && (
                    <p className="text-[11px] text-amber-600">已達 5 張啟用上限，請先停用或刪除其他圖片。</p>
                  )}
                </div>

                {/* 預覽畫布 */}
                <div className="flex flex-col items-center justify-center p-3 bg-stone-100 rounded-lg border border-stone-200">
                  <span className="text-[11px] text-stone-500 mb-1 font-mono">800 × 480 預覽 (RGB565)</span>
                  {slidePreviewDataUrl ? (
                    <img
                      src={slidePreviewDataUrl}
                      alt="預覽"
                      className="w-full max-w-[280px] aspect-[5/3] object-contain rounded border border-stone-400 bg-black shadow-sm"
                    />
                  ) : (
                    <div className="w-full max-w-[280px] aspect-[5/3] rounded border border-dashed border-stone-300 flex items-center justify-center text-xs text-stone-400 bg-white">
                      選取圖片後在此預覽
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* 6. 進出紀錄 */}
          <section className="lg:col-span-2 bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-bold text-stone-800">進出紀錄</h2>
              <input
                type="date"
                value={logDate}
                onChange={(e) => setLogDate(e.target.value)}
                className="px-3 py-1.5 border border-stone-300 rounded-lg text-sm"
              />
            </div>

            {logsLoading ? (
              <div className="py-6 text-center text-sm text-stone-500">載入紀錄中...</div>
            ) : logs.length === 0 ? (
              <div className="py-6 text-center text-sm text-stone-400">這一天沒有報到機進出紀錄</div>
            ) : (
              <div className="divide-y divide-stone-100 border border-stone-200 rounded-lg overflow-hidden">
                <div className="hidden sm:grid sm:grid-cols-4 bg-stone-50 px-3 py-2 text-xs font-semibold text-stone-500">
                  <div>時間</div>
                  <div>顧客</div>
                  <div>方式</div>
                  <div>結果</div>
                </div>
                {logs.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 items-center px-3 py-2.5 text-sm bg-white"
                  >
                    <div className="font-mono text-xs sm:text-sm text-stone-700">
                      {item.at_unknown
                        ? `發生時間不明，補報於 ${formatTaipeiDateTime(item.at, false)}`
                        : formatTaipeiDateTime(item.at, false)}
                    </div>
                    <div className="text-stone-800 font-medium truncate">
                      {item.user_name || (item.hint ? `末碼 ${item.hint}` : '—')}
                    </div>
                    <div className="text-xs sm:text-sm text-stone-600">
                      {METHOD_LABELS[item.method] || item.method}
                    </div>
                    <div className="flex justify-end sm:justify-start">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                          RESULT_STYLES[item.result] || 'bg-stone-100 text-stone-600 border-stone-200'
                        }`}
                      >
                        {RESULT_LABELS[item.result] || item.result}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

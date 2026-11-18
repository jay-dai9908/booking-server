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

  // 韌體更新 OTA（Item 4）
  const [firmwares, setFirmwares] = useState([]);
  const [loadingFirmwares, setLoadingFirmwares] = useState(false);
  const [fwTarget, setFwTarget] = useState({ id: null, policy: 'none' });
  const [savingFwTarget, setSavingFwTarget] = useState(false);
  const [fwFileBuffer, setFwFileBuffer] = useState(null);
  const [fwFileVersion, setFwFileVersion] = useState('');
  const [fwFileNote, setFwFileNote] = useState('');
  const [uploadingFw, setUploadingFw] = useState(false);
  const [fwError, setFwError] = useState('');

  // 警報通知收件人（Item 5）
  const [alertUserIds, setAlertUserIds] = useState([]);
  const [alertCandidates, setAlertCandidates] = useState([]);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [savingRecipients, setSavingRecipients] = useState(false);

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

  const fetchFirmwares = useCallback(async () => {
    setLoadingFirmwares(true);
    try {
      const res = await api.get('/kiosk/admin/firmware');
      setFirmwares(Array.isArray(res.data?.firmwares) ? res.data.firmwares : []);
      if (res.data?.target) {
        setFwTarget({
          id: res.data.target.id || null,
          policy: res.data.target.policy || 'none'
        });
      }
    } catch (err) {
      console.warn('Failed to load firmware:', err);
    } finally {
      setLoadingFirmwares(false);
    }
  }, []);

  const fetchRecipients = useCallback(async () => {
    setLoadingRecipients(true);
    try {
      const res = await api.get('/kiosk/admin/alerts/recipients');
      setAlertUserIds(Array.isArray(res.data?.alert_user_ids) ? res.data.alert_user_ids : []);
      setAlertCandidates(Array.isArray(res.data?.candidates) ? res.data.candidates : []);
    } catch (err) {
      console.warn('Failed to load alert recipients:', err);
    } finally {
      setLoadingRecipients(false);
    }
  }, []);

  useEffect(() => {
    fetchOverview();
    fetchSlides();
    fetchFirmwares();
    fetchRecipients();
  }, [fetchOverview, fetchSlides, fetchFirmwares, fetchRecipients]);

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

  const [testingAlert, setTestingAlert] = useState(false);
  const [searchPhone, setSearchPhone] = useState('');

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
        preview: slidePreviewDataUrl,
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

  const handleGenerateTestPattern = async () => {
    setUploadingSlide(true);
    setSlideError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = SLIDE_WIDTH;
      canvas.height = SLIDE_HEIGHT;
      const ctx = canvas.getContext('2d');
      // Red, Green, Blue, White vertical stripes (200px each)
      const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'];
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = colors[i];
        ctx.fillRect(i * 200, 0, 200, SLIDE_HEIGHT);
      }
      const imgData = ctx.getImageData(0, 0, SLIDE_WIDTH, SLIDE_HEIGHT);
      const previewUrl = canvas.toDataURL('image/jpeg', 0.8);
      const rgb565Bytes = rgbaToRgb565(imgData, { dither: false });
      let binaryStr = '';
      const len = rgb565Bytes.byteLength;
      for (let i = 0; i < len; i += 8192) {
        const chunk = rgb565Bytes.subarray(i, Math.min(i + 8192, len));
        binaryStr += String.fromCharCode.apply(null, chunk);
      }
      const b64 = btoa(binaryStr);

      await api.post('/kiosk/admin/slides', {
        title: '色彩校正測試圖',
        duration_sec: 8,
        raw_base64: b64,
        preview: previewUrl,
        enabled: true
      });

      showNotice('success', '已產生並上傳色彩校正測試圖');
      fetchSlides();
    } catch (err) {
      setSlideError(err.response?.data?.message || '產生測試圖失敗');
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

  // 處理韌體檔案選擇
  const handleFwFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFwError('');
    setFwFileVersion('');
    setFwFileBuffer(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const buf = new Uint8Array(ev.target.result);
      if (buf.length < 64 || buf.length > 2097152) {
        setFwError('韌體檔案大小必須在 64 bytes 至 2MB 之間');
        return;
      }
      if (buf[0] !== 0xe9) {
        setFwError('非 ESP32 韌體格式（Magic byte 必須為 0xE9）');
        return;
      }
      const verSub = buf.subarray(48, 80);
      let nullIdx = verSub.indexOf(0);
      if (nullIdx === -1) nullIdx = verSub.length;
      let verStr = '';
      for (let i = 0; i < nullIdx; i++) {
        verStr += String.fromCharCode(verSub[i]);
      }
      verStr = verStr.trim();
      if (!verStr) {
        setFwError('韌體標頭未找到有效版本字串');
        return;
      }
      setFwFileVersion(verStr);
      setFwFileBuffer(buf);
    };
    reader.readAsArrayBuffer(file);
  };

  const handleUploadFirmware = async () => {
    if (!fwFileBuffer) {
      setFwError('請先選取有效的 ESP32 .bin 韌體檔案');
      return;
    }
    setUploadingFw(true);
    setFwError('');
    try {
      let binStr = '';
      const len = fwFileBuffer.byteLength;
      for (let i = 0; i < len; i += 8192) {
        const chunk = fwFileBuffer.subarray(i, Math.min(i + 8192, len));
        binStr += String.fromCharCode.apply(null, chunk);
      }
      const b64 = btoa(binStr);

      await api.post('/kiosk/admin/firmware', {
        raw_base64: b64,
        note: fwFileNote || null
      });

      showNotice('success', `韌體 ${fwFileVersion} 上傳成功`);
      setFwFileBuffer(null);
      setFwFileVersion('');
      setFwFileNote('');
      fetchFirmwares();
    } catch (err) {
      setFwError(err.response?.data?.message || err.response?.data?.error || '上傳韌體失敗');
    } finally {
      setUploadingFw(false);
    }
  };

  const handleApplyFwPolicy = async (policy, targetVersion = '') => {
    if (policy !== 'none' && !fwTarget.id) {
      showNotice('error', '請先選擇要更新的目標韌體版本');
      return;
    }
    const isSelfService = Boolean(todayMode?.is_self_service);
    if (policy === 'now') {
      const confirmText = isSelfService
        ? '現在是半自助時段，更新期間（約 1 到 2 分鐘）顧客無法報到。確定要立即更新嗎？'
        : '確定要立即更新報到機韌體嗎？（報到機將在閒置 1 分鐘後開始更新）';
      if (!window.confirm(confirmText)) return;
    } else if (policy === 'night') {
      if (!window.confirm(`確定排定在今晚 03:00 之後更新至 ${targetVersion || '新版本'} 嗎？`)) return;
    }
    setSavingFwTarget(true);
    try {
      await api.put('/kiosk/admin/firmware/target', {
        firmware_id: fwTarget.id ? Number(fwTarget.id) : null,
        policy
      });
      showNotice('success', policy === 'none' ? '已取消韌體更新' : '韌體更新策略已排定');
      fetchFirmwares();
    } catch (err) {
      showNotice('error', err.response?.data?.message || '設定韌體更新策略失敗');
    } finally {
      setSavingFwTarget(false);
    }
  };

  const handleSaveFwTarget = async () => {
    setSavingFwTarget(true);
    try {
      await api.put('/kiosk/admin/firmware/target', {
        firmware_id: fwTarget.id ? Number(fwTarget.id) : null,
        policy: fwTarget.policy || 'none'
      });
      showNotice('success', '韌體目標與更新策略已儲存');
      fetchFirmwares();
    } catch (err) {
      showNotice('error', err.response?.data?.message || '儲存韌體設定失敗');
    } finally {
      setSavingFwTarget(false);
    }
  };

  const handleDeleteFirmware = async (id) => {
    if (!window.confirm('確定要刪除此韌體版本嗎？')) return;
    try {
      await api.delete(`/kiosk/admin/firmware/${id}`);
      showNotice('success', '已刪除韌體');
      fetchFirmwares();
    } catch (err) {
      showNotice('error', err.response?.data?.message || '刪除韌體失敗');
    }
  };

  const handleToggleRecipient = (userId) => {
    setAlertUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const handleAddRecipientByPhone = () => {
    if (!searchPhone.trim()) return;
    const cleanPhone = searchPhone.trim();
    const candidate = alertCandidates.find(
      (c) => c.phone === cleanPhone || c.phone.replace(/[^0-9]/g, '') === cleanPhone.replace(/[^0-9]/g, '')
    );
    if (!candidate) {
      showNotice('error', '查無此電話或該會員尚未綁定 LINE');
      return;
    }
    if (alertUserIds.includes(candidate.id)) {
      showNotice('error', '該會員已在通知名單中');
      return;
    }
    if (alertUserIds.length >= 3) {
      showNotice('error', '最多只能設定 3 位通知對象');
      return;
    }
    setAlertUserIds((prev) => [...prev, candidate.id]);
    setSearchPhone('');
  };

  const handleRemoveRecipient = (userId) => {
    setAlertUserIds((prev) => prev.filter((id) => id !== userId));
  };

  const handleSendTestAlert = async () => {
    setTestingAlert(true);
    try {
      await api.post('/kiosk/admin/alerts/test');
      showNotice('success', '測試通知已發送');
    } catch (err) {
      showNotice('error', err.response?.data?.message || '發送測試通知失敗');
    } finally {
      setTestingAlert(false);
    }
  };

  const handleSaveRecipients = async () => {
    if (alertUserIds.length > 3) {
      showNotice('error', '通知對象最多只能設定 3 位');
      return;
    }
    setSavingRecipients(true);
    try {
      await api.put('/kiosk/admin/alerts/recipients', { user_ids: alertUserIds });
      showNotice('success', '警報收件人已更新');
      fetchRecipients();
    } catch (err) {
      showNotice('error', '儲存警報收件人失敗');
    } finally {
      setSavingRecipients(false);
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
                <p className="text-xs text-stone-500 pt-1">
                  超過 10 分鐘沒同步會顯示『離線』，並用 LINE 通知管理員。
                </p>
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
                輪播圖 {slides.length}／5 張
              </h2>
              <span className="text-xs text-stone-500 font-mono">
                {slides.filter((s) => s.enabled).length}/5 張啟用中 · 800×480 RGB565
              </span>
            </div>
            <p className="text-xs text-stone-500">
              會自動裁成 800×480。報到機同步時只下載有變動的圖。
            </p>

            {/* 現有輪播圖清單 */}
            {loadingSlides ? (
              <div className="py-4 text-center text-sm text-stone-400">載入輪播圖中...</div>
            ) : slides.length === 0 ? (
              <div className="py-6 text-center text-sm text-stone-400 border border-dashed border-stone-200 rounded-lg">
                還沒有輪播圖，報到機會顯示內建的畫面。
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
                        {slide.preview ? (
                          <img
                            src={slide.preview}
                            alt={slide.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span className="text-[10px] text-stone-400 font-mono">800×480</span>
                        )}
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-stone-800">{slide.title}</div>
                        <div className="text-xs text-stone-500 font-mono">
                          顯示 {slide.seconds || slide.duration_sec || 8} 秒 · SHA: {slide.sha256.slice(0, 8)}...
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
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleUploadSlide}
                      disabled={!slideImageData || uploadingSlide || slides.filter((s) => s.enabled).length >= 5}
                      className="px-4 py-2 bg-sg-brown text-white text-xs font-bold rounded-lg hover:opacity-95 disabled:opacity-50"
                    >
                      {uploadingSlide ? '上傳中...' : '上傳圖片'}
                    </button>
                    <button
                      type="button"
                      onClick={handleGenerateTestPattern}
                      disabled={slides.filter((s) => s.enabled).length >= 5 || uploadingSlide}
                      className="px-3 py-2 bg-white border border-stone-300 text-stone-700 text-xs font-bold rounded-lg hover:bg-stone-50 disabled:opacity-50"
                    >
                      產生測試圖
                    </button>
                  </div>
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

          {/* 6. 韌體更新（OTA，Item 4） */}
          <section
            data-testid="kiosk-firmware-section"
            className="lg:col-span-2 bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-sg-brown" />
                韌體更新
              </h2>
              <span className="text-xs text-stone-500 font-mono">ESP32-P4 SGK1 v1</span>
            </div>

            <p className="text-xs text-stone-500">
              『立即更新』會等報到機閒置 1 分鐘才開始，期間畫面顯示『系統更新中』。更新失敗會自動退回舊版。
            </p>

            {todayMode?.is_self_service && (
              <div className="text-xs text-amber-800 bg-amber-50 p-2.5 rounded-lg border border-amber-200 font-medium">
                現在是半自助時段，更新期間（約 1 到 2 分鐘）顧客無法報到
              </div>
            )}

            {/* 機台目前韌體狀態與目標推送策略 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3.5 bg-stone-50 rounded-xl border border-stone-200 text-xs">
              <div className="space-y-1">
                <div className="text-stone-500">機台目前韌體</div>
                <div className="font-mono text-stone-800 font-bold text-sm">
                  {primaryDevice?.fw_version || '未知'}
                </div>
                <div className="text-stone-700">
                  狀態：
                  {fwTarget.policy === 'night'
                    ? `已排定今晚 03:00 之後更新到 ${firmwares.find((f) => f.id === fwTarget.id)?.version || ''}`
                    : fwTarget.policy === 'now'
                    ? `已排定立即更新到 ${firmwares.find((f) => f.id === fwTarget.id)?.version || ''}`
                    : primaryDevice?.status_json?.fw_state === 'downloading'
                    ? '報到機下載中'
                    : (primaryDevice?.status_json?.fw_state?.startsWith('failed:') || primaryDevice?.status_json?.ota_failed)
                    ? `更新失敗：${primaryDevice?.status_json?.ota_failed || primaryDevice?.status_json?.fw_state}，報到機仍在 ${primaryDevice?.fw_version || '舊版'}`
                    : (primaryDevice?.fw_version && firmwares.find((f) => f.id === fwTarget.id)?.version && primaryDevice?.fw_version === firmwares.find((f) => f.id === fwTarget.id)?.version)
                    ? `已更新到 ${primaryDevice.fw_version}，報到機回報正常`
                    : '目前無排定更新'}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-stone-600">指定更新版本：</span>
                  <select
                    value={fwTarget.id || ''}
                    onChange={(e) => setFwTarget((t) => ({ ...t, id: e.target.value ? Number(e.target.value) : null }))}
                    className="px-2 py-1 border border-stone-300 rounded font-mono text-xs"
                  >
                    <option value="">(請選擇版本)</option>
                    {firmwares.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.version} ({f.note || '無備註'})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => handleApplyFwPolicy('now')}
                    disabled={!fwTarget.id || savingFwTarget}
                    className="px-3 py-1.5 bg-sg-brown text-white font-bold text-xs rounded hover:opacity-95 disabled:opacity-50"
                  >
                    立即更新
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApplyFwPolicy('night', firmwares.find((f) => f.id === fwTarget.id)?.version)}
                    disabled={!fwTarget.id || savingFwTarget}
                    className="px-3 py-1.5 bg-stone-800 text-white font-bold text-xs rounded hover:bg-stone-700 disabled:opacity-50"
                  >
                    凌晨 3 到 5 點自動更新
                  </button>
                  {fwTarget.policy && fwTarget.policy !== 'none' && (
                    <button
                      type="button"
                      onClick={() => handleApplyFwPolicy('none')}
                      className="px-2.5 py-1.5 text-xs text-rose-600 hover:bg-rose-50 rounded border border-rose-200"
                    >
                      取消排程
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* 上傳新韌體 .bin */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-stone-700">上傳新版本韌體 (.bin)</h3>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="file"
                  accept=".bin"
                  onChange={handleFwFileSelect}
                  className="text-xs file:mr-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:bg-stone-800 file:text-white file:text-xs"
                />
                {fwFileVersion && (
                  <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 font-mono text-xs font-semibold border border-emerald-200">
                    偵測到版本：{fwFileVersion}
                  </span>
                )}
                <input
                  type="text"
                  value={fwFileNote}
                  onChange={(e) => setFwFileNote(e.target.value)}
                  placeholder="版本備註（例：修正掃碼穩定度）"
                  className="px-2.5 py-1 border border-stone-300 rounded text-xs min-w-[200px]"
                />
                <button
                  type="button"
                  onClick={handleUploadFirmware}
                  disabled={!fwFileBuffer || uploadingFw}
                  className="px-3 py-1 bg-sg-brown text-white font-bold text-xs rounded hover:opacity-95 disabled:opacity-50"
                >
                  {uploadingFw ? '上傳中...' : '上傳韌體'}
                </button>
              </div>
              {fwError && <p className="text-xs text-rose-600 font-medium">{fwError}</p>}
            </div>

            {/* 歷史韌體版本列表 */}
            {loadingFirmwares ? (
              <div className="py-2 text-center text-xs text-stone-400">載入韌體列表中...</div>
            ) : firmwares.length === 0 ? (
              <div className="text-xs text-stone-400 text-center py-3 border border-dashed border-stone-200 rounded">
                尚未上傳任何韌體版本
              </div>
            ) : (
              <div className="border border-stone-200 rounded-lg overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead className="bg-stone-50 border-b border-stone-200 text-stone-500">
                    <tr>
                      <th className="py-2 px-3">版本</th>
                      <th className="py-2 px-3">檔案大小</th>
                      <th className="py-2 px-3">SHA-256</th>
                      <th className="py-2 px-3">備註</th>
                      <th className="py-2 px-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 font-mono">
                    {firmwares.map((fw) => {
                      const isTarget = fwTarget.id === fw.id;
                      return (
                        <tr key={fw.id} className={isTarget ? 'bg-amber-50/50' : 'bg-white'}>
                          <td className="py-2 px-3 font-bold text-stone-800">
                            {fw.version}
                            {isTarget && (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-800 font-sans font-medium">
                                目標版本 ({fwTarget.policy})
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 text-stone-600">{(fw.size / 1024).toFixed(1)} KB</td>
                          <td className="py-2 px-3 text-stone-500">{fw.sha256.slice(0, 10)}...</td>
                          <td className="py-2 px-3 font-sans text-stone-700">{fw.note || '—'}</td>
                          <td className="py-2 px-3 text-right font-sans space-x-2">
                            {!isTarget && (
                              <button
                                type="button"
                                onClick={() => {
                                  setFwTarget((t) => ({ ...t, id: fw.id }));
                                }}
                                className="text-sg-brown hover:underline font-medium"
                              >
                                選為目標
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={isTarget}
                              onClick={() => handleDeleteFirmware(fw.id)}
                              className="text-rose-600 hover:underline font-medium disabled:opacity-30"
                            >
                              刪除
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 7. LINE 警報通知收件人（Item 5） */}
          <section
            data-testid="kiosk-alerts-section"
            className="lg:col-span-2 bg-white border border-stone-200 rounded-xl shadow-sm p-4 sm:p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-stone-800 flex items-center gap-2">
                <Bell className="w-4 h-4 text-sg-brown" />
                通知對象
              </h2>
              <button
                type="button"
                onClick={handleSendTestAlert}
                disabled={testingAlert || alertUserIds.length === 0}
                className="px-2.5 py-1 text-xs border border-stone-300 rounded-lg text-stone-700 hover:bg-stone-50 disabled:opacity-50 font-medium"
              >
                {testingAlert ? '發送中...' : '發一則測試通知'}
              </button>
            </div>

            {alertUserIds.length === 0 && overview?.has_self_service_in_7_days && (
              <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-300 text-amber-900 text-sm font-medium">
                沒有設定通知對象（未來 7 天內有半自助日，請盡快設定）
              </div>
            )}

            {/* 加入收件人：電話搜尋 */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                type="text"
                value={searchPhone}
                onChange={(e) => setSearchPhone(e.target.value)}
                placeholder="輸入會員電話加入"
                className="px-2.5 py-1.5 border border-stone-300 rounded text-xs min-w-[180px]"
              />
              <button
                type="button"
                onClick={handleAddRecipientByPhone}
                disabled={alertUserIds.length >= 3}
                className="px-3 py-1.5 bg-stone-800 text-white text-xs font-bold rounded hover:bg-stone-700 disabled:opacity-50"
              >
                加入
              </button>
              <span className="text-[11px] text-stone-500">
                （最多 3 位，限已綁定 LINE 會員）
              </span>
            </div>

            {/* 目前已加入的通知對象清單 */}
            <div className="space-y-2 pt-2">
              <div className="text-xs font-semibold text-stone-700">目前通知清單（{alertUserIds.length}/3）：</div>
              {alertUserIds.length === 0 ? (
                <div className="text-xs text-stone-400 py-3 border border-dashed border-stone-200 rounded text-center">
                  尚未設定任何通知對象
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                  {alertUserIds.map((userId) => {
                    const candidate = alertCandidates.find((c) => c.id === userId);
                    return (
                      <div
                        key={userId}
                        className="flex items-center justify-between p-2.5 rounded-lg border border-emerald-300 bg-emerald-50/60 text-xs"
                      >
                        <div>
                          <div className="font-semibold text-emerald-950">{candidate?.name || `會員 #${userId}`}</div>
                          <div className="text-[11px] text-stone-500 font-mono">{candidate?.phone || '無電話'}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveRecipient(userId)}
                          className="p-1 text-stone-400 hover:text-rose-600 rounded"
                          title="移除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={handleSaveRecipients}
                  disabled={savingRecipients}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-sg-brown text-white text-xs font-bold hover:opacity-95 disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  {savingRecipients ? '儲存中...' : '儲存通知對象'}
                </button>
              </div>
            </div>
          </section>

          {/* 8. 進出紀錄 */}
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

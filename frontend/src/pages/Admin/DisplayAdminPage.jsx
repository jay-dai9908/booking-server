// frontend/src/pages/Admin/DisplayAdminPage.jsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Monitor,
  RefreshCw,
  LogOut,
  KeyRound,
  Plus,
  Save,
  Upload,
  Trash2,
  ArrowUp,
  ArrowDown,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import api from '../../api/axios';
import { buildFloorMap } from '@shared/floorMap.js';
import { DEFAULT_DISPLAY_SCHEDULE } from '@shared/displaySchedule.js';
import DisplayFloorMap from '../../components/display/DisplayFloorMap';

const DAY_LABELS = {
  self: { name: '半自助日', sub: '每日設定勾了半自助' },
  weekday: { name: '平日', sub: '週一到週五，或手動指定' },
  holiday: { name: '假日', sub: '週六日，或手動指定' },
  closed: { name: '公休日', sub: '當天沒有任何時段' }
};

const VIEW_LABELS = {
  timers: '平面圖＋資訊卡',
  timers_self: '平面圖＋LINE與注意事項',
  slides_self: '半自助日輪播＋LINE＋注意事項',
  slides_gen: '一般輪播',
  off: '熄滅'
};

const MODE_OPTIONS = [
  { value: 'biz', label: '跟營業時段' },
  { value: 'fixed', label: '固定時間' },
  { value: 'always', label: '整天開' },
  { value: 'never', label: '整天關' }
];

const CONTENT_OPTIONS = [
  { value: 'timers', label: '平面圖＋資訊卡' },
  { value: 'timers_self', label: '平面圖＋LINE與注意事項' },
  { value: 'slides_self', label: '半自助日輪播＋LINE＋注意事項' },
  { value: 'slides_gen', label: '一般輪播' },
  { value: 'off', label: '熄滅' }
];

const ROTATION_OPTIONS = [
  { deg: 0, label: '0°（同座位設定）' },
  { deg: 90, label: '90°（門口在左）' },
  { deg: 180, label: '180°' },
  { deg: 270, label: '270°（門口在右）' }
];

function createDefaultSettings() {
  return {
    schedule: JSON.parse(JSON.stringify(DEFAULT_DISPLAY_SCHEDULE)),
    special_dates: [],
    map_rotation: 90,
    here_element: '',
    time_mode: 'remain',
    soon_minutes: 10,
    fallback_to_slides: true,
    cards: { seats: true, soon: true, price: true },
    card_seconds: 12,
    announcements: [],
    announcement_seconds: 10,
    show_line_mini: true,
    line_title: '有問題請加 LINE',
    notices: [],
    closing_warn: true,
    closing_minutes: 30,
    shift_minutes: 3,
    slide_seconds: 8
  };
}

function formatLastSeen(iso) {
  if (!iso) return { online: false, label: '尚未連線' };
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return { online: false, label: '—' };
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 120) return { online: true, label: `連線中 · ${sec} 秒前` };
  const mins = Math.floor(sec / 60);
  if (mins < 60) return { online: false, label: `離線 · ${mins} 分鐘前` };
  const hrs = Math.floor(mins / 60);
  return { online: false, label: `離線 · ${hrs} 小時前` };
}

function resolveSlideUrl(slide) {
  const base = (api.defaults.baseURL || '/api').replace(/\/api\/?$/, '');
  if (slide.url) {
    return /^https?:\/\//i.test(slide.url) ? slide.url : `${base}${slide.url}`;
  }
  return `${base}/api/display/files/slides/${slide.id}/${slide.sha256}`;
}

export default function DisplayAdminPage() {
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState(null);

  // Devices
  const [devices, setDevices] = useState([]);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDevicePassword, setNewDevicePassword] = useState('');
  const [creatingDevice, setCreatingDevice] = useState(false);
  const [pwEditDeviceId, setPwEditDeviceId] = useState(null);
  const [pwEditValue, setPwEditValue] = useState('');
  const [deviceActionBusy, setDeviceActionBusy] = useState({});

  // Settings
  const [settings, setSettings] = useState(createDefaultSettings);
  const [lineInfo, setLineInfo] = useState({ line_id: '', line_url: '' });
  const [noticesText, setNoticesText] = useState('');
  const [announcementsText, setAnnouncementsText] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);

  // Special date draft
  const [spDate, setSpDate] = useState('');
  const [spOff, setSpOff] = useState('23:30');
  const [spNote, setSpNote] = useState('');

  // Floor map & here_element options
  const [floorMap, setFloorMap] = useState(null);
  const [hereOptions, setHereOptions] = useState([]);

  // Slides
  const [slides, setSlides] = useState([]);
  const [uploadSet, setUploadSet] = useState('self');
  const [slideUploadForm, setSlideUploadForm] = useState({
    self: { title: '', seconds: 8, file: null, dataUrl: '', error: '', busy: false },
    general: { title: '', seconds: 8, file: null, dataUrl: '', error: '', busy: false }
  });

  const showNotice = (type, text) => {
    setNotice({ type, text });
    setTimeout(() => setNotice(null), 4000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [devRes, setRes, slidesRes] = await Promise.all([
        api.get('/display/admin/devices'),
        api.get('/display/admin/settings'),
        api.get('/display/admin/slides').catch(() => ({ data: { slides: [] } }))
      ]);

      setDevices(Array.isArray(devRes.data?.devices) ? devRes.data.devices : []);

      const rawSettings = setRes.data?.settings || setRes.data || {};
      const defaults = createDefaultSettings();
      const mergedSchedule = { ...defaults.schedule };
      if (rawSettings.schedule && typeof rawSettings.schedule === 'object') {
        for (const k of Object.keys(defaults.schedule)) {
          if (rawSettings.schedule[k]) {
            mergedSchedule[k] = { ...defaults.schedule[k], ...rawSettings.schedule[k] };
          }
        }
      }

      const loadedNotices = Array.isArray(rawSettings.notices) ? rawSettings.notices : [];
      const loadedAnns = Array.isArray(rawSettings.announcements) ? rawSettings.announcements : [];

      setSettings({
        ...defaults,
        ...rawSettings,
        schedule: mergedSchedule,
        special_dates: Array.isArray(rawSettings.special_dates) ? rawSettings.special_dates : [],
        cards: { ...defaults.cards, ...(rawSettings.cards || {}) },
        notices: loadedNotices,
        announcements: loadedAnns
      });
      setNoticesText(loadedNotices.join('\n'));
      setAnnouncementsText(loadedAnns.join('\n'));

      setLineInfo({
        line_id: setRes.data?.line?.id ?? rawSettings.line_id ?? '',
        line_url: setRes.data?.line?.url ?? rawSettings.line_url ?? ''
      });

      if (setRes.data?.floor_map) {
        setFloorMap(setRes.data.floor_map);
      }
      const serverHereElements = setRes.data?.floor_elements || setRes.data?.here_options;
      if (Array.isArray(serverHereElements)) {
        setHereOptions(serverHereElements);
      }

      setSlides(Array.isArray(slidesRes.data?.slides) ? slidesRes.data.slides : []);

      // Fetch active seat layout if floor_map or floor_elements missing
      if (!setRes.data?.floor_map || !Array.isArray(serverHereElements)) {
        try {
          const layoutRes = await api.get('/seat-layouts/active');
          const rawLayout = layoutRes.data?.layout || layoutRes.data;
          if (rawLayout) {
            const built = buildFloorMap(rawLayout);
            if (!setRes.data?.floor_map) setFloorMap(built);
            if (!Array.isArray(serverHereElements)) {
              const elems = Array.isArray(rawLayout.elements_json) ? rawLayout.elements_json : [];
              const opts = elems
                .filter(el => (el.type === 'fixture' || el.type === 'counter') && el.label)
                .map(el => ({
                  value: el.id ? String(el.id) : `${el.type}:${el.label}`,
                  label: el.label
                }));
              setHereOptions(opts);
            }
          }
        } catch {}
      }
    } catch (err) {
      showNotice('error', err.response?.data?.error || '載入店內顯示屏設定失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Device Actions
  const handleCreateDevice = async (e) => {
    e.preventDefault();
    if (!newDeviceName.trim()) {
      showNotice('error', '請輸入裝置名稱');
      return;
    }
    if (newDevicePassword.length < 8) {
      showNotice('error', '密碼至少需要 8 碼');
      return;
    }
    setCreatingDevice(true);
    try {
      await api.post('/display/admin/devices', {
        name: newDeviceName.trim(),
        password: newDevicePassword
      });
      setNewDeviceName('');
      setNewDevicePassword('');
      setShowAddDevice(false);
      showNotice('success', '已新增顯示屏裝置');
      const res = await api.get('/display/admin/devices');
      setDevices(Array.isArray(res.data?.devices) ? res.data.devices : []);
    } catch (err) {
      showNotice('error', err.response?.data?.error || '新增裝置失敗');
    } finally {
      setCreatingDevice(false);
    }
  };

  const handleUpdateDevicePassword = async (id) => {
    if (pwEditValue.length < 8) {
      showNotice('error', '新密碼至少需要 8 碼');
      return;
    }
    setDeviceActionBusy(prev => ({ ...prev, [id]: true }));
    try {
      await api.put(`/display/admin/devices/${id}/password`, { password: pwEditValue });
      setPwEditDeviceId(null);
      setPwEditValue('');
      showNotice('success', '已更新顯示屏密碼，使用舊密碼登入的裝置將自動登出');
    } catch (err) {
      showNotice('error', err.response?.data?.error || '更新密碼失敗');
    } finally {
      setDeviceActionBusy(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleLogoutDevice = async (id) => {
    setDeviceActionBusy(prev => ({ ...prev, [id]: true }));
    try {
      await api.post(`/display/admin/devices/${id}/logout`);
      showNotice('success', '已登出此顯示屏裝置');
    } catch (err) {
      showNotice('error', err.response?.data?.error || '登出裝置失敗');
    } finally {
      setDeviceActionBusy(prev => ({ ...prev, [id]: false }));
    }
  };

  const handleReloadDevice = async (id) => {
    setDeviceActionBusy(prev => ({ ...prev, [id]: true }));
    try {
      await api.post(`/display/admin/devices/${id}/reload`);
      showNotice('success', '已送出重新整理指令，顯示屏將在數秒內重整');
    } catch (err) {
      showNotice('error', err.response?.data?.error || '送出重整指令失敗');
    } finally {
      setDeviceActionBusy(prev => ({ ...prev, [id]: false }));
    }
  };

  // Schedule helpers
  const updateScheduleField = (dayType, field, value) => {
    setSettings(prev => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        [dayType]: {
          ...prev.schedule[dayType],
          [field]: value
        }
      }
    }));
  };

  // Special dates
  const handleAddSpecialDate = () => {
    if (!spDate || !spOff) {
      showNotice('error', '請選擇日期與關閉時間');
      return;
    }
    setSettings(prev => ({
      ...prev,
      special_dates: [
        ...(prev.special_dates || []).filter(s => s.date !== spDate),
        { date: spDate, off: spOff, note: spNote.trim() || '特殊營業' }
      ].sort((a, b) => a.date.localeCompare(b.date))
    }));
    setSpNote('');
  };

  const handleRemoveSpecialDate = (idx) => {
    setSettings(prev => ({
      ...prev,
      special_dates: (prev.special_dates || []).filter((_, i) => i !== idx)
    }));
  };

  // Save settings
  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      const noticesArr = noticesText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 5);
      const annArr = announcementsText
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 10);

      const payload = {
        schedule: settings.schedule,
        special_dates: settings.special_dates || [],
        map_rotation: Number(settings.map_rotation),
        here_element: settings.here_element || '',
        time_mode: settings.time_mode || 'remain',
        soon_minutes: Number(settings.soon_minutes),
        fallback_to_slides: Boolean(settings.fallback_to_slides),
        cards: settings.cards,
        card_seconds: Number(settings.card_seconds),
        announcements: annArr,
        announcement_seconds: Number(settings.announcement_seconds),
        show_line_mini: Boolean(settings.show_line_mini),
        line_title: settings.line_title || '有問題請加 LINE',
        notices: noticesArr,
        closing_warn: Boolean(settings.closing_warn),
        closing_minutes: Number(settings.closing_minutes),
        shift_minutes: Number(settings.shift_minutes),
        slide_seconds: Number(settings.slide_seconds)
      };

      await api.put('/display/admin/settings', payload);
      showNotice('success', '顯示設定已儲存並同步至顯示屏');
    } catch (err) {
      showNotice('error', err.response?.data?.error || '儲存設定失敗，請檢查欄位範圍');
    } finally {
      setSavingSettings(false);
    }
  };

  // Slide upload & management
  const handleSlideFileSelect = (setKey, file) => {
    if (!file) return;
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setSlideUploadForm(prev => ({
        ...prev,
        [setKey]: { ...prev[setKey], error: '只支援 JPEG、PNG 或 WebP 圖片', dataUrl: '', file: null }
      }));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setSlideUploadForm(prev => ({
        ...prev,
        [setKey]: { ...prev[setKey], error: '檔案大小不可超過 2 MB', dataUrl: '', file: null }
      }));
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = String(ev.target.result || '');
      const img = new Image();
      img.onload = () => {
        if (img.width !== 1920 || img.height !== 1080) {
          setSlideUploadForm(prev => ({
            ...prev,
            [setKey]: {
              ...prev[setKey],
              error: `圖片尺寸須為 1920×1080（目前為 ${img.width}×${img.height}）`,
              dataUrl: '',
              file: null
            }
          }));
          return;
        }
        setSlideUploadForm(prev => ({
          ...prev,
          [setKey]: {
            ...prev[setKey],
            file,
            dataUrl,
            title: prev[setKey].title || file.name.replace(/\.[^.]+$/, ''),
            error: ''
          }
        }));
      };
      img.onerror = () => {
        setSlideUploadForm(prev => ({
          ...prev,
          [setKey]: { ...prev[setKey], error: '無法解析圖片檔案', dataUrl: '', file: null }
        }));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleUploadSlide = async (setKey) => {
    const form = slideUploadForm[setKey];
    if (!form.dataUrl) {
      setSlideUploadForm(prev => ({
        ...prev,
        [setKey]: { ...prev[setKey], error: '請先選擇 1920×1080 圖片' }
      }));
      return;
    }
    setSlideUploadForm(prev => ({
      ...prev,
      [setKey]: { ...prev[setKey], busy: true, error: '' }
    }));
    try {
      await api.post('/display/admin/slides', {
        set: setKey,
        title: form.title.trim() || '輪播圖片',
        seconds: Number(form.seconds) || 8,
        enabled: true,
        data_base64: form.dataUrl,
        mime: form.file?.type || 'image/png'
      });
      setSlideUploadForm(prev => ({
        ...prev,
        [setKey]: { title: '', seconds: 8, file: null, dataUrl: '', error: '', busy: false }
      }));
      showNotice('success', '輪播圖片上傳成功');
      const res = await api.get('/display/admin/slides');
      setSlides(Array.isArray(res.data?.slides) ? res.data.slides : []);
    } catch (err) {
      setSlideUploadForm(prev => ({
        ...prev,
        [setKey]: {
          ...prev[setKey],
          busy: false,
          error: err.response?.data?.error || '上傳輪播圖失敗'
        }
      }));
    }
  };

  const handleToggleSlide = async (slide) => {
    try {
      await api.patch(`/display/admin/slides/${slide.id}`, { enabled: !slide.enabled });
      const res = await api.get('/display/admin/slides');
      setSlides(Array.isArray(res.data?.slides) ? res.data.slides : []);
    } catch (err) {
      showNotice('error', err.response?.data?.error || '更新輪播狀態失敗');
    }
  };

  const handleMoveSlide = async (setList, idx, dir) => {
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= setList.length) return;
    const reordered = [...setList];
    const tmp = reordered[idx];
    reordered[idx] = reordered[targetIdx];
    reordered[targetIdx] = tmp;
    try {
      await api.put('/display/admin/slides/order', {
        orders: reordered.map((s, i) => ({ id: s.id, sort_order: i }))
      });
      const res = await api.get('/display/admin/slides');
      setSlides(Array.isArray(res.data?.slides) ? res.data.slides : []);
    } catch (err) {
      showNotice('error', '重排輪播順序失敗');
    }
  };

  const handleDeleteSlide = async (slideId) => {
    try {
      await api.delete(`/display/admin/slides/${slideId}`);
      showNotice('success', '已刪除輪播圖片');
      const res = await api.get('/display/admin/slides');
      setSlides(Array.isArray(res.data?.slides) ? res.data.slides : []);
    } catch (err) {
      showNotice('error', err.response?.data?.error || '刪除輪播圖片失敗');
    }
  };

  const selfSlides = useMemo(() => slides.filter(s => s.set === 'self'), [slides]);
  const generalSlides = useMemo(() => slides.filter(s => s.set === 'general'), [slides]);

  const renderSlideSection = (setKey, list) => {
    const form = slideUploadForm[setKey];
    return (
      <div className="space-y-3 pt-2 border-t border-sg-line" data-testid={`display-slides-${setKey}`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-sg-ink">
            {setKey === 'self' ? '半自助日輪播圖' : '一般輪播圖'}
          </span>
          <span className="text-xs text-sg-muted">1920×1080 · JPEG / PNG / WebP · ≤ 2MB</span>
        </div>

        {/* Existing slides list */}
        {list.length > 0 ? (
          <div className="space-y-2">
            {list.map((sl, idx) => (
              <div
                key={sl.id}
                className="flex items-center gap-3 p-2.5 rounded-xl bg-sg-bg border border-sg-line"
              >
                <img
                  src={resolveSlideUrl(sl)}
                  alt={sl.title}
                  className="w-24 h-[54px] object-cover rounded-lg bg-black flex-none"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm text-sg-ink truncate">{sl.title}</div>
                  <div className="text-xs text-sg-muted">
                    {sl.seconds || settings.slide_seconds} 秒 · {sl.enabled ? '啟用中' : '已停用'}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleMoveSlide(list, idx, -1)}
                    disabled={idx === 0}
                    className="p-1.5 rounded-lg border border-sg-line bg-sg-paper text-sg-ink disabled:opacity-40"
                    title="上移"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveSlide(list, idx, 1)}
                    disabled={idx === list.length - 1}
                    className="p-1.5 rounded-lg border border-sg-line bg-sg-paper text-sg-ink disabled:opacity-40"
                    title="下移"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleSlide(sl)}
                    className="p-1.5 rounded-lg border border-sg-line bg-sg-paper text-sg-ink"
                    title={sl.enabled ? '停用' : '啟用'}
                  >
                    {sl.enabled ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5 text-sg-muted" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteSlide(sl.id)}
                    className="p-1.5 rounded-lg border border-sg-line bg-sg-paper text-sg-danger"
                    title="刪除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-sg-muted bg-sg-bg rounded-xl p-3">
            尚未上傳圖片，目前顯示預設文字版輪播。
          </div>
        )}

        {/* Upload box */}
        <div className="flex flex-wrap items-center gap-2 p-3 rounded-xl bg-sg-bg/60 border border-dashed border-sg-line">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            data-testid={`display-slide-file-${setKey}`}
            onChange={(e) => {
              setUploadSet(setKey);
              handleSlideFileSelect(setKey, e.target.files?.[0]);
            }}
            className="text-xs max-w-[210px]"
          />
          <input
            type="text"
            placeholder="標題"
            value={form.title}
            onChange={(e) => setSlideUploadForm(prev => ({
              ...prev,
              [setKey]: { ...prev[setKey], title: e.target.value }
            }))}
            className="px-2.5 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm w-32"
          />
          <label className="flex items-center gap-1 text-xs text-sg-muted">
            停留
            <input
              type="number"
              min={4}
              max={60}
              value={form.seconds}
              onChange={(e) => setSlideUploadForm(prev => ({
                ...prev,
                [setKey]: { ...prev[setKey], seconds: Number(e.target.value) || 8 }
              }))}
              className="px-2 py-1 rounded-lg border border-sg-line bg-sg-paper text-sm w-14"
            />
            秒
          </label>
          <button
            type="button"
            data-testid={`display-slide-upload-${setKey}`}
            disabled={form.busy || !form.dataUrl}
            onClick={() => handleUploadSlide(setKey)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-sg-brown text-sg-paper text-xs font-bold disabled:opacity-40"
          >
            <Upload className="w-3.5 h-3.5" />
            {form.busy ? '上傳中...' : '上傳圖片'}
          </button>
          {form.error && (
            <div className="w-full text-xs text-sg-danger font-bold">{form.error}</div>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="py-12 text-center text-sg-muted text-sm">載入店內顯示屏設定中...</div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5 pb-12" data-testid="display-admin-page">
      {/* Header + Save Action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-sg-ink flex items-center gap-2">
            <Monitor className="w-6 h-6 text-sg-brown" />
            店內顯示屏設定
          </h1>
          <p className="text-sm text-sg-muted mt-0.5">
            管理櫃檯顯示屏裝置登入、排程內容、平面圖方向、資訊卡與輪播圖。
          </p>
        </div>
        <button
          type="button"
          data-testid="display-save-settings-btn"
          disabled={savingSettings}
          onClick={handleSaveSettings}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-sg-brown hover:bg-sg-brown-hover text-sg-paper font-bold text-sm shadow-sm disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {savingSettings ? '儲存中...' : '儲存顯示設定'}
        </button>
      </div>

      {notice && (
        <div
          data-testid="display-admin-notice"
          className={`flex items-center gap-2 px-4 py-3 rounded-2xl border text-sm font-bold ${
            notice.type === 'success'
              ? 'bg-sg-sage-soft border-sg-sage text-sg-sage-ink'
              : 'bg-sg-danger-soft border-sg-danger text-sg-danger'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {notice.text}
        </div>
      )}

      {/* 1. Device Cards */}
      <section className="space-y-3" data-testid="display-devices-section">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-sg-ink">顯示屏裝置</h2>
          <button
            type="button"
            data-testid="add-device-btn"
            onClick={() => setShowAddDevice(v => !v)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-sg-line bg-sg-paper text-sm font-bold text-sg-ink hover:bg-sg-bg"
          >
            <Plus className="w-4 h-4" />
            新增裝置
          </button>
        </div>

        {showAddDevice && (
          <form
            onSubmit={handleCreateDevice}
            className="bg-sg-paper border border-sg-line rounded-2xl p-4 flex flex-wrap items-end gap-3 shadow-warm"
          >
            <label className="flex flex-col gap-1 text-xs text-sg-muted">
              裝置名稱
              <input
                type="text"
                data-testid="new-device-name"
                value={newDeviceName}
                onChange={e => setNewDeviceName(e.target.value)}
                placeholder="例如：櫃檯顯示屏"
                className="px-3 py-1.5 rounded-lg border border-sg-line bg-sg-bg text-sm text-sg-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-sg-muted">
              登入密碼（至少 8 碼）
              <input
                type="password"
                data-testid="new-device-password"
                value={newDevicePassword}
                onChange={e => setNewDevicePassword(e.target.value)}
                placeholder="至少 8 碼"
                className="px-3 py-1.5 rounded-lg border border-sg-line bg-sg-bg text-sm text-sg-ink"
              />
            </label>
            <button
              type="submit"
              data-testid="create-device-submit"
              disabled={creatingDevice}
              className="px-4 py-1.5 rounded-full bg-sg-brown text-sg-paper text-sm font-bold"
            >
              {creatingDevice ? '建立中...' : '確認新增'}
            </button>
          </form>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {devices.map(dev => {
            const seen = formatLastSeen(dev.last_seen_at);
            const busy = Boolean(deviceActionBusy[dev.id]);
            return (
              <div
                key={dev.id}
                data-testid={`display-device-card-${dev.id}`}
                className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-3 shadow-warm"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-display text-lg font-bold text-sg-ink">{dev.name}</h3>
                    <p className="text-xs text-sg-muted mt-0.5">裝置編號 #{dev.id} · Chrome 全螢幕 · 只能看顯示內容</p>
                  </div>
                  <span
                    className={`px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap ${
                      seen.online
                        ? 'bg-sg-sage-soft text-sg-sage-ink'
                        : 'bg-sg-full-soft text-sg-muted'
                    }`}
                  >
                    {seen.label}
                  </span>
                </div>

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  <dt className="text-sg-muted">現在顯示</dt>
                  <dd className="font-bold text-sg-ink">
                    {VIEW_LABELS[dev.current_view] || dev.current_view || '—'}
                  </dd>
                  <dt className="text-sg-muted">最近 IP</dt>
                  <dd className="text-sg-ink">{dev.last_ip || '—'}</dd>
                </dl>

                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    data-testid={`device-reload-btn-${dev.id}`}
                    disabled={busy}
                    onClick={() => handleReloadDevice(dev.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-sg-line bg-sg-paper text-xs font-bold text-sg-ink hover:bg-sg-bg"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    讓顯示屏重新整理
                  </button>
                  <button
                    type="button"
                    data-testid={`device-logout-btn-${dev.id}`}
                    disabled={busy}
                    onClick={() => handleLogoutDevice(dev.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-sg-line bg-sg-paper text-xs font-bold text-sg-danger hover:bg-sg-danger-soft"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    登出這台
                  </button>
                  <button
                    type="button"
                    data-testid={`device-pw-toggle-${dev.id}`}
                    disabled={busy}
                    onClick={() => {
                      setPwEditDeviceId(pwEditDeviceId === dev.id ? null : dev.id);
                      setPwEditValue('');
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full border border-sg-line bg-sg-paper text-xs font-bold text-sg-ink hover:bg-sg-bg"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    改顯示屏密碼
                  </button>
                </div>

                {pwEditDeviceId === dev.id && (
                  <div className="flex items-center gap-2 pt-2 border-t border-sg-line">
                    <input
                      type="password"
                      data-testid={`device-pw-input-${dev.id}`}
                      value={pwEditValue}
                      onChange={e => setPwEditValue(e.target.value)}
                      placeholder="輸入新密碼（至少 8 碼）"
                      className="flex-1 px-3 py-1.5 rounded-lg border border-sg-line bg-sg-bg text-xs"
                    />
                    <button
                      type="button"
                      data-testid={`device-pw-save-${dev.id}`}
                      disabled={busy}
                      onClick={() => handleUpdateDevicePassword(dev.id)}
                      className="px-3 py-1.5 rounded-full bg-sg-brown text-sg-paper text-xs font-bold"
                    >
                      確認變更
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 2. Schedule by Day Type (Display column only) */}
      <section
        data-testid="display-schedule-section"
        className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-3 shadow-warm"
      >
        <h2 className="font-display text-lg font-bold text-sg-ink">依日期類型排程</h2>
        <p className="text-xs text-sg-muted">
          每一天屬於哪一類由系統自動判斷（沒有時段為公休日、勾選半自助為半自助日、週六日為假日、其餘為平日）。
        </p>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm min-w-[680px]">
            <thead>
              <tr className="border-b border-sg-line text-left text-xs text-sg-muted">
                <th className="py-2 pr-3 font-medium">日期類型</th>
                <th className="py-2 px-2 font-medium">開關方式</th>
                <th className="py-2 px-2 font-medium">時間</th>
                <th className="py-2 pl-2 font-medium">開著時顯示</th>
              </tr>
            </thead>
            <tbody>
              {['self', 'weekday', 'holiday', 'closed'].map(dt => {
                const rule = settings.schedule[dt] || {};
                const meta = DAY_LABELS[dt];
                return (
                  <tr key={dt} className="border-b border-sg-line last:border-b-0">
                    <td className="py-3 pr-3">
                      <div className="font-bold text-sg-ink">{meta.name}</div>
                      <div className="text-xs text-sg-muted">{meta.sub}</div>
                    </td>
                    <td className="py-3 px-2">
                      <select
                        value={rule.mode || 'never'}
                        onChange={e => updateScheduleField(dt, 'mode', e.target.value)}
                        className="px-2.5 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm"
                      >
                        {MODE_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-2">
                      {rule.mode === 'biz' && (
                        <div className="flex flex-wrap items-center gap-1.5 text-sm">
                          <span>提早</span>
                          <input
                            type="number"
                            min={0}
                            max={180}
                            value={rule.before ?? 0}
                            onChange={e => updateScheduleField(dt, 'before', Number(e.target.value) || 0)}
                            className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                          />
                          <span>分開，延後</span>
                          <input
                            type="number"
                            min={0}
                            max={240}
                            value={rule.after ?? 0}
                            onChange={e => updateScheduleField(dt, 'after', Number(e.target.value) || 0)}
                            className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                          />
                          <span>分關</span>
                        </div>
                      )}
                      {rule.mode === 'fixed' && (
                        <div className="flex items-center gap-2 text-sm">
                          <input
                            type="time"
                            value={rule.on || '10:00'}
                            onChange={e => updateScheduleField(dt, 'on', e.target.value)}
                            className="px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                          />
                          <span>到</span>
                          <input
                            type="time"
                            value={rule.off || '21:00'}
                            onChange={e => updateScheduleField(dt, 'off', e.target.value)}
                            className="px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                          />
                        </div>
                      )}
                      {rule.mode === 'always' && <span className="text-xs text-sg-muted">24 小時</span>}
                      {rule.mode === 'never' && <span className="text-xs text-sg-muted">整天熄滅</span>}
                    </td>
                    <td className="py-3 pl-2">
                      <select
                        value={rule.content || 'off'}
                        onChange={e => updateScheduleField(dt, 'content', e.target.value)}
                        className="px-2.5 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm"
                      >
                        {CONTENT_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="border-l-[3px] border-sg-peach bg-sg-peach-soft text-sg-peach-ink text-xs px-3 py-2 rounded-r-lg">
          「跟營業時段」：用當天第一個時段開始往前、最後一個時段結束往後的分鐘數決定開關；關閉時段螢幕全黑。
        </div>
      </section>

      {/* 3. Floor Map & Right Info Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section
          data-testid="display-map-section"
          className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-4 shadow-warm"
        >
          <div>
            <h2 className="font-display text-lg font-bold text-sg-ink">平面圖與計時</h2>
            <p className="text-xs text-sg-muted mt-0.5">
              顯示屏放在櫃檯，方向和門口報到機分開設定。
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {ROTATION_OPTIONS.map(({ deg, label }) => {
              const selected = Number(settings.map_rotation) === deg;
              return (
                <button
                  key={deg}
                  type="button"
                  data-testid={`display-rot-btn-${deg}`}
                  aria-pressed={selected}
                  onClick={() => setSettings(prev => ({ ...prev, map_rotation: deg }))}
                  className={`border-2 rounded-xl p-2 flex flex-col items-center gap-1.5 text-xs font-medium transition ${
                    selected
                      ? 'border-sg-brown bg-sg-brown-soft text-sg-brown font-bold'
                      : 'border-sg-line bg-sg-bg text-sg-ink hover:border-sg-brown/40'
                  }`}
                >
                  <div className="w-full aspect-[16/10] bg-sg-paper rounded-lg overflow-hidden flex items-center justify-center">
                    {floorMap ? (
                      <DisplayFloorMap floor={floorMap} rotation={deg} mini className="w-full h-full" />
                    ) : (
                      <span className="text-[11px] text-sg-muted">{deg}°</span>
                    )}
                  </div>
                  <span className="text-center leading-tight">{label}</span>
                </button>
              );
            })}
          </div>

          <label className="flex flex-col gap-1 text-xs text-sg-muted">
            顯示屏放在哪裡（地圖上標「你在這裡」）
            <select
              data-testid="display-here-select"
              value={settings.here_element || ''}
              onChange={e => setSettings(prev => ({ ...prev, here_element: e.target.value }))}
              className="px-3 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm text-sg-ink"
            >
              <option value="">不標示</option>
              {hereOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            <div className="space-y-1.5">
              <div className="text-xs text-sg-muted">每個座位顯示</div>
              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="radio"
                  name="time_mode"
                  checked={settings.time_mode === 'remain'}
                  onChange={() => setSettings(prev => ({ ...prev, time_mode: 'remain' }))}
                  className="accent-sg-brown"
                />
                剩餘時間（不限時顯示已用時間）
              </label>
              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="radio"
                  name="time_mode"
                  checked={settings.time_mode === 'used'}
                  onChange={() => setSettings(prev => ({ ...prev, time_mode: 'used' }))}
                  className="accent-sg-brown"
                />
                已用時間
              </label>
            </div>

            <div className="space-y-2.5">
              <label className="flex flex-col gap-1 text-xs text-sg-muted">
                剩幾分鐘時變成黃色
                <span className="flex items-center gap-1.5 text-sm text-sg-ink">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={settings.soon_minutes}
                    onChange={e => setSettings(prev => ({ ...prev, soon_minutes: Number(e.target.value) || 10 }))}
                    className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                  />
                  分鐘
                </span>
              </label>

              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(settings.fallback_to_slides)}
                  onChange={e => setSettings(prev => ({ ...prev, fallback_to_slides: e.target.checked }))}
                  className="accent-sg-brown w-4 h-4"
                />
                沒有任何人入座時，改播輪播
              </label>
            </div>
          </div>

          <div className="pt-2 border-t border-sg-line space-y-2">
            <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings.closing_warn)}
                onChange={e => setSettings(prev => ({ ...prev, closing_warn: e.target.checked }))}
                className="accent-sg-brown w-4 h-4"
              />
              打烊前提醒收拾
            </label>
            <div className="flex items-center gap-1.5 text-sm text-sg-ink pl-6">
              <span>打烊前</span>
              <input
                type="number"
                min={5}
                max={120}
                value={settings.closing_minutes}
                onChange={e => setSettings(prev => ({ ...prev, closing_minutes: Number(e.target.value) || 30 }))}
                className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
              />
              <span>分鐘開始，底部改成提醒</span>
            </div>
          </div>
        </section>

        <section
          data-testid="display-cards-section"
          className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-4 shadow-warm flex flex-col justify-between"
        >
          <div className="space-y-3">
            <div>
              <h2 className="font-display text-lg font-bold text-sg-ink">右側資訊卡</h2>
              <p className="text-xs text-sg-muted mt-0.5">
                平面圖右邊輪流顯示。內容定期更換，也可降低固定文字烙印風險。
              </p>
            </div>

            <div className="space-y-2.5 pt-1">
              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.cards?.seats !== false}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    cards: { ...prev.cards, seats: e.target.checked }
                  }))}
                  className="accent-sg-brown w-4 h-4"
                />
                現在可以入座（空位數、下一批空位時間）
              </label>

              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.cards?.soon !== false}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    cards: { ...prev.cards, soon: e.target.checked }
                  }))}
                  className="accent-sg-brown w-4 h-4"
                />
                時間快到了（座位與智能板）
              </label>

              <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.cards?.price !== false}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    cards: { ...prev.cards, price: e.target.checked }
                  }))}
                  className="accent-sg-brown w-4 h-4"
                />
                今日價目（依當天價格自動帶入）
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs text-sg-muted pt-2">
              每張停留
              <span className="flex items-center gap-1.5 text-sm text-sg-ink">
                <input
                  type="number"
                  min={5}
                  max={60}
                  value={settings.card_seconds}
                  onChange={e => setSettings(prev => ({ ...prev, card_seconds: Number(e.target.value) || 12 }))}
                  className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
                />
                秒
              </span>
            </label>
          </div>

          <div
            data-testid="display-burnin-section"
            className="pt-4 border-t border-sg-line space-y-2"
          >
            <h3 className="font-display text-base font-bold text-sg-ink">OLED 防烙印保護</h3>
            <label className="flex items-center gap-1.5 text-sm text-sg-ink">
              <span>畫面整體每</span>
              <input
                type="number"
                min={1}
                max={60}
                value={settings.shift_minutes}
                onChange={e => setSettings(prev => ({ ...prev, shift_minutes: Number(e.target.value) || 3 }))}
                className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
              />
              <span>分鐘微移 1～8 像素（關閉時段不移動）</span>
            </label>
          </div>
        </section>
      </div>

      {/* 4. Half-Self-Service Day & Announcements / General Slides */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section
          data-testid="display-self-section"
          className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-4 shadow-warm"
        >
          <div>
            <h2 className="font-display text-lg font-bold text-sg-ink">半自助日</h2>
            <p className="text-xs text-sg-muted mt-0.5">
              左邊輪播，右邊固定 LINE 條碼和注意事項（LINE ID 與連結沿用報到機設定）。
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-2.5 rounded-xl bg-sg-bg border border-sg-line">
              <div className="text-sg-muted">LINE ID（沿用報到機）</div>
              <div className="font-bold text-sg-ink mt-0.5 truncate">{lineInfo.line_id || '未設定'}</div>
            </div>
            <div className="p-2.5 rounded-xl bg-sg-bg border border-sg-line">
              <div className="text-sg-muted">LINE 連結（沿用報到機）</div>
              <div className="font-bold text-sg-ink mt-0.5 truncate">{lineInfo.line_url || '未設定'}</div>
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs text-sg-muted">
            條碼上方的文字
            <input
              type="text"
              value={settings.line_title || ''}
              onChange={e => setSettings(prev => ({ ...prev, line_title: e.target.value }))}
              className="px-3 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm text-sg-ink"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-sg-muted">
            注意事項（一行一條，最多 5 條）
            <textarea
              rows={5}
              data-testid="display-notices-textarea"
              value={noticesText}
              onChange={e => setNoticesText(e.target.value)}
              className="px-3 py-2 rounded-lg border border-sg-line bg-sg-paper text-sm text-sg-ink"
            />
          </label>

          {renderSlideSection('self', selfSlides)}
        </section>

        <section
          data-testid="display-announcements-section"
          className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-4 shadow-warm"
        >
          <h2 className="font-display text-lg font-bold text-sg-ink">公告與一般輪播</h2>

          <label className="flex flex-col gap-1 text-xs text-sg-muted">
            底部公告（一行一則，最多 10 則，輪流顯示）
            <textarea
              rows={4}
              data-testid="display-announcements-textarea"
              value={announcementsText}
              onChange={e => setAnnouncementsText(e.target.value)}
              className="px-3 py-2 rounded-lg border border-sg-line bg-sg-paper text-sm text-sg-ink"
            />
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-sm text-sg-ink">
              <span className="text-xs text-sg-muted">每則停留</span>
              <input
                type="number"
                min={5}
                max={60}
                value={settings.announcement_seconds}
                onChange={e => setSettings(prev => ({ ...prev, announcement_seconds: Number(e.target.value) || 10 }))}
                className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
              />
              <span>秒</span>
            </label>

            <label className="flex items-center gap-2 text-sm text-sg-ink cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings.show_line_mini)}
                onChange={e => setSettings(prev => ({ ...prev, show_line_mini: e.target.checked }))}
                className="accent-sg-brown w-4 h-4"
              />
              底部右側顯示 LINE 小條碼
            </label>
          </div>

          <label className="flex items-center gap-1.5 text-sm text-sg-ink">
            <span className="text-xs text-sg-muted">輪播每張預設停留</span>
            <input
              type="number"
              min={4}
              max={60}
              value={settings.slide_seconds}
              onChange={e => setSettings(prev => ({ ...prev, slide_seconds: Number(e.target.value) || 8 }))}
              className="w-16 px-2 py-1 rounded-lg border border-sg-line bg-sg-paper"
            />
            <span>秒</span>
          </label>

          {renderSlideSection('general', generalSlides)}
        </section>
      </div>

      {/* 5. Special Dates */}
      <section
        data-testid="display-special-dates-section"
        className="bg-sg-paper border border-sg-line rounded-[18px] p-5 space-y-3 shadow-warm"
      >
        <div>
          <h2 className="font-display text-lg font-bold text-sg-ink">特殊日期</h2>
          <p className="text-xs text-sg-muted mt-0.5">
            某一天要延後或提前關閉時加在這裡，優先於上面的排程關閉時間。
          </p>
        </div>

        <div className="space-y-1.5">
          {(settings.special_dates || []).length > 0 ? (
            settings.special_dates.map((sp, idx) => (
              <div
                key={`${sp.date}-${idx}`}
                className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-sg-bg text-sm"
              >
                <span>
                  <b className="text-sg-ink mr-3">{sp.date}</b>
                  <span className="text-sg-muted">{sp.note || '特殊營業'} · 延到 {sp.off} 關</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveSpecialDate(idx)}
                  className="px-3 py-1 rounded-full border border-sg-line bg-sg-paper text-xs font-bold text-sg-danger"
                >
                  移除
                </button>
              </div>
            ))
          ) : (
            <div className="px-3 py-2 rounded-lg bg-sg-bg text-xs text-sg-muted">目前沒有特殊日期</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <input
            type="date"
            value={spDate}
            onChange={e => setSpDate(e.target.value)}
            aria-label="特殊日期"
            className="px-2.5 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm"
          />
          <input
            type="time"
            value={spOff}
            onChange={e => setSpOff(e.target.value)}
            aria-label="關閉時間"
            className="px-2.5 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm"
          />
          <input
            type="text"
            value={spNote}
            onChange={e => setSpNote(e.target.value)}
            placeholder="說明（例如：跨年延長營業）"
            aria-label="說明"
            className="px-3 py-1.5 rounded-lg border border-sg-line bg-sg-paper text-sm w-56"
          />
          <button
            type="button"
            onClick={handleAddSpecialDate}
            className="px-4 py-1.5 rounded-full border border-sg-line bg-sg-paper text-sm font-bold text-sg-ink hover:bg-sg-bg"
          >
            加入
          </button>
        </div>
      </section>
    </div>
  );
}

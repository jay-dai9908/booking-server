import React, { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { 
  Cpu, 
  Settings, 
  Save, 
  AlertTriangle, 
  Check, 
  Plus, 
  Trash2, 
  Calendar, 
  Info, 
  Layers,
  Wrench,
  Eye,
  EyeOff
} from 'lucide-react';
import api from '../../api/axios';

export default function EquipmentPage() {
  const [configs, setConfigs] = useState([]);
  const [globalSettings, setGlobalSettings] = useState({ 
    allow_equipment_exceed_pax: false,
    show_equipment_live_stock: true
  });
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [conflictWarnings, setConflictWarnings] = useState(null);
  const [successToast, setSuccessToast] = useState('');

  // Real-time Occupancy section state
  const [occupancyDate, setOccupancyDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [occupancyData, setOccupancyData] = useState(null);
  const [loadingOccupancy, setLoadingOccupancy] = useState(false);

  // New Config Modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [newConfig, setNewConfig] = useState({
    id: '',
    name: '',
    visibility_status: 'ACTIVE',
    status_note: '',
    total_stock: 5,
    hourly_rate: 100,
    daily_cap: 500,
    min_contiguous_hours: 2,
    sort_order: 10
  });

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/equipment/admin');
      setConfigs(res.data.configs || []);
      setGlobalSettings({
        allow_equipment_exceed_pax: !!res.data.allow_equipment_exceed_pax,
        show_equipment_live_stock: res.data.show_equipment_live_stock !== false
      });
    } catch (err) {
      console.error('Failed to fetch equipment configs:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchOccupancy = async (dateStr) => {
    setLoadingOccupancy(true);
    try {
      const res = await api.get(`/equipment/admin/occupancy?date=${dateStr}`);
      setOccupancyData(res.data);
    } catch (err) {
      console.error('Failed to fetch occupancy:', err);
    } finally {
      setLoadingOccupancy(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (occupancyDate) {
      fetchOccupancy(occupancyDate);
    }
  }, [occupancyDate]);

  const showToast = (msg) => {
    setSuccessToast(msg);
    setTimeout(() => setSuccessToast(''), 3000);
  };

  const handleConfigChange = (id, field, value) => {
    setConfigs(prev => prev.map(c => {
      if (c.id === id) {
        return { ...c, [field]: value };
      }
      return c;
    }));
  };

  const handleSaveConfig = async (config) => {
    setSavingId(config.id);
    try {
      const payload = {
        name: config.name,
        visibility_status: config.visibility_status,
        status_note: config.status_note,
        total_stock: config.id === 'bring_own' ? null : parseInt(config.total_stock, 10),
        hourly_rate: parseInt(config.hourly_rate, 10),
        daily_cap: (config.daily_cap === null || config.daily_cap === '' || isNaN(parseInt(config.daily_cap, 10)) || parseInt(config.daily_cap, 10) <= 0) ? null : parseInt(config.daily_cap, 10),
        min_contiguous_hours: parseInt(config.min_contiguous_hours, 10)
      };

      const res = await api.put(`/equipment/admin/${config.id}`, payload);

      if (res.data.warnings && res.data.warnings.length > 0) {
        setConflictWarnings(res.data.warnings);
      } else {
        showToast(`已儲存「${config.name}」設定`);
      }
      fetchData();
      fetchOccupancy(occupancyDate);
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || '儲存設定失敗');
    } finally {
      setSavingId(null);
    }
  };

  const handleToggleGlobalSetting = async (key, val) => {
    setSavingGlobal(true);
    try {
      await api.patch('/equipment/admin/settings', {
        [key]: val
      });
      setGlobalSettings(prev => ({ ...prev, [key]: val }));
      showToast('已更新全域設備設定');
    } catch (err) {
      console.error(err);
      alert('更新設定失敗');
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleCreateConfig = async (e) => {
    e.preventDefault();
    if (!newConfig.id || !newConfig.name) {
      alert('請填寫規格ID與名稱');
      return;
    }
    try {
      await api.post('/equipment/admin', {
        ...newConfig,
        total_stock: parseInt(newConfig.total_stock, 10),
        hourly_rate: parseInt(newConfig.hourly_rate, 10),
        daily_cap: (newConfig.daily_cap === null || newConfig.daily_cap === '' || isNaN(parseInt(newConfig.daily_cap, 10)) || parseInt(newConfig.daily_cap, 10) <= 0) ? null : parseInt(newConfig.daily_cap, 10),
        min_contiguous_hours: parseInt(newConfig.min_contiguous_hours, 10)
      });
      setShowAddModal(false);
      showToast(`已新增規格「${newConfig.name}」`);
      fetchData();
    } catch (err) {
      alert(err.response?.data?.error || '新增規格失敗');
    }
  };

  const handleDeleteConfig = async (id, name) => {
    if (['pegboard_s', 'pegboard_m', 'pegboard_l', 'bring_own'].includes(id)) {
      alert('系統核心預設規格不可刪除，若不想開放請切換為「前台隱藏」');
      return;
    }
    if (window.confirm(`確定要刪除規格「${name}」嗎？此操作不可復原。`)) {
      try {
        await api.delete(`/equipment/admin/${id}`);
        showToast(`已刪除規格「${name}」`);
        fetchData();
      } catch (err) {
        alert(err.response?.data?.error || '刪除失敗');
      }
    }
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-8">
      {/* Toast Notification */}
      {successToast && (
        <div className="fixed top-6 right-6 z-50 bg-emerald-700 text-white px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 text-sm font-bold animate-in fade-in slide-in-from-top-4 duration-200">
          <Check className="w-4 h-4" />
          <span>{successToast}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-gray-200 pb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <span className="p-2.5 rounded-2xl bg-[#F4EFE6] text-[#8B5B43]">
              <Cpu className="w-6 h-6" />
            </span>
            <h1 className="text-2xl font-bold text-[#2C241E]">
              智能拼豆板與設備庫存管理
            </h1>
          </div>
          <p className="text-sm text-gray-500">
            動態調整小板、中板、大板與自帶設備之實體庫存、時租費率、單日上限與前台顯示/維護狀態。
          </p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-2 bg-[#8B5B43] hover:bg-[#724a35] text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm transition-colors self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" /> 新增自訂規格
        </button>
      </div>

      {/* Global Settings Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Setting 1: Pax Quota Rule */}
        <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="p-2 bg-white text-[#8B5B43] rounded-xl border border-[#E8DEC8] shrink-0 mt-0.5">
              <Settings className="w-4 h-4" />
            </span>
            <div>
              <h3 className="font-bold text-[#3E332B] text-sm">
                單單總設備上限規則
              </h3>
              <p className="text-xs text-[#7A7067] mt-0.5 leading-relaxed">
                {globalSettings.allow_equipment_exceed_pax
                  ? '允許超過預約人數（可任意自由加購）'
                  : '預約總台數不可超過訂單人數（防霸佔）'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold text-[#4A3F35]">
              {globalSettings.allow_equipment_exceed_pax ? '無人數限制' : '限制人數'}
            </span>
            <div 
              onClick={() => !savingGlobal && handleToggleGlobalSetting('allow_equipment_exceed_pax', !globalSettings.allow_equipment_exceed_pax)}
              className={`relative w-[44px] h-[24px] rounded-full transition-colors duration-300 cursor-pointer ${
                globalSettings.allow_equipment_exceed_pax ? 'bg-amber-600' : 'bg-[#8B5B43]'
              }`}
            >
              <div className={`absolute top-[2px] left-[2px] bg-white w-[20px] h-[20px] rounded-full shadow-sm transition-transform duration-300 ${
                globalSettings.allow_equipment_exceed_pax ? 'translate-x-[20px]' : 'translate-x-0'
              }`} />
            </div>
          </div>
        </div>

        {/* Setting 2: Customer Live Stock Visibility */}
        <div className="bg-[#FAF7F2] border border-[#E8DEC8] rounded-2xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="p-2 bg-white text-[#8B5B43] rounded-xl border border-[#E8DEC8] shrink-0 mt-0.5">
              <Eye className="w-4 h-4" />
            </span>
            <div>
              <h3 className="font-bold text-[#3E332B] text-sm">
                顧客端即時庫存狀況卡片
              </h3>
              <p className="text-xs text-[#7A7067] mt-0.5 leading-relaxed">
                {globalSettings.show_equipment_live_stock !== false
                  ? '顧客預約頁顯示頂部「✨ 即時庫存狀況」'
                  : '已在顧客預約頁隱藏即時庫存狀況卡片'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[11px] font-bold text-[#4A3F35]">
              {globalSettings.show_equipment_live_stock !== false ? '顯示庫存' : '隱藏卡片'}
            </span>
            <div 
              onClick={() => !savingGlobal && handleToggleGlobalSetting('show_equipment_live_stock', globalSettings.show_equipment_live_stock === false)}
              className={`relative w-[44px] h-[24px] rounded-full transition-colors duration-300 cursor-pointer ${
                globalSettings.show_equipment_live_stock !== false ? 'bg-[#8B5B43]' : 'bg-gray-300'
              }`}
            >
              <div className={`absolute top-[2px] left-[2px] bg-white w-[20px] h-[20px] rounded-full shadow-sm transition-transform duration-300 ${
                globalSettings.show_equipment_live_stock !== false ? 'translate-x-[20px]' : 'translate-x-0'
              }`} />
            </div>
          </div>
        </div>
      </div>

      {/* Equipment Config Cards Grid */}
      <div>
        <h2 className="text-lg font-bold text-[#2C241E] mb-4 flex items-center gap-2">
          <Layers className="w-5 h-5 text-[#8B5B43]" /> 規格參數與前台狀態設定
        </h2>

        {loading ? (
          <div className="text-center py-16 text-gray-400">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#8B5B43] mx-auto mb-2"></div>
            載入規格設定中...
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {configs.map(config => {
              const isBringOwn = config.id === 'bring_own';
              const isSaving = savingId === config.id;

              return (
                <div 
                  key={config.id}
                  className="bg-white rounded-2xl border border-gray-200/90 shadow-sm p-5 space-y-4 hover:shadow-md transition-shadow relative"
                >
                  {/* Card Header & 3-State Segmented Control */}
                  <div className="space-y-3 border-b border-gray-100 pb-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-lg text-gray-900">{config.name}</span>
                        <span className="text-xs font-mono text-gray-400 bg-gray-50 px-2 py-0.5 rounded border border-gray-200">
                          {config.id}
                        </span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {isBringOwn ? '顧客自備充電服務費' : '店內實體租賃設備'}
                      </p>
                    </div>

                    {/* 3-State Segmented Control (Wrapped to full-width row) */}
                    <div className="flex items-center justify-between bg-gray-100 p-1 rounded-xl text-xs font-bold w-full gap-1">
                      <button
                        type="button"
                        onClick={() => handleConfigChange(config.id, 'visibility_status', 'ACTIVE')}
                        className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all whitespace-nowrap ${
                          config.visibility_status === 'ACTIVE' 
                            ? 'bg-emerald-600 text-white shadow-sm' 
                            : 'text-gray-600 hover:text-gray-900'
                        }`}
                        title="前台正常顯示並開放預約"
                      >
                        🟢 開放
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfigChange(config.id, 'visibility_status', 'MAINTENANCE')}
                        className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all whitespace-nowrap ${
                          config.visibility_status === 'MAINTENANCE' 
                            ? 'bg-amber-600 text-white shadow-sm' 
                            : 'text-gray-600 hover:text-gray-900'
                        }`}
                        title="前台顯示但反灰標記維護中"
                      >
                        🟠 維護
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfigChange(config.id, 'visibility_status', 'HIDDEN')}
                        className={`flex-1 py-1.5 px-2 rounded-lg text-center transition-all whitespace-nowrap ${
                          config.visibility_status === 'HIDDEN' 
                            ? 'bg-gray-600 text-white shadow-sm' 
                            : 'text-gray-600 hover:text-gray-900'
                        }`}
                        title="前台完全隱藏不顯示"
                      >
                        ⚪ 隱藏
                      </button>
                    </div>
                  </div>

                  {/* Status Note input if MAINTENANCE */}
                  {config.visibility_status === 'MAINTENANCE' && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
                      <label className="text-xs font-bold text-amber-900 flex items-center gap-1">
                        <Wrench className="w-3.5 h-3.5 text-amber-700" /> 前台反灰維護提示字：
                      </label>
                      <input
                        type="text"
                        value={config.status_note || ''}
                        onChange={(e) => handleConfigChange(config.id, 'status_note', e.target.value)}
                        placeholder="例：🔧 設備維修保養中，暫停借用"
                        className="w-full text-xs px-3 py-1.5 border border-amber-300 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      />
                    </div>
                  )}

                  {/* Numeric Inputs */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    {/* Stock */}
                    <div className="bg-gray-50/70 p-3 rounded-xl border border-gray-100">
                      <label className="text-gray-500 font-medium block mb-1">店內可用總庫存</label>
                      {isBringOwn ? (
                        <div className="font-bold text-gray-700 text-sm py-1">不限店內庫存</div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min="0"
                            value={config.total_stock ?? 0}
                            onChange={(e) => handleConfigChange(config.id, 'total_stock', e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg font-bold text-sm text-gray-800 bg-white"
                          />
                          <span className="text-gray-500 font-bold shrink-0">台</span>
                        </div>
                      )}
                    </div>

                    {/* Hourly Rate */}
                    <div className="bg-gray-50/70 p-3 rounded-xl border border-gray-100">
                      <label className="text-gray-500 font-medium block mb-1">每小時租金</label>
                      <div className="flex items-center gap-1">
                        <span className="text-gray-500 font-bold shrink-0">NT$</span>
                        <input
                          type="number"
                          min="0"
                          value={config.hourly_rate ?? 0}
                          onChange={(e) => handleConfigChange(config.id, 'hourly_rate', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg font-bold text-sm text-gray-800 bg-white"
                        />
                      </div>
                    </div>

                    {/* Daily Cap */}
                    <div className="bg-gray-50/70 p-3 rounded-xl border border-gray-100 flex flex-col justify-between">
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-gray-600 font-medium text-xs">單台單日收費上限</label>
                        <button
                          type="button"
                          onClick={() => {
                            const isCurrentlyUnlimited = config.daily_cap === null || config.daily_cap === '' || parseInt(config.daily_cap, 10) <= 0;
                            handleConfigChange(config.id, 'daily_cap', isCurrentlyUnlimited ? 500 : null);
                          }}
                          className={`text-[11px] px-2 py-0.5 rounded-full font-bold transition-all flex items-center gap-1 cursor-pointer select-none ${
                            config.daily_cap === null || config.daily_cap === '' || parseInt(config.daily_cap, 10) <= 0
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${config.daily_cap === null || config.daily_cap === '' || parseInt(config.daily_cap, 10) <= 0 ? 'bg-amber-600' : 'bg-gray-400'}`}></span>
                          {config.daily_cap === null || config.daily_cap === '' || parseInt(config.daily_cap, 10) <= 0 ? '✨ 無上限 (已隱藏)' : '設為無上限'}
                        </button>
                      </div>

                      {config.daily_cap === null || config.daily_cap === '' || parseInt(config.daily_cap, 10) <= 0 ? (
                        <div className="py-1 px-2.5 bg-amber-50/80 border border-amber-200 rounded-lg text-xs font-bold text-amber-800 flex items-center justify-between">
                          <span>無上限 (依時數計費)</span>
                          <span className="text-[10px] text-amber-600">顧客端隱藏上限</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-gray-500 font-bold shrink-0 text-xs">NT$</span>
                          <input
                            type="number"
                            min="1"
                            value={config.daily_cap ?? ''}
                            onChange={(e) => handleConfigChange(config.id, 'daily_cap', e.target.value)}
                            placeholder="請輸入上限金額"
                            className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg font-bold text-sm text-gray-800 bg-white"
                          />
                        </div>
                      )}
                    </div>

                    {/* Min Hours */}
                    <div className="bg-gray-50/70 p-3 rounded-xl border border-gray-100">
                      <label className="text-gray-500 font-medium block mb-1">最低連續租借時數</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="1"
                          max="8"
                          value={config.min_contiguous_hours ?? 2}
                          onChange={(e) => handleConfigChange(config.id, 'min_contiguous_hours', e.target.value)}
                          className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg font-bold text-sm text-gray-800 bg-white"
                        />
                        <span className="text-gray-500 font-bold shrink-0">小時</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Actions */}
                  <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                    {!['pegboard_s', 'pegboard_m', 'pegboard_l', 'bring_own'].includes(config.id) ? (
                      <button
                        type="button"
                        onClick={() => handleDeleteConfig(config.id, config.name)}
                        className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1 p-1 font-medium"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> 刪除規格
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-400">系統核心規格</span>
                    )}

                    <button
                      type="button"
                      disabled={isSaving}
                      onClick={() => handleSaveConfig(config)}
                      className="px-4 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold shadow-sm transition-colors flex items-center gap-1.5 disabled:opacity-50 ml-auto"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {isSaving ? '儲存中...' : '儲存變更'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Real-time Occupancy Section */}
      <div className="bg-white rounded-2xl border border-gray-200/90 shadow-sm p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
          <div>
            <h2 className="text-lg font-bold text-[#2C241E] flex items-center gap-2">
              <Calendar className="w-5 h-5 text-[#8B5B43]" /> 各時段設備佔用狀況
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              檢視指定日期中，各營業時段的智能拼豆板租借比例與剩餘數量。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-bold">查詢日期：</span>
            <input
              type="date"
              value={occupancyDate}
              onChange={(e) => setOccupancyDate(e.target.value)}
              className="px-3 py-1.5 border border-gray-300 rounded-xl text-xs font-bold text-gray-800 bg-[#FAF7F2]"
            />
          </div>
        </div>

        {loadingOccupancy ? (
          <div className="text-center py-10 text-gray-400 text-sm">載入即時佔用中...</div>
        ) : !occupancyData || !occupancyData.sessions || occupancyData.sessions.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">此日期尚無營業時段資料</div>
        ) : (
          <div className="space-y-3">
            {occupancyData.sessions.map(s => {
              const sessionOcc = (occupancyData.occupancy && occupancyData.occupancy[s.id]) || {};

              return (
                <div 
                  key={s.id}
                  className="p-3.5 rounded-xl border border-gray-100 bg-[#FDFCFA] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-sm text-[#2C241E] bg-[#F4EFE6] px-2.5 py-1 rounded-lg">
                      {s.start_time} - {s.end_time}
                    </span>
                    <span className="text-xs text-gray-400 font-medium">
                      座位預約率：{s.max_capacity - s.remaining_capacity} / {s.max_capacity} 人
                    </span>
                  </div>

                  {/* Equipment Badges */}
                  <div className="flex items-center flex-wrap gap-2 text-xs">
                    {(occupancyData.configs || []).filter(c => c.id !== 'bring_own').map(c => {
                      const booked = sessionOcc[c.id] || 0;
                      const total = c.total_stock || 0;
                      const isFull = total > 0 && booked >= total;

                      return (
                        <span 
                          key={c.id}
                          className={`px-2.5 py-1 rounded-lg font-bold border ${
                            isFull 
                              ? 'bg-red-50 text-red-700 border-red-200' 
                              : booked > 0 
                                ? 'bg-amber-50 text-amber-800 border-amber-200' 
                                : 'bg-gray-50 text-gray-600 border-gray-200'
                          }`}
                        >
                          {c.name}: {booked}/{total} {isFull ? '(滿)' : ''}
                        </span>
                      );
                    })}
                    {sessionOcc['bring_own'] > 0 && (
                      <span className="px-2.5 py-1 rounded-lg font-bold bg-blue-50 text-blue-700 border border-blue-200">
                        自帶板: {sessionOcc['bring_own']} 台
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Stock Reduction / Hidden Conflict Warning Modal */}
      {conflictWarnings && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setConflictWarnings(null)} />
          <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-2xl overflow-hidden relative z-10 flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
            <div className="px-6 py-5 border-b border-amber-200 bg-amber-50 flex items-center justify-between">
              <div className="flex items-center gap-2 text-amber-900 font-bold text-lg">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                <span>庫存調降／隱藏衝突預警！</span>
              </div>
              <button onClick={() => setConflictWarnings(null)} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-full">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              <p className="text-sm text-gray-700 leading-relaxed font-medium">
                ⚠️ 您剛剛調降了庫存或變更了顯示狀態，系統掃描到未來已有以下訂單預約了該規格，且該時段的預約總數已超過您設定的新可用量：
              </p>

              <div className="border border-amber-200 rounded-xl overflow-hidden text-xs">
                <table className="w-full text-left">
                  <thead className="bg-amber-100/60 text-amber-900 font-bold border-b border-amber-200">
                    <tr>
                      <th className="p-3">預約日期 / 時段</th>
                      <th className="p-3">訂單編號</th>
                      <th className="p-3">顧客姓名</th>
                      <th className="p-3">電話</th>
                      <th className="p-3">已預約台數</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-100">
                    {conflictWarnings.map((w, idx) => (
                      <tr key={idx} className="hover:bg-amber-50/40">
                        <td className="p-3 font-medium">{w.date} {w.session}</td>
                        <td className="p-3 font-mono text-gray-600">{w.booking_ref.slice(0, 8)}...</td>
                        <td className="p-3 font-bold text-gray-900">{w.customer_name}</td>
                        <td className="p-3 text-gray-600">{w.customer_phone || '無電話'}</td>
                        <td className="p-3 font-bold text-red-600">{w.booked_qty} 台</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="bg-amber-50 p-3.5 rounded-xl border border-amber-200 text-xs text-amber-800 leading-relaxed">
                💡 <strong>處理建議：</strong> 雖然系統已儲存您的設定，但既有已成立訂單的權益仍受保護。若實體設備確實不足，請主動致電上述受影響顧客協商調整。
              </div>
            </div>

            <div className="p-4 border-t border-gray-100 bg-gray-50 flex justify-end">
              <button
                onClick={() => setConflictWarnings(null)}
                className="px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-sm font-bold shadow-sm transition-colors"
              >
                我知道了，已記錄衝突名單
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Custom Config Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowAddModal(false)} />
          <div className="bg-white rounded-[24px] shadow-2xl w-full max-w-md overflow-hidden relative z-10 p-6 animate-in zoom-in-95 duration-200 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <h3 className="font-bold text-lg text-gray-900">新增自訂智能拼豆板規格</h3>
              <button onClick={() => setShowAddModal(false)} className="p-1 text-gray-400 hover:text-gray-700 rounded-full">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateConfig} className="space-y-3 text-xs">
              <div>
                <label className="block text-gray-600 font-bold mb-1">規格代碼 (ID, 英文小寫數字)</label>
                <input
                  type="text"
                  required
                  placeholder="例：pegboard_xl"
                  value={newConfig.id}
                  onChange={(e) => setNewConfig(prev => ({ ...prev, id: e.target.value.toLowerCase().trim() }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                />
              </div>

              <div>
                <label className="block text-gray-600 font-bold mb-1">規格名稱</label>
                <input
                  type="text"
                  required
                  placeholder="例：超特大板 (130×130)"
                  value={newConfig.name}
                  onChange={(e) => setNewConfig(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-600 font-bold mb-1">總庫存台數</label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={newConfig.total_stock}
                    onChange={(e) => setNewConfig(prev => ({ ...prev, total_stock: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <label className="block text-gray-600 font-bold mb-1">時租費率 (NT$)</label>
                  <input
                    type="number"
                    min="0"
                    required
                    value={newConfig.hourly_rate}
                    onChange={(e) => setNewConfig(prev => ({ ...prev, hourly_rate: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-gray-600 font-bold text-sm">單台日上限 (NT$)</label>
                    <button
                      type="button"
                      onClick={() => setNewConfig(prev => ({ 
                        ...prev, 
                        daily_cap: prev.daily_cap === null ? 500 : null 
                      }))}
                      className={`text-xs px-2 py-0.5 rounded-full font-bold cursor-pointer ${
                        newConfig.daily_cap === null
                          ? 'bg-amber-100 text-amber-800 border border-amber-300'
                          : 'bg-gray-200 text-gray-600'
                      }`}
                    >
                      {newConfig.daily_cap === null ? '✨ 無上限 (已隱藏)' : '設為無上限'}
                    </button>
                  </div>
                  {newConfig.daily_cap === null ? (
                    <div className="py-2 px-3 bg-amber-50 border border-amber-200 rounded-xl text-xs font-bold text-amber-800">
                      無收費上限（依租借時數累計收費）
                    </div>
                  ) : (
                    <input
                      type="number"
                      min="1"
                      value={newConfig.daily_cap || ''}
                      onChange={(e) => setNewConfig(prev => ({ ...prev, daily_cap: e.target.value }))}
                      placeholder="請輸入上限金額 (NT$)"
                      className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                    />
                  )}
                </div>
                <div>
                  <label className="block text-gray-600 font-bold mb-1">最低連續時數</label>
                  <input
                    type="number"
                    min="1"
                    required
                    value={newConfig.min_contiguous_hours}
                    onChange={(e) => setNewConfig(prev => ({ ...prev, min_contiguous_hours: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-xl text-sm"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-gray-100 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 text-gray-500 font-bold hover:bg-gray-100 rounded-xl"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white font-bold rounded-xl shadow-sm"
                >
                  確認建立
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

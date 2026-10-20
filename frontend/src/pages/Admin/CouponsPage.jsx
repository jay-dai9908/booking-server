import React, { useState, useEffect, useMemo } from 'react';
import { 
  Ticket, 
  Plus, 
  Search, 
  Edit2, 
  Trash2, 
  Check, 
  X, 
  Tag, 
  Calendar, 
  Users, 
  Clock, 
  Sparkles, 
  ShoppingBag, 
  Zap, 
  AlertCircle,
  Percent,
  DollarSign,
  Gift,
  Layers,
  ArrowUpDown
} from 'lucide-react';
import api from '../../api/axios';

const DISCOUNT_TYPE_CONFIG = {
  fixed_order: {
    label: '整單折抵固定金額 ($)',
    shortLabel: '整單折抵',
    unit: 'NT$',
    icon: DollarSign,
    color: 'text-amber-800 bg-amber-50 border-amber-200'
  },
  fixed_per_pax: {
    label: '依人數每人折抵 ($)',
    shortLabel: '每人折抵',
    unit: 'NT$/人',
    icon: Users,
    color: 'text-[#8B5B43] bg-[#FAF7F2] border-[#E8DEC8]'
  },
  percentage: {
    label: '百分比折抵 (% off)',
    shortLabel: '折數優惠',
    unit: '% OFF',
    icon: Percent,
    color: 'text-rose-700 bg-rose-50 border-rose-200'
  },
  free_hours: {
    label: '贈送免費時數 (小時)',
    shortLabel: '贈送時數',
    unit: '小時',
    icon: Clock,
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200'
  }
};

const CHANNEL_CONFIG = {
  all: { label: '全通路通用 (線上+櫃檯)', short: '全通路', color: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  online: { label: '僅限顧客線上預約', short: '線上專用', color: 'bg-blue-50 text-blue-800 border-blue-200' },
  pos: { label: '僅限現場 POS 櫃檯', short: '現場櫃檯', color: 'bg-amber-50 text-amber-900 border-amber-200' }
};

const ADDON_CATEGORIES = {
  charm: { label: '吊飾配件', icon: Sparkles, color: 'text-amber-800 bg-amber-50 border-amber-200' },
  service: { label: '專人服務', icon: Clock, color: 'text-[#8B5B43] bg-[#FAF7F2] border-[#E8DEC8]' },
  other: { label: '其他周邊', icon: ShoppingBag, color: 'text-stone-700 bg-stone-50 border-stone-200' }
};

export default function CouponsPage() {
  const [activeTab, setActiveTab] = useState('coupons'); // 'coupons' | 'addons'
  const [promoCodes, setPromoCodes] = useState([]);
  const [addonItems, setAddonItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toastMsg, setToastMsg] = useState(null);

  // Filters for Coupons
  const [searchQuery, setSearchQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [posOnlyFilter, setPosOnlyFilter] = useState(false);

  // Modal states for Coupons
  const [showPromoModal, setShowPromoModal] = useState(false);
  const [editingPromo, setEditingPromo] = useState(null);
  const [promoForm, setPromoForm] = useState({
    code: '',
    name: '',
    description: '',
    discount_type: 'fixed_order',
    discount_value: 50,
    max_discount_amount: '',
    channel: 'all',
    target_scope: 'all',
    day_type_limit: 'all',
    mode_limit: 'all',
    min_pax: 1,
    min_hours: 1,
    min_amount: 0,
    max_uses: '',
    max_uses_per_user: '',
    start_date: '',
    end_date: '',
    is_pos_quick_select: true,
    is_active: true
  });

  // Modal states for Addon Items
  const [showAddonModal, setShowAddonModal] = useState(false);
  const [editingAddon, setEditingAddon] = useState(null);
  const [addonForm, setAddonForm] = useState({
    name: '',
    price: 30,
    category: 'charm',
    sort_order: 0,
    is_active: true
  });

  // Delete confirmation
  const [deletingItem, setDeletingItem] = useState(null); // { type: 'promo' | 'addon', item }

  const showToast = (msg, type = 'success') => {
    setToastMsg({ msg, type });
    setTimeout(() => setToastMsg(null), 3000);
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [promosRes, addonsRes] = await Promise.all([
        api.get('/checkout/promo-codes'),
        api.get('/checkout/addons')
      ]);
      setPromoCodes(promosRes.data || []);
      setAddonItems(addonsRes.data || []);
    } catch (err) {
      console.error('Failed to load coupons or addons:', err);
      showToast('載入卡券或品項資料失敗', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Filtered coupons
  const filteredPromos = useMemo(() => {
    return promoCodes.filter(p => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const codeMatch = (p.code || '').toLowerCase().includes(q);
        const nameMatch = (p.name || '').toLowerCase().includes(q);
        const descMatch = (p.description || '').toLowerCase().includes(q);
        if (!codeMatch && !nameMatch && !descMatch) return false;
      }
      if (channelFilter !== 'all' && p.channel !== 'all' && p.channel !== channelFilter) {
        return false;
      }
      if (statusFilter === 'active' && !p.is_active) return false;
      if (statusFilter === 'inactive' && p.is_active) return false;
      if (posOnlyFilter && !p.is_pos_quick_select) return false;
      return true;
    });
  }, [promoCodes, searchQuery, channelFilter, statusFilter, posOnlyFilter]);

  // Metrics
  const metrics = useMemo(() => {
    const totalCoupons = promoCodes.length;
    const activeCoupons = promoCodes.filter(p => p.is_active).length;
    const posQuickCoupons = promoCodes.filter(p => p.is_pos_quick_select).length;
    const totalUses = promoCodes.reduce((s, p) => s + (p.used_count || 0), 0);
    return { totalCoupons, activeCoupons, posQuickCoupons, totalUses };
  }, [promoCodes]);

  // Open modal for new promo
  const handleOpenNewPromo = () => {
    setEditingPromo(null);
    setPromoForm({
      code: '',
      name: '',
      description: '',
      discount_type: 'fixed_order',
      discount_value: 50,
      max_discount_amount: '',
      channel: 'all',
      target_scope: 'all',
      day_type_limit: 'all',
      mode_limit: 'all',
      min_pax: 1,
      min_hours: 1,
      min_amount: 0,
      max_uses: '',
      max_uses_per_user: '',
      start_date: '',
      end_date: '',
      is_pos_quick_select: true,
      is_active: true
    });
    setShowPromoModal(true);
  };

  // Open modal for editing promo
  const handleOpenEditPromo = (promo) => {
    setEditingPromo(promo);
    setPromoForm({
      code: promo.code || '',
      name: promo.name || '',
      description: promo.description || '',
      discount_type: promo.discount_type || 'fixed_order',
      discount_value: promo.discount_value != null ? promo.discount_value : 50,
      max_discount_amount: promo.max_discount_amount != null ? promo.max_discount_amount : '',
      channel: promo.channel || 'all',
      target_scope: promo.target_scope || 'all',
      day_type_limit: promo.day_type_limit || promo.applicable_days || 'all',
      mode_limit: promo.mode_limit || promo.applicable_mode || 'all',
      min_pax: promo.min_pax != null ? promo.min_pax : 1,
      min_hours: promo.min_hours != null ? promo.min_hours : 1,
      min_amount: promo.min_amount != null ? promo.min_amount : 0,
      max_uses: promo.max_uses != null ? promo.max_uses : '',
      max_uses_per_user: promo.max_uses_per_user != null ? promo.max_uses_per_user : '',
      start_date: promo.start_date ? promo.start_date.substring(0, 10) : '',
      end_date: promo.end_date ? promo.end_date.substring(0, 10) : '',
      is_pos_quick_select: Boolean(promo.is_pos_quick_select),
      is_active: promo.is_active !== false
    });
    setShowPromoModal(true);
  };

  // Save promo code (create or update)
  const handleSavePromo = async (e) => {
    e.preventDefault();
    const cleanCode = promoForm.code.trim().toUpperCase();
    if (!cleanCode || !promoForm.name.trim()) {
      showToast('請填寫優惠碼代號與顯示名稱', 'error');
      return;
    }

    const payload = {
      ...promoForm,
      code: cleanCode,
      name: promoForm.name.trim(),
      description: promoForm.description ? promoForm.description.trim() : null,
      discount_value: parseInt(promoForm.discount_value, 10) || 0,
      max_discount_amount: promoForm.max_discount_amount !== '' && promoForm.max_discount_amount !== null
        ? parseInt(promoForm.max_discount_amount, 10)
        : null,
      min_pax: parseInt(promoForm.min_pax, 10) || 1,
      min_hours: parseInt(promoForm.min_hours, 10) || 1,
      min_amount: parseInt(promoForm.min_amount, 10) || 0,
      max_uses: promoForm.max_uses !== '' && promoForm.max_uses !== null
        ? parseInt(promoForm.max_uses, 10)
        : null,
      max_uses_per_user: promoForm.max_uses_per_user !== '' && promoForm.max_uses_per_user !== null
        ? parseInt(promoForm.max_uses_per_user, 10)
        : null,
      start_date: promoForm.start_date ? promoForm.start_date : null,
      end_date: promoForm.end_date ? promoForm.end_date : null,
    };

    try {
      if (editingPromo) {
        const res = await api.put(`/checkout/promo-codes/${editingPromo.id}`, payload);
        setPromoCodes(prev => prev.map(p => p.id === editingPromo.id ? res.data : p));
        showToast(`已成功更新優惠券「${res.data.name}」`);
      } else {
        const res = await api.post('/checkout/promo-codes', payload);
        setPromoCodes(prev => [res.data, ...prev]);
        showToast(`已成功新增優惠券「${res.data.name}」`);
      }
      setShowPromoModal(false);
    } catch (err) {
      showToast(err.response?.data?.error || '儲存優惠券失敗', 'error');
    }
  };

  // Toggle quick fields
  const handleTogglePromoField = async (promo, field) => {
    const nextVal = !promo[field];
    try {
      const res = await api.put(`/checkout/promo-codes/${promo.id}`, {
        [field]: nextVal
      });
      setPromoCodes(prev => prev.map(p => p.id === promo.id ? res.data : p));
      showToast(
        field === 'is_pos_quick_select'
          ? `已${nextVal ? '開啟' : '關閉'}「${promo.name}」櫃檯快捷`
          : `已${nextVal ? '啟用' : '停用'}「${promo.name}」`
      );
    } catch (err) {
      showToast('切換狀態失敗', 'error');
    }
  };

  // Delete Promo
  const handleConfirmDeletePromo = async () => {
    if (!deletingItem || deletingItem.type !== 'promo') return;
    try {
      await api.delete(`/checkout/promo-codes/${deletingItem.item.id}`);
      setPromoCodes(prev => prev.filter(p => p.id !== deletingItem.item.id));
      showToast(`已刪除優惠券「${deletingItem.item.name}」`);
    } catch (err) {
      showToast('刪除優惠券失敗', 'error');
    } finally {
      setDeletingItem(null);
    }
  };

  // Addon Handlers
  const handleOpenNewAddon = () => {
    setEditingAddon(null);
    setAddonForm({
      name: '',
      price: 30,
      category: 'charm',
      sort_order: addonItems.length,
      is_active: true
    });
    setShowAddonModal(true);
  };

  const handleOpenEditAddon = (item) => {
    setEditingAddon(item);
    setAddonForm({
      name: item.name || '',
      price: item.price != null ? item.price : 30,
      category: item.category || 'charm',
      sort_order: item.sort_order || 0,
      is_active: item.is_active !== false
    });
    setShowAddonModal(true);
  };

  const handleSaveAddon = async (e) => {
    e.preventDefault();
    if (!addonForm.name.trim()) {
      showToast('請輸入品項名稱', 'error');
      return;
    }
    const payload = {
      name: addonForm.name.trim(),
      price: parseInt(addonForm.price, 10) || 0,
      category: addonForm.category,
      sort_order: parseInt(addonForm.sort_order, 10) || 0,
      is_active: Boolean(addonForm.is_active)
    };
    try {
      if (editingAddon) {
        const res = await api.put(`/checkout/addons/${editingAddon.id}`, payload);
        setAddonItems(prev => prev.map(a => a.id === editingAddon.id ? res.data : a));
        showToast(`已更新加購品項「${res.data.name}」`);
      } else {
        const res = await api.post('/checkout/addons', payload);
        setAddonItems(prev => [...prev, res.data]);
        showToast(`已新增加購品項「${res.data.name}」`);
      }
      setShowAddonModal(false);
    } catch (err) {
      showToast('儲存加購品項失敗', 'error');
    }
  };

  const handleToggleAddonActive = async (item) => {
    const nextVal = !item.is_active;
    try {
      const res = await api.put(`/checkout/addons/${item.id}`, { is_active: nextVal });
      setAddonItems(prev => prev.map(a => a.id === item.id ? res.data : a));
      showToast(`已${nextVal ? '上架' : '下架'}「${item.name}」`);
    } catch (err) {
      showToast('切換狀態失敗', 'error');
    }
  };

  const handleConfirmDeleteAddon = async () => {
    if (!deletingItem || deletingItem.type !== 'addon') return;
    try {
      await api.delete(`/checkout/addons/${deletingItem.item.id}`);
      setAddonItems(prev => prev.filter(a => a.id !== deletingItem.item.id));
      showToast(`已刪除加購品項「${deletingItem.item.name}」`);
    } catch (err) {
      showToast('刪除加購品項失敗', 'error');
    } finally {
      setDeletingItem(null);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6 animate-fade-in bg-[#FAF7F2] min-h-screen">
      {/* Toast Notification */}
      {toastMsg && (
        <div
          className={`fixed top-6 right-6 z-[200] px-4 py-3 rounded-2xl shadow-lg border text-sm font-bold flex items-center gap-2 animate-in slide-in-from-top-4 duration-200 ${
            toastMsg.type === 'error'
              ? 'bg-rose-50 border-rose-200 text-rose-800'
              : 'bg-emerald-50 border-emerald-200 text-emerald-800'
          }`}
        >
          {toastMsg.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
          <span>{toastMsg.msg}</span>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-white border border-[#E8DEC8] flex items-center justify-center text-[#8B5B43] shadow-xs">
              <Ticket className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[#3E332B] tracking-tight">卡券與優惠管理</h1>
              <p className="text-[#8C8279] text-xs sm:text-sm mt-0.5">
                管理線上預約折扣碼、現場 POS 櫃檯快捷通用券及結帳加購品項。
              </p>
            </div>
          </div>
        </div>

        {/* Tab Switcher & Action Buttons */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="bg-white border border-[#E8DEC8] p-1 rounded-xl flex items-center gap-1 shadow-2xs">
            <button
              type="button"
              onClick={() => setActiveTab('coupons')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                activeTab === 'coupons'
                  ? 'bg-[#8B5B43] text-white shadow-xs'
                  : 'text-[#6D5D52] hover:text-[#3E332B] hover:bg-[#FAF7F2]'
              }`}
            >
              <Ticket className="w-3.5 h-3.5" />
              <span>折扣碼與通用優惠券 ({promoCodes.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('addons')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                activeTab === 'addons'
                  ? 'bg-[#8B5B43] text-white shadow-xs'
                  : 'text-[#6D5D52] hover:text-[#3E332B] hover:bg-[#FAF7F2]'
              }`}
            >
              <ShoppingBag className="w-3.5 h-3.5" />
              <span>加購品項與周邊 ({addonItems.length})</span>
            </button>
          </div>

          {activeTab === 'coupons' ? (
            <button
              type="button"
              onClick={handleOpenNewPromo}
              className="px-4 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs sm:text-sm font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>新增優惠券</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleOpenNewAddon}
              className="px-4 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs sm:text-sm font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>新增加購品項</span>
            </button>
          )}
        </div>
      </div>

      {/* TAB 1: COUPONS & PROMO CODES */}
      {activeTab === 'coupons' && (
        <div className="space-y-5">
          {/* Metrics Banner */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#8C8279]">總建立卡券</span>
                <span className="p-2 rounded-xl bg-[#FAF7F2] text-[#8B5B43]">
                  <Ticket className="w-4 h-4" />
                </span>
              </div>
              <div className="text-2xl font-black text-[#3E332B] mt-1">{metrics.totalCoupons}</div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#8C8279]">啟用生效中</span>
                <span className="p-2 rounded-xl bg-emerald-50 text-emerald-700">
                  <Check className="w-4 h-4" />
                </span>
              </div>
              <div className="text-2xl font-black text-emerald-700 mt-1">{metrics.activeCoupons}</div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#8C8279]">POS 櫃檯快捷鍵</span>
                <span className="p-2 rounded-xl bg-amber-50 text-amber-700">
                  <Zap className="w-4 h-4" />
                </span>
              </div>
              <div className="text-2xl font-black text-amber-700 mt-1">{metrics.posQuickCoupons}</div>
            </div>

            <div className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-[#8C8279]">總累計使用人次</span>
                <span className="p-2 rounded-xl bg-[#FAF7F2] text-[#8B5B43]">
                  <Users className="w-4 h-4" />
                </span>
              </div>
              <div className="text-2xl font-black text-[#8B5B43] mt-1">{metrics.totalUses}</div>
            </div>
          </div>

          {/* Search & Filter Bar */}
          <div className="bg-white rounded-2xl border border-[#E8DEC8] p-4 shadow-2xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
              {/* Search */}
              <div className="relative flex-1 min-w-[220px]">
                <Search className="w-4 h-4 text-[#8C8279] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜尋代碼、活動名稱或說明..."
                  className="w-full pl-9 pr-3 py-2 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-medium text-[#3E332B] placeholder-[#8C8279] focus:outline-none focus:border-[#8B5B43]"
                />
              </div>

              {/* Channel Filter */}
              <select
                value={channelFilter}
                onChange={e => setChannelFilter(e.target.value)}
                className="px-3 py-2 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
              >
                <option value="all">通路：全部通路</option>
                <option value="online">通路：線上專用</option>
                <option value="pos">通路：櫃檯現場專用</option>
              </select>

              {/* Status Filter */}
              <select
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                className="px-3 py-2 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
              >
                <option value="all">狀態：全部</option>
                <option value="active">狀態：僅顯示啟用中</option>
                <option value="inactive">狀態：僅顯示已停用</option>
              </select>
            </div>

            {/* Quick POS Filter Toggle */}
            <label className="flex items-center gap-2 text-xs font-bold text-[#6D5D52] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={posOnlyFilter}
                onChange={e => setPosOnlyFilter(e.target.checked)}
                className="rounded border-[#E8DEC8] text-[#8B5B43] focus:ring-[#8B5B43]"
              />
              <span>僅看櫃檯快捷鍵</span>
            </label>
          </div>

          {/* Coupons Cards Grid */}
          {loading ? (
            <div className="bg-white rounded-2xl border border-[#E8DEC8] p-12 text-center text-[#8C8279] font-medium">
              載入卡券資料中...
            </div>
          ) : filteredPromos.length === 0 ? (
            <div className="bg-white rounded-2xl border border-[#E8DEC8] p-12 text-center text-[#8C8279]">
              <Ticket className="w-10 h-10 mx-auto text-[#D5CFC9] mb-2" />
              <p className="font-bold text-[#3E332B]">查無符合條件的優惠券</p>
              <p className="text-xs text-[#8C8279] mt-1">您可以點擊右上角「新增優惠券」按鈕建立新活動。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredPromos.map(promo => {
                const typeCfg = DISCOUNT_TYPE_CONFIG[promo.discount_type] || DISCOUNT_TYPE_CONFIG.fixed_order;
                const channelCfg = CHANNEL_CONFIG[promo.channel] || CHANNEL_CONFIG.all;
                const isExpired = promo.end_date && new Date(promo.end_date) < new Date();

                // Format discount label
                let valueDisplay = '';
                if (promo.discount_type === 'fixed_order') {
                  valueDisplay = `整單現折 NT$ ${promo.discount_value}`;
                } else if (promo.discount_type === 'fixed_per_pax') {
                  valueDisplay = `每人現折 NT$ ${promo.discount_value}`;
                } else if (promo.discount_type === 'percentage') {
                  const val = promo.discount_value;
                  const discountPct = val > 50 && val < 100 ? (100 - val) : val;
                  valueDisplay = `享 ${10 - (discountPct / 10)} 折 (${discountPct}% OFF)`;
                } else if (promo.discount_type === 'free_hours') {
                  valueDisplay = `贈送 ${promo.discount_value} 小時免費時數`;
                }

                return (
                  <div
                    key={promo.id}
                    className={`bg-white rounded-2xl border transition-all duration-200 p-4.5 flex flex-col justify-between shadow-2xs hover:shadow-warm ${
                      promo.is_active ? 'border-[#E8DEC8]' : 'border-gray-200 opacity-60 bg-gray-50/50'
                    }`}
                  >
                    <div>
                      {/* Top Bar: Code badge, Channel, Status */}
                      <div className="flex items-start justify-between gap-2 mb-2.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-mono font-black text-xs px-2.5 py-1 rounded-lg bg-[#FAF7F2] text-[#8B5B43] border border-[#E8DEC8]">
                            {promo.code}
                          </span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${channelCfg.color}`}>
                            {channelCfg.short}
                          </span>
                          {promo.is_pos_quick_select && (
                            <span className="text-[10px] font-black px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-300 flex items-center gap-0.5">
                              <Zap className="w-2.5 h-2.5" /> POS 快捷
                            </span>
                          )}
                        </div>

                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                            promo.is_active
                              ? isExpired
                                ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                : 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {promo.is_active ? (isExpired ? '已過期' : '啟用中') : '已停用'}
                        </span>
                      </div>

                      {/* Title & Description */}
                      <h3 className="font-extrabold text-base text-[#3E332B] line-clamp-1">{promo.name}</h3>
                      {promo.description && (
                        <p className="text-xs text-[#8C8279] mt-1 line-clamp-2">{promo.description}</p>
                      )}

                      {/* Main Discount Display */}
                      <div className="mt-3 p-2.5 rounded-xl bg-[#FAF0ED] border border-[#F2D6CD] flex items-center justify-between">
                        <div>
                          <div className="text-[11px] font-bold text-[#8C8279]">折扣優惠</div>
                          <div className="text-sm font-black text-[#C25E3E]">{valueDisplay}</div>
                        </div>
                        {promo.max_discount_amount && promo.max_discount_amount > 0 && (
                          <div className="text-right">
                            <div className="text-[10px] font-bold text-[#8C8279]">單筆上限</div>
                            <div className="text-xs font-extrabold text-[#3E332B]">NT$ {promo.max_discount_amount}</div>
                          </div>
                        )}
                      </div>

                      {/* Condition Badges */}
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {promo.min_pax > 1 && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#FAF7F2] text-[#6D5D52] border border-[#E8DEC8]">
                            👥 滿 {promo.min_pax} 人
                          </span>
                        )}
                        {promo.min_hours > 1 && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#FAF7F2] text-[#6D5D52] border border-[#E8DEC8]">
                            ⏱️ 滿 {promo.min_hours} 小時
                          </span>
                        )}
                        {promo.min_amount > 0 && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-[#FAF7F2] text-[#6D5D52] border border-[#E8DEC8]">
                            💰 低消 ${promo.min_amount}
                          </span>
                        )}
                        {(promo.day_type_limit === 'weekday' || promo.applicable_days === 'weekday') && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-blue-50 text-blue-800 border border-blue-200">
                            📅 僅限平日
                          </span>
                        )}
                        {(promo.day_type_limit === 'weekend' || promo.applicable_days === 'weekend') && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-purple-50 text-purple-800 border border-purple-200">
                            🎉 僅限假日
                          </span>
                        )}
                        {(promo.mode_limit === 'unlimited' || promo.applicable_mode === 'unlimited') && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200">
                            ✨ 僅限不限時(封頂)
                          </span>
                        )}
                        {(promo.mode_limit === 'hourly' || promo.applicable_mode === 'hourly') && (
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-stone-100 text-stone-700 border border-stone-200">
                            ⌛ 僅限計時方案
                          </span>
                        )}
                      </div>

                      {/* Validity & Usage Counts */}
                      <div className="mt-3 pt-2.5 border-t border-[#E8DEC8]/60 text-[11px] text-[#8C8279] space-y-1">
                        <div className="flex items-center justify-between">
                          <span>有效期限</span>
                          <span className="font-bold text-[#3E332B]">
                            {promo.start_date || promo.end_date
                              ? `${promo.start_date ? promo.start_date.substring(0, 10) : '即日'} ~ ${promo.end_date ? promo.end_date.substring(0, 10) : '永久'}`
                              : '永久有效'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span>使用次數</span>
                          <span className="font-bold text-[#3E332B]">
                            已用 {promo.used_count || 0} 次
                            {promo.max_uses ? ` / 上限 ${promo.max_uses}` : ''}
                            {promo.max_uses_per_user ? ` (每人限${promo.max_uses_per_user}次)` : ''}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Actions Bar */}
                    <div className="mt-4 pt-3 border-t border-[#E8DEC8] flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleTogglePromoField(promo, 'is_pos_quick_select')}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors flex items-center gap-1 ${
                            promo.is_pos_quick_select
                              ? 'bg-amber-50 text-amber-900 border-amber-300'
                              : 'bg-white text-[#8C8279] border-[#E8DEC8] hover:bg-[#FAF7F2]'
                          }`}
                          title="在 POS 櫃檯結帳畫面顯示為一鍵套用快捷鍵"
                        >
                          <Zap className="w-3 h-3" />
                          <span>{promo.is_pos_quick_select ? '快捷: 開啟' : '快捷: 關閉'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleTogglePromoField(promo, 'is_active')}
                          className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors ${
                            promo.is_active
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                          }`}
                        >
                          {promo.is_active ? '啟用中' : '已停用'}
                        </button>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleOpenEditPromo(promo)}
                          className="p-1.5 text-[#6D5D52] hover:text-[#8B5B43] hover:bg-[#FAF7F2] rounded-lg transition-colors"
                          title="編輯優惠券"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingItem({ type: 'promo', item: promo })}
                          className="p-1.5 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors"
                          title="刪除優惠券"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: ADDON ITEMS & MERCHANDISE */}
      {activeTab === 'addons' && (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border border-[#E8DEC8] p-5 shadow-2xs">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-extrabold text-base text-[#3E332B]">常用吊飾與加購配件清單</h3>
                <p className="text-xs text-[#8C8279] mt-0.5">
                  店員可在 POS 結帳時，一鍵將吊飾配件或客製服務計入整單或特定顧客名下。
                </p>
              </div>
              <button
                type="button"
                onClick={handleOpenNewAddon}
                className="px-3.5 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>新增加購品項</span>
              </button>
            </div>

            {loading ? (
              <div className="py-12 text-center text-[#8C8279]">載入加購品項中...</div>
            ) : addonItems.length === 0 ? (
              <div className="py-12 text-center text-[#8C8279]">
                <ShoppingBag className="w-10 h-10 mx-auto text-[#D5CFC9] mb-2" />
                <p className="font-bold text-[#3E332B]">尚未建立任何加購品項</p>
              </div>
            ) : (
              <div className="divide-y divide-[#E8DEC8]">
                {addonItems.map(item => {
                  const catCfg = ADDON_CATEGORIES[item.category] || ADDON_CATEGORIES.charm;
                  return (
                    <div
                      key={item.id}
                      className="py-3.5 flex flex-wrap items-center justify-between gap-3 hover:bg-[#FAF7F2]/50 px-2 rounded-xl transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center text-[#8B5B43]">
                          <catCfg.icon className="w-4 h-4" />
                        </span>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-sm text-[#3E332B]">{item.name}</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md border ${catCfg.color}`}>
                              {catCfg.label}
                            </span>
                            {!item.is_active && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                                已下架
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-[#8C8279]">排序權重：{item.sort_order}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <span className="text-sm font-black text-[#8B5B43]">NT$ {item.price}</span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleToggleAddonActive(item)}
                            className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition-colors ${
                              item.is_active
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                : 'bg-gray-100 text-gray-600 border-gray-200 hover:bg-gray-200'
                            }`}
                          >
                            {item.is_active ? '上架中' : '已下架'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenEditAddon(item)}
                            className="p-1.5 text-[#6D5D52] hover:text-[#8B5B43] hover:bg-[#FAF7F2] rounded-lg transition-colors"
                            title="編輯品項"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeletingItem({ type: 'addon', item })}
                            className="p-1.5 text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors"
                            title="刪除品項"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* PROMO ADD / EDIT MODAL */}
      {showPromoModal && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" onClick={() => setShowPromoModal(false)} />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden relative z-10 flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="px-6 py-4.5 bg-[#FAF7F2] border-b border-[#E8DEC8] flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-white border border-[#E8DEC8] flex items-center justify-center text-[#8B5B43]">
                  <Ticket className="w-4 h-4" />
                </div>
                <h3 className="font-extrabold text-lg text-[#3E332B]">
                  {editingPromo ? '編輯優惠券 / 折扣碼' : '新增優惠券 / 折扣碼'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPromoModal(false)}
                className="p-1.5 text-[#8C8279] hover:text-[#3E332B] rounded-full hover:bg-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Form Body */}
            <form onSubmit={handleSavePromo} className="p-6 overflow-y-auto space-y-5 flex-1">
              {/* Basic Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">
                    優惠代碼 (Code) *
                  </label>
                  <input
                    type="text"
                    required
                    value={promoForm.code}
                    onChange={e => setPromoForm({ ...promoForm, code: e.target.value.toUpperCase() })}
                    placeholder="例如: CHECKIN50, VIP10OFF"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-mono font-bold uppercase text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                  />
                  <p className="text-[10px] text-[#8C8279] mt-1">顧客線上輸入或櫃檯輸入之代號，英數字自動轉大寫</p>
                </div>

                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">
                    顯示名稱 (Title) *
                  </label>
                  <input
                    type="text"
                    required
                    value={promoForm.name}
                    onChange={e => setPromoForm({ ...promoForm, name: e.target.value })}
                    placeholder="例如: IG拍照打卡折50元、雙人同行9折"
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                  />
                  <p className="text-[10px] text-[#8C8279] mt-1">顯示於預約單明細、結帳單與 POS 快捷按鈕</p>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-bold text-[#3E332B] block mb-1">說明與備註</label>
                <textarea
                  rows={2}
                  value={promoForm.description}
                  onChange={e => setPromoForm({ ...promoForm, description: e.target.value })}
                  placeholder="補充說明活動規則、出示憑證或適用條件..."
                  className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                />
              </div>

              {/* Channel & Scope */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">適用通路渠道</label>
                  <select
                    value={promoForm.channel}
                    onChange={e => setPromoForm({ ...promoForm, channel: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                  >
                    <option value="all">全通路通用（線上顧客預約 + 櫃檯現場結帳）</option>
                    <option value="online">僅限線上顧客預約（LINE 預約時輸入）</option>
                    <option value="pos">僅限現場櫃檯（店員結帳時套用）</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">平假日適用限制</label>
                  <select
                    value={promoForm.day_type_limit}
                    onChange={e => setPromoForm({ ...promoForm, day_type_limit: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                  >
                    <option value="all">平假日皆適用</option>
                    <option value="weekday">僅限平日（週一至週五）</option>
                    <option value="weekend">僅限假日（週六、週日）</option>
                  </select>
                </div>
              </div>

              {/* Discount Type & Value */}
              <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] space-y-3">
                <div className="text-xs font-black text-[#8B5B43] flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5" />
                  <span>折扣計算方式與數值設定</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">折扣類型</label>
                    <select
                      value={promoForm.discount_type}
                      onChange={e => setPromoForm({ ...promoForm, discount_type: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                    >
                      <option value="fixed_order">整單折抵固定金額 ($)</option>
                      <option value="fixed_per_pax">依人數每人折抵 ($)</option>
                      <option value="percentage">百分比折抵 (% OFF)</option>
                      <option value="free_hours">贈送免費時數 (小時)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">
                      折抵數值 ({DISCOUNT_TYPE_CONFIG[promoForm.discount_type]?.unit})
                    </label>
                    <input
                      type="number"
                      required
                      min="1"
                      value={promoForm.discount_value}
                      onChange={e => setPromoForm({ ...promoForm, discount_value: e.target.value })}
                      className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-black text-[#8B5B43]"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">
                      單筆最高折抵上限 ($，選填)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={promoForm.max_discount_amount}
                      onChange={e => setPromoForm({ ...promoForm, max_discount_amount: e.target.value })}
                      placeholder="無上限請留空"
                      className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                    />
                  </div>
                </div>

                <div className="text-[11px] text-[#8C8279] italic">
                  💡 百分比折抵說明：填寫 10 代表 9 折（折抵 10%）；填寫 90 亦自動轉換為 9 折。
                </div>
              </div>

              {/* Thresholds & Mode limits */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">最低人數門檻</label>
                  <input
                    type="number"
                    min="1"
                    value={promoForm.min_pax}
                    onChange={e => setPromoForm({ ...promoForm, min_pax: e.target.value })}
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">最低預約時數</label>
                  <input
                    type="number"
                    min="1"
                    value={promoForm.min_hours}
                    onChange={e => setPromoForm({ ...promoForm, min_hours: e.target.value })}
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">最低消費門檻 ($)</label>
                  <input
                    type="number"
                    min="0"
                    value={promoForm.min_amount}
                    onChange={e => setPromoForm({ ...promoForm, min_amount: e.target.value })}
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">方案限制</label>
                  <select
                    value={promoForm.mode_limit}
                    onChange={e => setPromoForm({ ...promoForm, mode_limit: e.target.value })}
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  >
                    <option value="all">全方案適用</option>
                    <option value="hourly">僅一般計時</option>
                    <option value="unlimited">僅不限時方案</option>
                  </select>
                </div>
              </div>

              {/* Usage & Date Limits */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">總使用次數上限</label>
                  <input
                    type="number"
                    min="1"
                    value={promoForm.max_uses}
                    onChange={e => setPromoForm({ ...promoForm, max_uses: e.target.value })}
                    placeholder="無上限留空"
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">每位會員限用次數</label>
                  <input
                    type="number"
                    min="1"
                    value={promoForm.max_uses_per_user}
                    onChange={e => setPromoForm({ ...promoForm, max_uses_per_user: e.target.value })}
                    placeholder="無限制留空"
                    className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">開始生效日期</label>
                  <input
                    type="date"
                    value={promoForm.start_date}
                    onChange={e => setPromoForm({ ...promoForm, start_date: e.target.value })}
                    className="w-full px-2 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs text-[#3E332B]"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-[#6D5D52] block mb-1">截止日期</label>
                  <input
                    type="date"
                    value={promoForm.end_date}
                    onChange={e => setPromoForm({ ...promoForm, end_date: e.target.value })}
                    className="w-full px-2 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs text-[#3E332B]"
                  />
                </div>
              </div>

              {/* Toggles */}
              <div className="pt-2 border-t border-[#E8DEC8] flex flex-wrap items-center justify-between gap-4">
                <label className="flex items-center gap-2 cursor-pointer text-xs font-extrabold text-amber-900">
                  <input
                    type="checkbox"
                    checked={promoForm.is_pos_quick_select}
                    onChange={e => setPromoForm({ ...promoForm, is_pos_quick_select: e.target.checked })}
                    className="rounded border-[#E8DEC8] text-[#8B5B43] focus:ring-[#8B5B43]"
                  />
                  <span>⚡ 設為 POS 現場結帳快捷鍵（店員可在結帳頁面一鍵點擊帶入）</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#3E332B]">
                  <input
                    type="checkbox"
                    checked={promoForm.is_active}
                    onChange={e => setPromoForm({ ...promoForm, is_active: e.target.checked })}
                    className="rounded border-[#E8DEC8] text-[#8B5B43] focus:ring-[#8B5B43]"
                  />
                  <span>即刻啟用生效</span>
                </label>
              </div>

              {/* Modal Actions */}
              <div className="pt-4 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowPromoModal(false)}
                  className="px-4 py-2 bg-white hover:bg-[#FAF7F2] text-[#6D5D52] text-xs font-bold rounded-xl border border-[#E8DEC8] transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-xl shadow-xs transition-colors"
                >
                  {editingPromo ? '儲存變更' : '確認建立優惠券'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ADDON ITEM ADD / EDIT MODAL */}
      {showAddonModal && (
        <div className="fixed inset-0 z-[150] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" onClick={() => setShowAddonModal(false)} />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md overflow-hidden relative z-10 flex flex-col animate-in zoom-in-95 duration-200">
            <div className="px-6 py-4.5 bg-[#FAF7F2] border-b border-[#E8DEC8] flex items-center justify-between">
              <h3 className="font-extrabold text-base text-[#3E332B]">
                {editingAddon ? '編輯加購品項' : '新增加購品項'}
              </h3>
              <button
                type="button"
                onClick={() => setShowAddonModal(false)}
                className="p-1.5 text-[#8C8279] hover:text-[#3E332B] rounded-full hover:bg-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveAddon} className="p-6 space-y-4">
              <div>
                <label className="text-xs font-bold text-[#3E332B] block mb-1">品項名稱 *</label>
                <input
                  type="text"
                  required
                  value={addonForm.name}
                  onChange={e => setAddonForm({ ...addonForm, name: e.target.value })}
                  placeholder="例如: 夜光吊飾扣、專人精緻熨燙服務"
                  className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">單價 (NT$) *</label>
                  <input
                    type="number"
                    required
                    min="0"
                    value={addonForm.price}
                    onChange={e => setAddonForm({ ...addonForm, price: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-black text-[#8B5B43] focus:outline-none focus:border-[#8B5B43]"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-[#3E332B] block mb-1">分類類別</label>
                  <select
                    value={addonForm.category}
                    onChange={e => setAddonForm({ ...addonForm, category: e.target.value })}
                    className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                  >
                    <option value="charm">吊飾配件 (charm)</option>
                    <option value="service">專人服務 (service)</option>
                    <option value="other">其他周邊 (other)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-[#3E332B] block mb-1">排序權重 (越小越靠前)</label>
                <input
                  type="number"
                  value={addonForm.sort_order}
                  onChange={e => setAddonForm({ ...addonForm, sort_order: e.target.value })}
                  className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] focus:outline-none focus:border-[#8B5B43]"
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#3E332B] pt-1">
                <input
                  type="checkbox"
                  checked={addonForm.is_active}
                  onChange={e => setAddonForm({ ...addonForm, is_active: e.target.checked })}
                  className="rounded border-[#E8DEC8] text-[#8B5B43] focus:ring-[#8B5B43]"
                />
                <span>上架並顯示於結帳加購按鈕</span>
              </label>

              <div className="pt-3 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowAddonModal(false)}
                  className="px-4 py-2 bg-white hover:bg-[#FAF7F2] text-[#6D5D52] text-xs font-bold rounded-xl border border-[#E8DEC8] transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-xl shadow-xs transition-colors"
                >
                  {editingAddon ? '儲存變更' : '確認建立品項'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRM DIALOG */}
      {deletingItem && (
        <div className="fixed inset-0 z-[160] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-xs" onClick={() => setDeletingItem(null)} />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden relative z-10 p-6 text-center animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-3">
              <Trash2 className="w-6 h-6 stroke-[2.2]" />
            </div>
            <h3 className="font-extrabold text-base text-[#3E332B] mb-1">
              確定要刪除「{deletingItem.item.name}」嗎？
            </h3>
            <p className="text-xs text-[#8C8279] mb-5">
              此操作無法復原。若該卡券曾被使用，建議改為停用而非刪除，以保留歷史記錄。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDeletingItem(null)}
                className="flex-1 py-2.5 bg-white hover:bg-[#FAF7F2] text-[#6D5D52] text-xs font-bold rounded-xl border border-[#E8DEC8] transition-colors"
              >
                取消
              </button>
              <button
                type="button"
                onClick={deletingItem.type === 'promo' ? handleConfirmDeletePromo : handleConfirmDeleteAddon}
                className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold rounded-xl shadow-xs transition-colors"
              >
                確定刪除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

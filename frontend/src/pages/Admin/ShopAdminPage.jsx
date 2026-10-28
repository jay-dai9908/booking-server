import React, { useState, useEffect } from 'react';
import {
  ShoppingBag,
  Package,
  CreditCard,
  Search,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Clock,
  Send,
  MessageCircle,
  Copy,
  Plus,
  Edit2,
  Trash2,
  Sparkles,
  Store,
  Truck,
  Check,
  ChevronDown,
  X
} from 'lucide-react';
import api from '../../api/axios';
import { format } from 'date-fns';

export default function ShopAdminPage() {
  const [activeTab, setActiveTab] = useState('orders'); // 'orders' | 'payments' | 'products'

  // Tab 1: Orders
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');
  const [orderPaymentStatusFilter, setOrderPaymentStatusFilter] = useState('all');
  const [orderStatusFilter, setOrderStatusFilter] = useState('all');
  const [selectedOrderIds, setSelectedOrderIds] = useState([]);

  // Modals
  const [verifyModalOrder, setVerifyModalOrder] = useState(null);
  const [verifyPaidAmount, setVerifyPaidAmount] = useState('');
  const [verifyIsFullPayment, setVerifyIsFullPayment] = useState(false);
  const [verifySendLine, setVerifySendLine] = useState(true);

  const [wishReplyOrder, setWishReplyOrder] = useState(null);
  const [wishReplyText, setWishReplyText] = useState('');

  const [arrivalDateOrder, setArrivalDateOrder] = useState(null);
  const [arrivalDateText, setArrivalDateText] = useState('');

  // Tab 2: Payments & Account Pool
  const [accountPool, setAccountPool] = useState([]);
  const [poolSummary, setPoolSummary] = useState({ total: 0, available: 0, assigned: 0, used: 0 });
  const [batchImportText, setBatchImportText] = useState('');
  const [importingPool, setImportingPool] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [shopSettings, setShopSettings] = useState({
    shop_deposit_deadline_days: 2,
    shop_default_arrival_note: '',
    shop_enable_shipping: false,
    shop_shipping_fee: 60,
    official_line_url: 'https://lin.ee/vsZhRW5'
  });
  const [savingSettings, setSavingSettings] = useState(false);

  // Tab 3: Products
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [editProductModal, setEditProductModal] = useState(null); // null or product object

  useEffect(() => {
    if (activeTab === 'orders') fetchAdminOrders();
    if (activeTab === 'payments') {
      fetchAccountPool();
      fetchPaymentSettings();
    }
    if (activeTab === 'products') fetchAdminProducts();
  }, [activeTab]);

  // Orders handlers
  const fetchAdminOrders = async () => {
    try {
      setLoadingOrders(true);
      const res = await api.get('/shop/admin/orders', {
        params: {
          search: orderSearch,
          payment_status: orderPaymentStatusFilter,
          order_status: orderStatusFilter
        }
      });
      setOrders(res.data.orders || []);
      setSelectedOrderIds([]);
    } catch (err) {
      console.error('Failed to fetch admin orders:', err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const handleVerifyPaymentSubmit = async () => {
    if (!verifyModalOrder) return;
    try {
      await api.patch(`/shop/admin/orders/${verifyModalOrder.id}/verify-payment`, {
        paid_amount: parseInt(verifyPaidAmount, 10) || verifyModalOrder.deposit_required,
        is_full_payment: verifyIsFullPayment,
        send_line_notification: verifySendLine
      });
      setVerifyModalOrder(null);
      fetchAdminOrders();
    } catch (err) {
      alert('對帳確認失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const handleWishReplySubmit = async () => {
    if (!wishReplyOrder) return;
    try {
      await api.patch(`/shop/admin/orders/${wishReplyOrder.id}`, {
        wish_reply: wishReplyText.trim() || null
      });
      setWishReplyOrder(null);
      fetchAdminOrders();
    } catch (err) {
      alert('儲存許願回覆失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const handleArrivalDateSubmit = async () => {
    if (!arrivalDateOrder) return;
    try {
      await api.patch(`/shop/admin/orders/${arrivalDateOrder.id}`, {
        estimated_arrival: arrivalDateText.trim() || null
      });
      setArrivalDateOrder(null);
      fetchAdminOrders();
    } catch (err) {
      alert('更新預計到貨日失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const handleNotifyArrival = async (orderIds) => {
    if (!orderIds || orderIds.length === 0) return;
    if (!window.confirm(`確定要向選取的 ${orderIds.length} 筆訂單發送「商品到貨 LINE 取件通知」嗎？`)) return;

    try {
      const res = await api.post('/shop/admin/orders/notify-arrival', { order_ids: orderIds });
      alert(res.data?.message || '到貨通知已成功推播！');
      fetchAdminOrders();
    } catch (err) {
      alert('發送到貨通知失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const handleMarkPickedUp = async (orderId) => {
    if (!window.confirm('確定顧客已完成現場取貨嗎？取貨完成後若含有贈品卡將自動發放至會員帳號！')) return;
    try {
      await api.patch(`/shop/admin/orders/${orderId}`, {
        order_status: 'picked_up'
      });
      fetchAdminOrders();
    } catch (err) {
      alert('更新取貨狀態失敗：' + (err.response?.data?.error || err.message));
    }
  };

  const handleCancelOrder = async (order) => {
    if (!window.confirm(`確定要取消訂單 #${order.order_ref} 嗎？\n若該訂單佔用中信專屬一次性帳號，系統將會立即釋放回帳號池供其他客人使用。`)) {
      return;
    }
    try {
      await api.patch(`/shop/admin/orders/${order.id}`, {
        order_status: 'cancelled'
      });
      alert('訂單已取消，相關資源已釋放');
      fetchAdminOrders();
      fetchAccountPool();
    } catch (err) {
      alert('取消訂單失敗：' + (err.response?.data?.error || err.message));
    }
  };

  // Payments & Account Pool handlers
  const fetchAccountPool = async () => {
    try {
      const res = await api.get('/shop/admin/account-pool');
      setAccountPool(res.data.pool || []);
      setPoolSummary(res.data.summary || {});
    } catch (err) {
      console.error('Failed to fetch account pool:', err);
    }
  };

  const fetchPaymentSettings = async () => {
    try {
      const res = await api.get('/shop/admin/payment-methods');
      setPaymentMethods(res.data.payment_methods || []);
      setShopSettings(res.data.settings || {});
    } catch (err) {
      console.error('Failed to fetch payment settings:', err);
    }
  };

  const handleBatchImportPool = async () => {
    if (!batchImportText.trim()) return;
    setImportingPool(true);
    try {
      const res = await api.post('/shop/admin/account-pool/batch', {
        text_lines: batchImportText
      });
      alert(res.data?.message || '匯入成功！');
      setBatchImportText('');
      fetchAccountPool();
    } catch (err) {
      alert('批次匯入失敗：' + (err.response?.data?.error || err.message));
    } finally {
      setImportingPool(false);
    }
  };

  const handleSaveShopSettings = async (e) => {
    e.preventDefault();
    setSavingSettings(true);
    try {
      await api.post('/shop/admin/settings', shopSettings);
      alert('預購商城設定已成功儲存！');
      fetchPaymentSettings();
    } catch (err) {
      alert('儲存設定失敗：' + (err.response?.data?.error || err.message));
    } finally {
      setSavingSettings(false);
    }
  };

  const handleTogglePaymentMethod = async (method) => {
    try {
      await api.put(`/shop/admin/payment-methods/${method.id}`, {
        is_enabled: !method.is_enabled
      });
      fetchPaymentSettings();
    } catch (err) {
      alert('切換付款方式失敗');
    }
  };

  const [editingPaymentMethods, setEditingPaymentMethods] = useState({});
  const [savingPaymentId, setSavingPaymentId] = useState(null);

  const handleUpdatePaymentMethodField = (methodId, field, value) => {
    setEditingPaymentMethods(prev => ({
      ...prev,
      [methodId]: {
        ...(prev[methodId] || {}),
        [field]: value
      }
    }));
  };

  const handleSavePaymentMethodConfig = async (method) => {
    const editData = editingPaymentMethods[method.id] || {};
    const displayInstructions = editData.display_instructions !== undefined
      ? editData.display_instructions
      : method.display_instructions;

    let bankAccounts = method.bank_accounts_json;
    if (editData.bank_account_number !== undefined || editData.bank_name !== undefined || editData.bank_code !== undefined || editData.bank_account_name !== undefined) {
      bankAccounts = [{
        bank_name: editData.bank_name !== undefined ? editData.bank_name : (method.bank_accounts_json?.[0]?.bank_name || ''),
        bank_code: editData.bank_code !== undefined ? editData.bank_code : (method.bank_accounts_json?.[0]?.bank_code || ''),
        account: editData.bank_account_number !== undefined ? editData.bank_account_number : (method.bank_accounts_json?.[0]?.account || ''),
        account_name: editData.bank_account_name !== undefined ? editData.bank_account_name : (method.bank_accounts_json?.[0]?.account_name || '')
      }];
    }

    setSavingPaymentId(method.id);
    try {
      await api.put(`/shop/admin/payment-methods/${method.id}`, {
        display_instructions: displayInstructions,
        bank_accounts_json: bankAccounts
      });
      alert(`「${method.name}」設定已成功儲存！`);
      fetchPaymentSettings();
    } catch (err) {
      alert('儲存付款方式失敗：' + (err.response?.data?.error || err.message));
    } finally {
      setSavingPaymentId(null);
    }
  };

  // Products handlers
  const fetchAdminProducts = async () => {
    try {
      setLoadingProducts(true);
      const res = await api.get('/shop/admin/products');
      setProducts(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch admin products:', err);
    } finally {
      setLoadingProducts(false);
    }
  };

  const handleSaveProduct = async (productData) => {
    try {
      if (productData.id) {
        await api.put(`/shop/admin/products/${productData.id}`, productData);
      } else {
        await api.post('/shop/admin/products', productData);
      }
      setEditProductModal(null);
      fetchAdminProducts();
    } catch (err) {
      alert('儲存商品失敗：' + (err.response?.data?.error || err.message));
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Tab Navigation */}
      <div className="bg-white rounded-2xl p-5 border border-[#E8DEC8] shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black text-[#3E332B] flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-[#8B5B43]" />
            <span>商品預購、金流對帳與商城管理</span>
          </h2>
          <p className="text-xs text-[#8C8279] mt-0.5">
            管理 221 色套裝預購單、中信社群收款一次性帳號池、許願回覆與到貨推播
          </p>
        </div>

        {/* Tab Pills */}
        <div className="flex bg-[#F5F0EB] p-1 rounded-xl text-xs font-bold text-[#6D5D52] self-stretch sm:self-auto">
          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg transition ${
              activeTab === 'orders' ? 'bg-[#8B5B43] text-white shadow-xs' : 'hover:text-[#3E332B]'
            }`}
          >
            📋 預購訂單與對帳
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('payments')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg transition ${
              activeTab === 'payments' ? 'bg-[#8B5B43] text-white shadow-xs' : 'hover:text-[#3E332B]'
            }`}
          >
            🏦 中信帳號池與金流
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('products')}
            className={`flex-1 sm:flex-none px-4 py-2 rounded-lg transition ${
              activeTab === 'products' ? 'bg-[#8B5B43] text-white shadow-xs' : 'hover:text-[#3E332B]'
            }`}
          >
            📦 商品與套餐設定
          </button>
        </div>
      </div>

      {/* ========================================================= */}
      {/* SUB-TAB 1: PREORDER ORDERS */}
      {/* ========================================================= */}
      {activeTab === 'orders' && (
        <div className="space-y-4">
          {/* Filter & Batch Action Bar */}
          <div className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-xs flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap flex-1 min-w-[280px]">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={orderSearch}
                  onChange={e => setOrderSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && fetchAdminOrders()}
                  placeholder="搜尋單號、姓名、電話、中信帳號或末五碼..."
                  className="w-full pl-9 pr-3 py-1.5 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-medium outline-none focus:border-[#8B5B43]"
                />
              </div>

              <select
                value={orderPaymentStatusFilter}
                onChange={e => {
                  setOrderPaymentStatusFilter(e.target.value);
                  setTimeout(fetchAdminOrders, 50);
                }}
                className="px-3 py-1.5 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] outline-none"
              >
                <option value="all">所有付款狀態</option>
                <option value="pending_payment">待繳納訂金</option>
                <option value="reported_pending_verify">已回報末五碼 (待對帳)</option>
                <option value="deposit_verified">已收訂金 (已對帳)</option>
                <option value="fully_paid">已全額結清</option>
              </select>

              <select
                value={orderStatusFilter}
                onChange={e => {
                  setOrderStatusFilter(e.target.value);
                  setTimeout(fetchAdminOrders, 50);
                }}
                className="px-3 py-1.5 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] outline-none"
              >
                <option value="all">所有訂單進度</option>
                <option value="preorder_placed">預購登記中</option>
                <option value="preparing">備貨中</option>
                <option value="arrived">商品已到貨</option>
                <option value="picked_up">已取貨完成</option>
                <option value="cancelled">已取消</option>
              </select>

              <button
                type="button"
                onClick={fetchAdminOrders}
                className="p-1.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl transition"
                title="重新整理"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Batch Notify Arrival Button */}
            {selectedOrderIds.length > 0 && (
              <button
                type="button"
                onClick={() => handleNotifyArrival(selectedOrderIds)}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-sm transition"
              >
                <Send className="w-3.5 h-3.5" />
                <span>📢 批次推播 LINE 到貨通知 ({selectedOrderIds.length})</span>
              </button>
            )}
          </div>

          {/* Orders Table */}
          <div className="bg-white rounded-2xl border border-[#E8DEC8] shadow-xs overflow-hidden">
            {loadingOrders ? (
              <div className="py-20 text-center text-[#8C8279] text-sm">載入訂單資料中...</div>
            ) : orders.length === 0 ? (
              <div className="py-20 text-center text-[#8C8279] text-sm">查無符合條件的預購訂單</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-[#FAF7F2] text-[#6D5D52] font-black border-b border-[#E8DEC8]">
                    <tr>
                      <th className="p-3 w-10 text-center">
                        <input
                          type="checkbox"
                          checked={selectedOrderIds.length === orders.length && orders.length > 0}
                          onChange={e => {
                            if (e.target.checked) setSelectedOrderIds(orders.map(o => o.id));
                            else setSelectedOrderIds([]);
                          }}
                          className="w-4 h-4 accent-[#8B5B43]"
                        />
                      </th>
                      <th className="p-3 whitespace-nowrap">預購單號 / 時間</th>
                      <th className="p-3 whitespace-nowrap">顧客資訊</th>
                      <th className="p-3 whitespace-nowrap">預購品項明細</th>
                      <th className="p-3 whitespace-nowrap">顧客款式許願 / 店家回覆</th>
                      <th className="p-3 whitespace-nowrap">付款方式 / 中信帳號 / 末五碼</th>
                      <th className="p-3 whitespace-nowrap">金額 (應收/已收/尾款)</th>
                      <th className="p-3 whitespace-nowrap">訂單進度</th>
                      <th className="p-3 text-right whitespace-nowrap">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F5F0EB]">
                    {orders.map((order) => {
                      const isSelected = selectedOrderIds.includes(order.id);
                      const isPaidDeposit = order.payment_status === 'deposit_verified' || order.payment_status === 'fully_paid';
                      const isReported = order.payment_status === 'reported_pending_verify';

                      return (
                        <tr key={order.id} className="hover:bg-[#FAF7F2]/60 transition">
                          <td className="p-3 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={e => {
                                if (e.target.checked) setSelectedOrderIds(prev => [...prev, order.id]);
                                else setSelectedOrderIds(prev => prev.filter(id => id !== order.id));
                              }}
                              className="w-4 h-4 accent-[#8B5B43]"
                            />
                          </td>

                          <td className="p-3 whitespace-nowrap">
                            <span className="font-mono font-black text-[#3E332B] block">
                              #{order.order_ref}
                            </span>
                            <span className="text-[11px] text-[#8C8279]">
                              {format(new Date(order.created_at), 'MM/dd HH:mm')}
                            </span>
                          </td>

                          <td className="p-3 whitespace-nowrap">
                            <span className="font-bold text-[#3E332B] block">
                              {order.user?.name || '無姓名'}
                            </span>
                            <span className="text-[11px] text-[#8C8279] block">
                              {order.user?.phone || '無電話'}
                            </span>
                            {order.user?.line_display_name && (
                              <span className="text-[10px] text-[#059941] font-semibold">
                                LINE: {order.user.line_display_name}
                              </span>
                            )}
                          </td>

                          <td className="p-3 max-w-[200px]">
                            <div className="space-y-0.5">
                              {order.items?.map((item) => (
                                <div key={item.id} className="truncate text-[11px]">
                                  <strong className="text-[#3E332B]">{item.product_name_snapshot}</strong>
                                  <span className="text-[#8C8279] ml-1">x{item.quantity}</span>
                                </div>
                              ))}
                            </div>
                          </td>

                          <td className="p-3 max-w-[220px]">
                            {order.wish_note ? (
                              <div className="bg-amber-50 p-2 rounded-lg border border-amber-200 text-amber-900 mb-1 leading-snug">
                                <span className="font-bold text-[10px] block text-amber-700">🎁 顧客許願：</span>
                                {order.wish_note}
                              </div>
                            ) : (
                              <span className="text-[#A8A19A] text-[11px] block">無許願</span>
                            )}

                            {order.wish_reply ? (
                              <div className="bg-[#FAF7F2] p-1.5 rounded-lg border border-[#E8DEC8] text-[#3E332B] text-[11px]">
                                <strong className="text-[#8B5B43]">💬 已回覆：</strong> {order.wish_reply}
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setWishReplyOrder(order);
                                  setWishReplyText(order.wish_reply || '');
                                }}
                                className="text-[11px] text-[#8B5B43] hover:underline font-bold"
                              >
                                ✏️ 填寫店家許願回覆
                              </button>
                            )}
                          </td>

                          <td className="p-3 whitespace-nowrap">
                            <span className="font-bold text-[#3E332B] block">
                              {order.payment_method_code === 'ctbc_pool' ? '中信社群收款' : '銀行匯款/其他'}
                            </span>
                            {order.assigned_pool_account && (
                              <span className="font-mono text-emerald-800 text-[11px] font-bold block">
                                中信: {order.assigned_pool_account}
                              </span>
                            )}
                            {order.remittance_last5 && (
                              <span className="font-mono text-blue-800 text-[11px] font-bold block">
                                末五碼: {order.remittance_last5}
                              </span>
                            )}
                          </td>

                          <td className="p-3 whitespace-nowrap">
                            <span className="font-mono font-bold text-[#3E332B] block">
                              總額 NT$ {order.total_amount?.toLocaleString()}
                            </span>
                            <span className={`text-[11px] font-bold block ${isPaidDeposit ? 'text-emerald-700' : 'text-amber-700'}`}>
                              已收訂金 NT$ {order.paid_amount?.toLocaleString()}
                            </span>
                            {order.balance_amount > 0 && (
                              <span className="text-[11px] text-[#8B5B43] font-bold block">
                                尾款 NT$ {order.balance_amount?.toLocaleString()}
                              </span>
                            )}
                          </td>

                          <td className="p-3 whitespace-nowrap">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-bold block w-fit mb-1 ${
                                order.order_status === 'cancelled'
                                  ? 'bg-gray-100 text-gray-500 line-through'
                                  : order.order_status === 'arrived'
                                  ? 'bg-rose-100 text-rose-800'
                                  : order.order_status === 'picked_up'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {order.order_status === 'cancelled'
                                ? '已取消'
                                : order.order_status === 'arrived'
                                ? '商品已到貨'
                                : order.order_status === 'picked_up'
                                ? '已取貨完成'
                                : '備貨登記中'}
                            </span>

                            <span
                              className={`px-2 py-0.5 rounded-md text-[10px] font-bold block w-fit ${
                                order.order_status === 'cancelled'
                                  ? 'bg-gray-100 text-gray-400'
                                  : order.payment_status === 'fully_paid'
                                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                  : isPaidDeposit
                                  ? 'bg-teal-50 text-teal-700 border border-teal-200'
                                  : isReported
                                  ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                  : 'bg-amber-50 text-amber-700 border border-amber-200'
                              }`}
                            >
                              {order.order_status === 'cancelled'
                                ? '已作廢'
                                : order.payment_status === 'fully_paid'
                                ? '全額結清'
                                : isPaidDeposit
                                ? '已收訂金'
                                : isReported
                                ? '已報待對帳'
                                : '待繳訂金'}
                            </span>
                          </td>

                          <td className="p-3 text-right whitespace-nowrap space-x-1">
                            {!isPaidDeposit && order.order_status !== 'cancelled' && (
                              <button
                                type="button"
                                onClick={() => {
                                  setVerifyModalOrder(order);
                                  setVerifyPaidAmount(String(order.deposit_required));
                                  setVerifyIsFullPayment(false);
                                  setVerifySendLine(true);
                                }}
                                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-2xs"
                              >
                                ✅ 對帳確認
                              </button>
                            )}

                            {order.order_status !== 'cancelled' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setWishReplyOrder(order);
                                    setWishReplyText(order.wish_reply || '');
                                  }}
                                  className="px-2 py-1 bg-[#FAF7F2] hover:bg-[#F0EBE5] text-[#8B5B43] border border-[#E8DEC8] rounded-lg text-xs font-bold transition"
                                  title="回覆許願"
                                >
                                  💬 許願
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setArrivalDateOrder(order);
                                    setArrivalDateText(order.estimated_arrival || '');
                                  }}
                                  className="px-2 py-1 bg-[#FAF7F2] hover:bg-[#F0EBE5] text-[#3E332B] border border-[#E8DEC8] rounded-lg text-xs font-bold transition"
                                  title="修改預計到貨日"
                                >
                                  📅 到貨日
                                </button>
                              </>
                            )}

                            {order.order_status !== 'picked_up' && order.order_status !== 'cancelled' && (
                              <button
                                type="button"
                                onClick={() => handleNotifyArrival([order.id])}
                                className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold transition"
                                title="發送 LINE 到貨通知"
                              >
                                📢 通知到貨
                              </button>
                            )}

                            {order.order_status !== 'picked_up' && order.order_status !== 'cancelled' && (
                              <button
                                type="button"
                                onClick={() => handleMarkPickedUp(order.id)}
                                className="px-2.5 py-1 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-lg text-xs font-bold transition"
                              >
                                📦 取貨完成
                              </button>
                            )}

                            {order.order_status !== 'picked_up' && order.order_status !== 'cancelled' && (
                              <button
                                type="button"
                                onClick={() => handleCancelOrder(order)}
                                className="px-2 py-1 bg-gray-50 hover:bg-rose-50 text-gray-500 hover:text-rose-700 border border-gray-200 hover:border-rose-200 rounded-lg text-xs font-bold transition"
                                title="取消此預購訂單並釋放中信帳號"
                              >
                                ❌ 取消
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* SUB-TAB 2: PAYMENT METHODS & CTBC ONE-TIME ACCOUNT POOL */}
      {/* ========================================================= */}
      {activeTab === 'payments' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CTBC One-Time Account Pool Management */}
          <div className="bg-white rounded-2xl p-6 border border-[#E8DEC8] shadow-xs space-y-5">
            <div>
              <h3 className="text-base font-black text-[#3E332B] flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-emerald-700" />
                <span>中信社群收款（一次性專屬帳號池）</span>
              </h3>
              <p className="text-xs text-[#8C8279] mt-0.5">
                店長可將中信社群收款產生的多組專屬帳號批次貼於此，顧客下單時系統將自動配發 1 組
              </p>
            </div>

            {/* Account Pool Counters */}
            <div className="grid grid-cols-4 gap-2 text-center text-xs">
              <div className="bg-[#FAF7F2] p-2.5 rounded-xl border border-[#E8DEC8]">
                <span className="text-[#8C8279] block text-[10px]">總組數</span>
                <strong className="font-mono font-black text-sm text-[#3E332B]">{poolSummary.total || 0}</strong>
              </div>
              <div className="bg-emerald-50 p-2.5 rounded-xl border border-emerald-200">
                <span className="text-emerald-700 block text-[10px]">剩餘可用</span>
                <strong className="font-mono font-black text-sm text-emerald-800">{poolSummary.available || 0}</strong>
              </div>
              <div className="bg-amber-50 p-2.5 rounded-xl border border-amber-200">
                <span className="text-amber-700 block text-[10px]">已配給訂單</span>
                <strong className="font-mono font-black text-sm text-amber-800">{poolSummary.assigned || 0}</strong>
              </div>
              <div className="bg-blue-50 p-2.5 rounded-xl border border-blue-200">
                <span className="text-blue-700 block text-[10px]">已對帳收款</span>
                <strong className="font-mono font-black text-sm text-blue-800">{poolSummary.used || 0}</strong>
              </div>
            </div>

            {/* Batch Import Textarea */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-[#6D5D52]">
                📥 批次匯入帳號（一行一組，可直接貼上，支援自動略過重複）：
              </label>
              <textarea
                rows="4"
                value={batchImportText}
                onChange={e => setBatchImportText(e.target.value)}
                placeholder="貼上帳號，格式如：&#10;822123456789012&#10;822123456789013,https://ctbc.tw/...,訂金$600專用"
                className="w-full px-3 py-2 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-mono outline-none focus:border-[#8B5B43]"
              />
              <button
                type="button"
                onClick={handleBatchImportPool}
                disabled={importingPool || !batchImportText.trim()}
                className="w-full py-2 bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{importingPool ? '匯入處理中...' : '匯入至一次性收款帳號池'}</span>
              </button>
            </div>

            {/* Pool Accounts Table */}
            <div className="max-h-60 overflow-y-auto border border-[#E8DEC8] rounded-xl divide-y divide-[#F5F0EB] text-xs">
              {accountPool.length === 0 ? (
                <div className="p-4 text-center text-[#8C8279]">目前帳號池尚無帳號，請由上方批次匯入</div>
              ) : (
                accountPool.slice(0, 30).map(item => (
                  <div key={item.id} className="p-2.5 flex items-center justify-between gap-2 hover:bg-[#FAF7F2]">
                    <div>
                      <span className="font-mono font-bold text-[#3E332B]">{item.account_number}</span>
                      {item.assigned_order_ref && (
                        <span className="ml-2 font-mono text-[10px] text-[#8B5B43]">
                          配給 #{item.assigned_order_ref}
                        </span>
                      )}
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        item.status === 'AVAILABLE'
                          ? 'bg-emerald-100 text-emerald-800'
                          : item.status === 'ASSIGNED'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {item.status === 'AVAILABLE' ? '可用' : item.status === 'ASSIGNED' ? '已配給' : '已收款'}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Payment Methods & Shop Settings Editor */}
          <div className="space-y-6">
            <div className="bg-white rounded-2xl p-6 border border-[#E8DEC8] shadow-xs space-y-4">
              <h3 className="text-base font-black text-[#3E332B] flex items-center gap-2">
                <Store className="w-4 h-4 text-[#8B5B43]" />
                <span>多元付款方式開關與前台說明文案</span>
              </h3>

              <div className="space-y-4">
                {paymentMethods.map(method => {
                  const editData = editingPaymentMethods[method.id] || {};
                  const currentInstructions = editData.display_instructions !== undefined
                    ? editData.display_instructions
                    : (method.display_instructions || '');

                  const firstBank = method.bank_accounts_json?.[0] || {};
                  const currentBankName = editData.bank_name !== undefined ? editData.bank_name : (firstBank.bank_name || '');
                  const currentBankCode = editData.bank_code !== undefined ? editData.bank_code : (firstBank.bank_code || '');
                  const currentAccountNumber = editData.bank_account_number !== undefined ? editData.bank_account_number : (firstBank.account || '');
                  const currentAccountName = editData.bank_account_name !== undefined ? editData.bank_account_name : (firstBank.account_name || '');

                  const isBankOrEwallet = method.code === 'bank_transfer' || method.code === 'jkopay' || (method.bank_accounts_json && method.bank_accounts_json.length > 0);
                  const isSaving = savingPaymentId === method.id;

                  return (
                    <div key={method.id} className="p-4 bg-[#FAF7F2] rounded-2xl border border-[#E8DEC8] space-y-3">
                      <div className="flex items-center justify-between pb-2 border-b border-[#E8DEC8]">
                        <div className="flex items-center gap-2">
                          <span className="font-black text-sm text-[#3E332B]">{method.name}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded bg-white border border-[#E8DEC8] text-[#8C8279] font-mono">
                            {method.code}
                          </span>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-[#6D5D52]">
                          <span>{method.is_enabled ? '已啟用' : '已停用'}</span>
                          <input
                            type="checkbox"
                            checked={method.is_enabled}
                            onChange={() => handleTogglePaymentMethod(method)}
                            className="w-4 h-4 accent-[#8B5B43] cursor-pointer"
                          />
                        </label>
                      </div>

                      {/* Instructions Textarea */}
                      <div>
                        <label className="block text-[11px] font-bold text-[#6D5D52] mb-1">
                          前台下單頁面說明文字：
                        </label>
                        <textarea
                          rows={2}
                          value={currentInstructions}
                          onChange={e => handleUpdatePaymentMethodField(method.id, 'display_instructions', e.target.value)}
                          placeholder="請輸入給顧客看的付款說明..."
                          className="w-full p-2.5 bg-white border border-[#E8DEC8] rounded-xl text-xs font-medium outline-none focus:border-[#8B5B43] text-[#3E332B]"
                        />
                      </div>

                      {/* Bank / E-Wallet Info Fields */}
                      {isBankOrEwallet && (
                        <div className="space-y-2 pt-1 border-t border-[#E8DEC8]/60">
                          <span className="text-[11px] font-bold text-[#8B5B43] block">
                            收款銀行 / 電支帳號資訊（若多組前台將展示）：
                          </span>
                          <div className="grid grid-cols-2 gap-2 text-xs">
                            <div>
                              <span className="text-[10px] text-[#8C8279] block mb-0.5">銀行 / 機構名稱</span>
                              <input
                                type="text"
                                value={currentBankName}
                                onChange={e => handleUpdatePaymentMethodField(method.id, 'bank_name', e.target.value)}
                                placeholder="例如: 國泰世華銀行"
                                className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs outline-none"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8C8279] block mb-0.5">總行代碼</span>
                              <input
                                type="text"
                                value={currentBankCode}
                                onChange={e => handleUpdatePaymentMethodField(method.id, 'bank_code', e.target.value)}
                                placeholder="例如: 013"
                                className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs outline-none font-mono"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8C8279] block mb-0.5">銀行帳號</span>
                              <input
                                type="text"
                                value={currentAccountNumber}
                                onChange={e => handleUpdatePaymentMethodField(method.id, 'bank_account_number', e.target.value)}
                                placeholder="例如: 013-123456789012"
                                className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs outline-none font-mono font-bold"
                              />
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8C8279] block mb-0.5">戶名</span>
                              <input
                                type="text"
                                value={currentAccountName}
                                onChange={e => handleUpdatePaymentMethodField(method.id, 'bank_account_name', e.target.value)}
                                placeholder="例如: 拾光製所工作室"
                                className="w-full px-2.5 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs outline-none"
                              />
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Save Button */}
                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => handleSavePaymentMethodConfig(method)}
                          className="px-3.5 py-1.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold transition shadow-2xs flex items-center gap-1.5 disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{isSaving ? '儲存中...' : `儲存「${method.name}」設定`}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Global Shop Rules Form */}
            <form
              onSubmit={handleSaveShopSettings}
              className="bg-white rounded-2xl p-6 border border-[#E8DEC8] shadow-xs space-y-4"
            >
              <h3 className="text-base font-black text-[#3E332B] flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#8B5B43]" />
                <span>預購全域營運設定</span>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">
                    訂金付款期限（天數，預設 2 天）：
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="14"
                    value={shopSettings.shop_deposit_deadline_days}
                    onChange={e => setShopSettings(prev => ({ ...prev, shop_deposit_deadline_days: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-bold outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">
                    官方對帳 LINE 連結：
                  </label>
                  <input
                    type="text"
                    value={shopSettings.official_line_url || ''}
                    onChange={e => setShopSettings(prev => ({ ...prev, official_line_url: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-medium outline-none"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block font-bold text-[#6D5D52] mb-1">
                    預設預計到貨說明文案：
                  </label>
                  <input
                    type="text"
                    value={shopSettings.shop_default_arrival_note || ''}
                    onChange={e => setShopSettings(prev => ({ ...prev, shop_default_arrival_note: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-medium outline-none"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="px-6 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold transition shadow-xs"
                >
                  {savingSettings ? '儲存中...' : '儲存全域設定'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* SUB-TAB 3: PRODUCTS & BUNDLES MANAGEMENT */}
      {/* ========================================================= */}
      {activeTab === 'products' && (
        <div className="space-y-4">
          <div className="flex justify-between items-center bg-white p-4 rounded-2xl border border-[#E8DEC8]">
            <span className="text-xs font-bold text-[#6D5D52]">
              共建檔 {products.length} 項預購套餐與專業工具商品
            </span>
            <button
              type="button"
              onClick={() => setEditProductModal({})}
              className="px-4 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-xs transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ 新增商品</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {products.map(prod => (
              <div
                key={prod.id}
                className="bg-white rounded-2xl p-5 border border-[#E8DEC8] shadow-xs flex flex-col justify-between space-y-3"
              >
                <div className="space-y-2">
                  <div className="flex justify-between items-start gap-2">
                    <div>
                      <span className="font-bold text-sm text-[#3E332B] block">{prod.name}</span>
                      <span className="font-mono text-[11px] text-[#8C8279]">代碼: {prod.code}</span>
                    </div>
                    <span className="font-black text-sm text-[#8B5B43]">NT$ {prod.price}</span>
                  </div>
                  <p className="text-xs text-[#8C8279] line-clamp-2">{prod.description}</p>
                </div>

                <div className="pt-3 border-t border-[#F5F0EB] flex justify-between items-center text-xs">
                  <span className="text-emerald-800 font-bold">
                    訂金: NT$ {prod.deposit_amount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditProductModal(prod)}
                    className="px-3 py-1 bg-[#FAF7F2] hover:bg-[#8B5B43] text-[#8B5B43] hover:text-white border border-[#E8DEC8] rounded-lg font-bold transition flex items-center gap-1"
                  >
                    <Edit2 className="w-3 h-3" />
                    <span>編輯</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODALS */}
      {/* ========================================================= */}
      {/* 1. Verify Payment Modal */}
      {verifyModalOrder && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 shadow-2xl border border-[#E8DEC8] w-full max-w-md space-y-4 animate-zoom-in">
            <div className="flex justify-between items-center border-b border-[#E8DEC8] pb-3">
              <h3 className="font-black text-base text-[#3E332B]">✅ 款項對帳確認</h3>
              <button onClick={() => setVerifyModalOrder(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[#8C8279]">單號：</span>
                <span className="font-mono font-bold text-[#3E332B]">#{verifyModalOrder.order_ref}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8C8279]">顧客：</span>
                <span className="font-bold text-[#3E332B]">{verifyModalOrder.user?.name} ({verifyModalOrder.user?.phone})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8C8279]">總額 / 應付訂金：</span>
                <span className="font-bold text-[#8B5B43]">
                  總額 NT$ {verifyModalOrder.total_amount} / 訂金 NT$ {verifyModalOrder.deposit_required}
                </span>
              </div>
            </div>

            <div className="space-y-3 pt-2">
              <div>
                <label className="block text-xs font-bold text-[#6D5D52] mb-1">本次實收金額 ($)：</label>
                <input
                  type="number"
                  value={verifyPaidAmount}
                  onChange={e => setVerifyPaidAmount(e.target.value)}
                  className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-mono font-bold text-sm outline-none"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="fullPay"
                  checked={verifyIsFullPayment}
                  onChange={e => {
                    setVerifyIsFullPayment(e.target.checked);
                    if (e.target.checked) setVerifyPaidAmount(String(verifyModalOrder.total_amount));
                    else setVerifyPaidAmount(String(verifyModalOrder.deposit_required));
                  }}
                  className="w-4 h-4 accent-[#8B5B43]"
                />
                <label htmlFor="fullPay" className="text-xs font-bold text-[#3E332B]">
                  標記為「已全額結清」（無取貨尾款）
                </label>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sendLine"
                  checked={verifySendLine}
                  onChange={e => setVerifySendLine(e.target.checked)}
                  className="w-4 h-4 accent-[#8B5B43]"
                />
                <label htmlFor="sendLine" className="text-xs font-bold text-emerald-800">
                  同步發送《🎉 訂金對帳成功通知卡》至顧客 LINE
                </label>
              </div>
            </div>

            <div className="pt-3 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setVerifyModalOrder(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-[#3E332B] rounded-xl text-xs font-bold"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleVerifyPaymentSubmit}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-xs"
              >
                確認對帳
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Wish Reply Modal (STRICTLY NO LINE PUSHED) */}
      {wishReplyOrder && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 shadow-2xl border border-[#E8DEC8] w-full max-w-md space-y-4 animate-zoom-in">
            <div className="flex justify-between items-center border-b border-[#E8DEC8] pb-3">
              <h3 className="font-black text-base text-[#3E332B]">💬 店家許願回覆（直接顯示於訂單內）</h3>
              <button onClick={() => setWishReplyOrder(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {wishReplyOrder.wish_note && (
              <div className="bg-amber-50 p-3 rounded-xl border border-amber-200 text-xs text-amber-900">
                <strong>顧客當初許願：</strong> {wishReplyOrder.wish_note}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-[#6D5D52]">店家回覆內容：</label>
              <textarea
                rows="3"
                value={wishReplyText}
                onChange={e => setWishReplyText(e.target.value)}
                placeholder="例如：已為您備妥吉伊卡哇配色款工具組！到店時將一併交付給您✨"
                className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl text-xs outline-none focus:border-[#8B5B43]"
              />
              <p className="text-[11px] text-[#8C8279]">
                💡 此回覆將即時顯示在顧客端的「我的預購訂單」內，不會發送 LINE 干擾顧客。
              </p>
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWishReplyOrder(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-[#3E332B] rounded-xl text-xs font-bold"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleWishReplySubmit}
                className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold shadow-xs"
              >
                儲存回覆
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Arrival Date Edit Modal */}
      {arrivalDateOrder && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 shadow-2xl border border-[#E8DEC8] w-full max-w-md space-y-4 animate-zoom-in">
            <div className="flex justify-between items-center border-b border-[#E8DEC8] pb-3">
              <h3 className="font-black text-base text-[#3E332B]">📅 修改預計到貨／取貨日期區間</h3>
              <button onClick={() => setArrivalDateOrder(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-[#6D5D52]">預計到貨文字：</label>
              <input
                type="text"
                value={arrivalDateText}
                onChange={e => setArrivalDateText(e.target.value)}
                placeholder="例如：預計 11/10 ~ 11/15 到貨"
                className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl text-xs font-bold outline-none"
              />
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setArrivalDateOrder(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-[#3E332B] rounded-xl text-xs font-bold"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleArrivalDateSubmit}
                className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold shadow-xs"
              >
                儲存日期
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 4. Edit Product Modal */}
      {editProductModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-3xl p-6 shadow-2xl border border-[#E8DEC8] w-full max-w-lg space-y-4 max-h-[90vh] overflow-y-auto animate-zoom-in">
            <div className="flex justify-between items-center border-b border-[#E8DEC8] pb-3">
              <h3 className="font-black text-base text-[#3E332B]">
                {editProductModal.id ? '✏️ 編輯商品資訊' : '➕ 新增商品品項'}
              </h3>
              <button onClick={() => setEditProductModal(null)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-bold text-[#6D5D52] mb-1">商品名稱：</label>
                <input
                  type="text"
                  value={editProductModal.name || ''}
                  onChange={e => setEditProductModal(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-bold outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">商品代碼 (Code)：</label>
                  <input
                    type="text"
                    value={editProductModal.code || ''}
                    onChange={e => setEditProductModal(prev => ({ ...prev, code: e.target.value }))}
                    disabled={!!editProductModal.id}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-mono font-bold outline-none disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">分類：</label>
                  <select
                    value={editProductModal.category || 'bundle'}
                    onChange={e => setEditProductModal(prev => ({ ...prev, category: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-bold outline-none"
                  >
                    <option value="bundle">📦 套裝預購</option>
                    <option value="beads">🌈 融合豆</option>
                    <option value="tools">🖊️ 3D工具</option>
                    <option value="boards">📏 豆板</option>
                    <option value="cloth">🧻 烘焙布</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">售價 ($)：</label>
                  <input
                    type="number"
                    value={editProductModal.price || 0}
                    onChange={e => setEditProductModal(prev => ({ ...prev, price: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-mono font-bold outline-none"
                  />
                </div>

                <div>
                  <label className="block font-bold text-[#6D5D52] mb-1">預購訂金金額 ($)：</label>
                  <input
                    type="number"
                    value={editProductModal.deposit_amount || 0}
                    onChange={e => setEditProductModal(prev => ({ ...prev, deposit_amount: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-mono font-bold outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block font-bold text-[#6D5D52] mb-1">預計到貨說明：</label>
                <input
                  type="text"
                  value={editProductModal.estimated_arrival_text || ''}
                  onChange={e => setEditProductModal(prev => ({ ...prev, estimated_arrival_text: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-medium outline-none"
                />
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  type="checkbox"
                  id="allowWish"
                  checked={!!editProductModal.allow_wish_input}
                  onChange={e => setEditProductModal(prev => ({ ...prev, allow_wish_input: e.target.checked }))}
                  className="w-4 h-4 accent-[#8B5B43]"
                />
                <label htmlFor="allowWish" className="font-bold text-[#3E332B]">
                  開放顧客輸入款式／IP角色許願欄
                </label>
              </div>

              <div>
                <label className="block font-bold text-[#6D5D52] mb-1">商品說明：</label>
                <textarea
                  rows="2"
                  value={editProductModal.description || ''}
                  onChange={e => setEditProductModal(prev => ({ ...prev, description: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8DEC8] rounded-xl font-medium outline-none"
                />
              </div>
            </div>

            <div className="pt-3 flex justify-end gap-2 border-t border-[#E8DEC8]">
              <button
                type="button"
                onClick={() => setEditProductModal(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-[#3E332B] rounded-xl text-xs font-bold"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleSaveProduct(editProductModal)}
                className="px-5 py-2 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold shadow-xs"
              >
                確認儲存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

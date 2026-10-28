import React, { useState, useEffect } from 'react';
import {
  ShoppingBag,
  Sparkles,
  Package,
  Clock,
  Check,
  CreditCard,
  Copy,
  ExternalLink,
  ChevronRight,
  Plus,
  Minus,
  AlertCircle,
  Truck,
  Store,
  MessageCircle,
  Gift
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';

export default function ShopPage() {
  const navigate = useNavigate();
  const [products, setProducts] = useState([]);
  const [paymentConfig, setPaymentConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState({}); // { [productId]: quantity }
  const [wishNote, setWishNote] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [beadColorNote, setBeadColorNote] = useState('');
  const [selectedPaymentCode, setSelectedPaymentCode] = useState('ctbc_pool');
  const [selectedBankInfo, setSelectedBankInfo] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState('store_pickup');
  const [shippingAddress, setShippingAddress] = useState({ name: '', phone: '', address: '' });
  const [remittanceLast5, setRemittanceLast5] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [completedOrder, setCompletedOrder] = useState(null);
  const [copiedAccount, setCopiedAccount] = useState(false);
  const [last5Submitted, setLast5Submitted] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');

  useEffect(() => {
    fetchShopData();
  }, []);

  const fetchShopData = async () => {
    try {
      setLoading(true);
      const [prodRes, payRes] = await Promise.all([
        api.get('/shop/products'),
        api.get('/shop/payment-methods')
      ]);

      const prods = Array.isArray(prodRes.data) ? prodRes.data : [];
      setProducts(prods);
      setPaymentConfig(payRes.data);

      // Default select first available payment method (if CTBC pool empty, select another)
      if (payRes.data?.payment_methods?.length > 0) {
        const methods = payRes.data.payment_methods;
        const poolCount = payRes.data.ctbc_pool_available_count ?? 0;
        const defaultMethod = methods.find(m => m.code === 'ctbc_pool' && poolCount > 0) ||
                              methods.find(m => m.code !== 'ctbc_pool') ||
                              methods[0];
        if (defaultMethod) {
          setSelectedPaymentCode(defaultMethod.code);
        }
      }
    } catch (err) {
      console.error('Failed to load shop data:', err);
    } finally {
      setLoading(false);
    }
  };

  const updateCartQty = (productId, delta) => {
    setCart(prev => {
      const current = prev[productId] || 0;
      const next = Math.max(0, current + delta);
      if (next === 0) {
        const copy = { ...prev };
        delete copy[productId];
        return copy;
      }
      return { ...prev, [productId]: next };
    });
  };

  const setCartQty = (productId, qty) => {
    const val = Math.max(0, parseInt(qty, 10) || 0);
    setCart(prev => {
      if (val === 0) {
        const copy = { ...prev };
        delete copy[productId];
        return copy;
      }
      return { ...prev, [productId]: val };
    });
  };

  // Compute pricing
  const bundleProduct = products.find(p => p.category === 'bundle');
  const beadsProduct = products.find(p => p.category === 'beads');

  const calculateItemSubtotal = (product, qty) => {
    if (!product || qty <= 0) return 0;
    if (Array.isArray(product.tier_pricing) && product.tier_pricing.length > 0) {
      const sortedTiers = [...product.tier_pricing].sort((a, b) => (b.qty || 0) - (a.qty || 0));
      let remaining = qty;
      let total = 0;
      for (const tier of sortedTiers) {
        if (remaining >= tier.qty && tier.qty > 0) {
          const count = Math.floor(remaining / tier.qty);
          total += count * tier.price;
          remaining = remaining % tier.qty;
        }
      }
      if (remaining > 0) {
        total += remaining * product.price;
      }
      return total;
    }
    return product.price * qty;
  };

  const cartItemsList = Object.entries(cart).map(([pId, qty]) => {
    const prod = products.find(p => p.id === parseInt(pId, 10));
    const subtotal = prod ? calculateItemSubtotal(prod, qty) : 0;
    const deposit = prod && prod.is_preorder
      ? (prod.deposit_amount > 0 ? Math.min(prod.deposit_amount * qty, subtotal) : subtotal)
      : subtotal;
    return { product: prod, qty, subtotal, deposit };
  }).filter(item => item.product && item.qty > 0);

  const cartTotalAmount = cartItemsList.reduce((sum, item) => sum + item.subtotal, 0);
  const cartDepositRequired = cartItemsList.reduce((sum, item) => sum + item.deposit, 0);
  const hasBundleInCart = cartItemsList.some(item => item.product?.category === 'bundle');
  const hasBeadsInCart = cartItemsList.some(item => item.product?.category === 'beads');

  const selectedPaymentMethod = paymentConfig?.payment_methods?.find(
    m => m.code === selectedPaymentCode
  );

  const handleOrderSubmit = async (e) => {
    e.preventDefault();
    if (cartItemsList.length === 0) {
      alert('請至少選擇一項欲預購或購買的商品！');
      return;
    }

    setIsSubmitting(true);
    try {
      const combinedCustomerNote = [
        hasBeadsInCart && beadColorNote ? `【融合豆色號明細】：${beadColorNote}` : '',
        customerNote ? `【一般備註】：${customerNote}` : ''
      ].filter(Boolean).join('\n');

      const payload = {
        items: cartItemsList.map(item => ({
          product_id: item.product.id,
          quantity: item.qty,
          customization_note: item.product.category === 'beads' ? beadColorNote : null
        })),
        payment_method_code: selectedPaymentCode,
        selected_bank_info: selectedBankInfo || null,
        delivery_method: deliveryMethod,
        shipping_info: deliveryMethod === 'shipping' ? shippingAddress : null,
        wish_note: hasBundleInCart && wishNote ? wishNote.trim() : null,
        customer_note: combinedCustomerNote || null,
        remittance_last5: remittanceLast5.trim() || null
      };

      const res = await api.post('/shop/orders', payload);
      setCompletedOrder(res.data.order);
      setCart({});
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      console.error('Submit preorder error:', err);
      alert(err.response?.data?.error || err.message || '預購訂單送出失敗，請確認是否已登入！');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickSubmitLast5 = async () => {
    if (!completedOrder || !remittanceLast5.trim()) return;
    try {
      await api.patch(`/shop/orders/${completedOrder.id}/remittance`, {
        remittance_last5: remittanceLast5.trim()
      });
      setLast5Submitted(true);
    } catch (err) {
      alert('回傳末五碼失敗：' + (err.response?.data?.error || err.message));
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#FAF7F2] flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-4 border-[#8B5B43] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-bold text-[#6D5D52]">載入商品預購商城中...</p>
        </div>
      </div>
    );
  }

  // If order was just placed, display high-conversion confirmation card
  if (completedOrder) {
    return (
      <div className="min-h-screen bg-[#FAF7F2] py-8 px-4 sm:px-6">
        <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-xl border border-[#E8DEC8] overflow-hidden">
          {/* Header */}
          <div className="bg-[#8B5B43] text-white p-6 sm:p-8 text-center space-y-2">
            <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-inner">
              <Check className="w-8 h-8 text-white stroke-[3]" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-black">預購訂單建立成功！</h2>
            <p className="text-sm text-[#FAF7F2]/90">
              感謝您的訂購，我們已為您保留套裝預購名額。
            </p>
          </div>

          <div className="p-6 sm:p-8 space-y-6">
            {/* Order Ref & Deadline Banner */}
            <div className="bg-[#FAF7F2] rounded-2xl p-4 sm:p-5 border border-[#E8DEC8] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <span className="text-xs text-[#8C8279] font-bold block">預購單號</span>
                <span className="font-mono font-black text-lg text-[#3E332B]">{completedOrder.order_ref}</span>
              </div>
              <div className="bg-amber-100 text-amber-900 px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                <span>請於 2 天內完成訂金支付</span>
              </div>
            </div>

            {/* CTBC One-Time Account Pool Banner */}
            {completedOrder.payment_method_code === 'ctbc_pool' && (
              <div className="bg-emerald-50 rounded-2xl p-5 border-2 border-emerald-300 space-y-3">
                <div className="flex items-center gap-2 text-emerald-900 font-extrabold text-sm">
                  <CreditCard className="w-4 h-4 text-emerald-700" />
                  <span>您的一對一專屬「中信社群一次性收款帳號」已分配：</span>
                </div>
                <div className="bg-white p-4 rounded-xl border border-emerald-200 flex items-center justify-between gap-3">
                  <div>
                    <span className="text-xs text-slate-500 block">中國信託商業銀行 (822)</span>
                    <span className="font-mono font-black text-xl text-emerald-800 tracking-wider">
                      {completedOrder.assigned_pool_account || '現場專屬號碼已備妥'}
                    </span>
                  </div>
                  {completedOrder.assigned_pool_account && (
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(completedOrder.assigned_pool_account);
                        setCopiedAccount(true);
                        setTimeout(() => setCopiedAccount(false), 2000);
                      }}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold flex items-center gap-1.5 transition shrink-0"
                    >
                      {copiedAccount ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedAccount ? '已複製' : '一鍵複製'}</span>
                    </button>
                  )}
                </div>
                <p className="text-xs text-emerald-800">
                  💡 此帳號為您個人專屬之一次性收款帳號，轉帳後系統將自動進行比對！
                </p>
                {paymentConfig?.official_line_url && (
                  <a
                    href={paymentConfig.official_line_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 w-full py-2.5 bg-[#06C755] hover:bg-[#05b34c] text-white rounded-xl text-xs font-extrabold shadow-sm transition"
                  >
                    <MessageCircle className="w-4 h-4" />
                    <span>💬 點此傳送 LINE 訊息至官方帳號進行對帳</span>
                  </a>
                )}
              </div>
            )}

            {/* Remittance Last 5 Digits Input */}
            <div className="bg-white rounded-2xl p-5 border border-[#E8DEC8] space-y-3">
              <label className="block text-xs font-bold text-[#3E332B]">
                ✏️ 回填匯款帳號末五碼（對帳更迅速）：
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  maxLength="5"
                  value={remittanceLast5}
                  onChange={e => setRemittanceLast5(e.target.value.replace(/\D/g, ''))}
                  placeholder="請填寫 5 碼數字"
                  className="flex-1 px-4 py-2 border border-[#E8DEC8] rounded-xl text-sm font-bold font-mono outline-none focus:border-[#8B5B43]"
                />
                <button
                  type="button"
                  onClick={handleQuickSubmitLast5}
                  disabled={!remittanceLast5.trim() || last5Submitted}
                  className="px-5 py-2 bg-[#8B5B43] hover:bg-[#7A4F3A] disabled:opacity-50 text-white rounded-xl text-xs font-bold transition shrink-0"
                >
                  {last5Submitted ? '✅ 已回填' : '確認送出'}
                </button>
              </div>
              <p className="text-[11px] text-[#8C8279]">
                稍後您亦可隨時在「預購訂單查詢」頁面補填或修改末五碼。
              </p>
            </div>

            {/* Price & Pickup Details */}
            <div className="bg-[#FAF7F2] rounded-2xl p-5 border border-[#E8DEC8] space-y-2.5 text-xs">
              <div className="flex justify-between text-[#6D5D52]">
                <span>訂單總金額</span>
                <span className="font-bold text-[#3E332B]">NT$ {completedOrder.total_amount?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-emerald-800 font-bold">
                <span>應付訂金</span>
                <span>NT$ {completedOrder.deposit_required?.toLocaleString()}</span>
              </div>
              <div className="flex justify-between text-[#8B5B43] font-bold">
                <span>門市取貨待付尾款</span>
                <span>NT$ {completedOrder.balance_amount?.toLocaleString()}</span>
              </div>
              <div className="pt-2 border-t border-[#E8DEC8] flex justify-between text-[#6D5D52]">
                <span>預計到貨區間</span>
                <span className="font-bold text-[#3E332B]">{completedOrder.estimated_arrival || '依門市到貨通知為準'}</span>
              </div>
              {completedOrder.wish_note && (
                <div className="pt-1 text-[#8B5B43]">
                  <span className="font-bold">您的許願：</span> {completedOrder.wish_note}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={() => navigate('/history')}
                className="flex-1 py-3 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white rounded-xl font-bold text-sm text-center transition shadow-xs"
              >
                📋 前往「我的預購紀錄」查看
              </button>
              <button
                type="button"
                onClick={() => setCompletedOrder(null)}
                className="py-3 px-6 bg-slate-100 hover:bg-slate-200 text-[#3E332B] rounded-xl font-bold text-sm transition"
              >
                繼續選購
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FAF7F2] text-[#3E332B] pb-24">
      {/* Sticky Top Header Navigation */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-[#E8DEC8] px-4 py-3 shadow-2xs">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center p-1 shrink-0">
              <img src="/logo.png" alt="拾光製所" className="w-full h-full object-contain" />
            </div>
            <div>
              <span className="font-black text-sm text-[#3E332B] block leading-tight">拾光製所</span>
              <span className="text-[10px] text-[#8C8279] block">商品預購商城</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => navigate('/booking')}
              className="px-3 py-1.5 bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] text-[#8B5B43] rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-2xs"
            >
              <span>🎨 手作預約</span>
            </button>
            <button
              type="button"
              onClick={() => navigate('/history')}
              className="px-3.5 py-1.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-xs"
            >
              <span>📋 我的紀錄與條碼</span>
            </button>
          </div>
        </div>
      </header>

      {/* Top Banner Hero */}
      <div className="bg-linear-to-b from-[#3E332B] to-[#2B231D] text-white py-10 px-4 sm:px-6">
        <div className="max-w-5xl mx-auto space-y-3 text-center sm:text-left">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#8B5B43]/60 rounded-full text-xs font-bold text-[#FAF7F2] border border-white/10">
            <Sparkles className="w-3.5 h-3.5 text-amber-300" />
            <span>拾光製所 官方商品預購商城</span>
          </div>
          <h1 className="text-2xl sm:text-4xl font-black tracking-tight">
            221 色拼豆套裝預購 ＆ 專業工具單品
          </h1>
          <p className="text-xs sm:text-sm text-[#D5CFC9] max-w-2xl leading-relaxed">
            線上搶先預購享有訂金保留、贈品款式專屬許願，到店取貨再贈免費代燙集次卡！
          </p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-6 space-y-8">
        {/* Featured Card: 221-Color Bundle Hero */}
        {bundleProduct && (
          <div className="bg-white rounded-3xl p-6 sm:p-8 border-2 border-[#8B5B43] shadow-lg relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-[#8B5B43] text-white px-5 py-1.5 rounded-bl-2xl text-xs font-extrabold tracking-wider">
              🔥 鎮店主打 限量預購
            </div>

            <div className="flex flex-col lg:flex-row gap-6 items-start">
              <div className="w-full lg:w-2/5 aspect-4/3 rounded-2xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center p-6 text-center relative overflow-hidden group">
                {bundleProduct.image_url ? (
                  <img
                    src={bundleProduct.image_url}
                    alt={bundleProduct.name}
                    className="w-full h-full object-cover rounded-xl"
                  />
                ) : (
                  <div className="space-y-3">
                    <div className="w-20 h-20 bg-[#8B5B43]/15 rounded-3xl flex items-center justify-center mx-auto text-4xl">
                      📦
                    </div>
                    <div>
                      <h4 className="font-black text-lg text-[#3E332B]">221色 全配套裝</h4>
                      <p className="text-xs text-[#8C8279]">全系列色號一次備齊</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex-1 space-y-4">
                <div>
                  <h3 className="text-xl sm:text-2xl font-black text-[#3E332B]">{bundleProduct.name}</h3>
                  <p className="text-xs text-[#6D5D52] mt-1.5 leading-relaxed">
                    {bundleProduct.description}
                  </p>
                </div>

                {/* Bundle Perks Pills */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  <div className="p-2.5 bg-amber-50 rounded-xl border border-amber-200 text-amber-900 flex items-center gap-2 font-bold">
                    <Gift className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>加贈專屬 3D 列印工具組（可許願）</span>
                  </div>
                  <div className="p-2.5 bg-rose-50 rounded-xl border border-rose-200 text-rose-900 flex items-center gap-2 font-bold">
                    <Sparkles className="w-4 h-4 text-rose-700 shrink-0" />
                    <span>取貨再贈：中板內免費代燙 5 件卡</span>
                  </div>
                </div>

                {/* Arrival text banner */}
                <div className="bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8] text-xs text-[#6D5D52] flex items-center gap-2">
                  <Clock className="w-4 h-4 text-[#8B5B43] shrink-0" />
                  <span>{bundleProduct.estimated_arrival_text || '預計 11/10 ~ 11/15 到貨'}</span>
                </div>

                {/* Price and Cart Action */}
                <div className="pt-2 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                  <div>
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl sm:text-3xl font-black text-[#8B5B43]">
                        NT$ {bundleProduct.price.toLocaleString()}
                      </span>
                      <span className="text-xs text-[#8C8279]">/ 套</span>
                    </div>
                    <span className="text-xs font-bold text-emerald-800">
                      預購先付訂金：NT$ {bundleProduct.deposit_amount}（取貨時再付尾款）
                    </span>
                  </div>

                  <div className="flex items-center gap-3 w-full sm:w-auto">
                    {cart[bundleProduct.id] ? (
                      <div className="flex items-center border border-[#8B5B43] rounded-xl bg-white shadow-xs">
                        <button
                          type="button"
                          onClick={() => updateCartQty(bundleProduct.id, -1)}
                          className="px-3 py-2 text-[#8B5B43] hover:bg-[#FAF7F2] transition"
                        >
                          <Minus className="w-4 h-4" />
                        </button>
                        <span className="px-4 font-mono font-bold text-sm">{cart[bundleProduct.id]}</span>
                        <button
                          type="button"
                          onClick={() => updateCartQty(bundleProduct.id, 1)}
                          className="px-3 py-2 text-[#8B5B43] hover:bg-[#FAF7F2] transition"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => updateCartQty(bundleProduct.id, 1)}
                        className="w-full sm:w-auto px-6 py-3 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white rounded-xl text-sm font-black shadow-md transition flex items-center justify-center gap-2"
                      >
                        <ShoppingBag className="w-4 h-4" />
                        <span>立即預購套裝</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Wish Input Box (Appears when bundle is selected) */}
                {cart[bundleProduct.id] > 0 && (
                  <div className="pt-3 border-t border-[#E8DEC8] space-y-2 animate-fade-in">
                    <label className="block text-xs font-bold text-[#8B5B43] flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>✨ 贈品 3D 列印工具組 — 風格／IP角色許願欄：</span>
                    </label>
                    <input
                      type="text"
                      value={wishNote}
                      onChange={e => setWishNote(e.target.value)}
                      placeholder={bundleProduct.wish_input_placeholder || '可輸入喜歡的顏色、款式或 IP 角色（例如：吉伊卡哇、粉色系、雙針筆優先）'}
                      className="w-full px-4 py-2.5 text-xs font-bold bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl outline-none focus:border-[#8B5B43] text-[#3E332B]"
                    />
                    <p className="text-[11px] text-[#8C8279]">
                      💡 店家備妥後會在您的訂單內回覆準備的款式，歡迎盡情許願！
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Individual Items Category Pills */}
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg sm:text-xl font-black text-[#3E332B] flex items-center gap-2">
              <Package className="w-5 h-5 text-[#8B5B43]" />
              <span>單品加購區（融合豆、工具、豆板、烘焙布）</span>
            </h2>
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs font-bold">
              {[
                { id: 'all', label: '全部商品' },
                { id: 'beads', label: '🌈 融合豆' },
                { id: 'tools', label: '🖊️ 3D工具' },
                { id: 'boards', label: '📏 豆板' },
                { id: 'cloth', label: '🧻 烘焙布' }
              ].map(cat => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className={`px-3 py-1.5 rounded-xl transition whitespace-nowrap ${
                    activeCategory === cat.id
                      ? 'bg-[#8B5B43] text-white shadow-xs'
                      : 'bg-white text-[#6D5D52] border border-[#E8DEC8] hover:bg-[#F5F0EB]'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Tier Pricing Banner for Beads */}
          {beadsProduct && (activeCategory === 'all' || activeCategory === 'beads') && (
            <div className="bg-linear-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div className="space-y-1">
                <span className="text-xs font-black text-amber-900 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-700" />
                  <span>🌈 221色高品質融合豆 10g包 — 多包自動階梯優惠：</span>
                </span>
                <p className="text-xs text-amber-800">
                  單包 $16 ｜ <strong className="text-amber-950 font-black">滿 10 包 $150</strong>（每包 $15） ｜ <strong className="text-rose-700 font-black">滿 20 包 $280</strong>（每包 $14）！
                </p>
              </div>
              {cart[beadsProduct.id] > 0 && (
                <span className="px-3 py-1 bg-amber-600 text-white rounded-lg text-xs font-bold shrink-0">
                  已選 {cart[beadsProduct.id]} 包（小計 NT$ {calculateItemSubtotal(beadsProduct, cart[beadsProduct.id])}）
                </span>
              )}
            </div>
          )}

          {/* Products Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {products
              .filter(p => p.category !== 'bundle')
              .filter(p => activeCategory === 'all' || p.category === activeCategory)
              .map(prod => {
                const qty = cart[prod.id] || 0;
                return (
                  <div
                    key={prod.id}
                    className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-xs flex flex-col justify-between hover:shadow-md transition"
                  >
                    <div className="space-y-2">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="font-bold text-sm text-[#3E332B]">{prod.name}</h4>
                        <span className="font-black text-sm text-[#8B5B43] whitespace-nowrap">
                          NT$ {prod.price}
                        </span>
                      </div>
                      <p className="text-xs text-[#8C8279] line-clamp-2">
                        {prod.description}
                      </p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-[#F5F0EB] flex items-center justify-between">
                      <span className="text-[11px] text-[#8C8279]">
                        {prod.category === 'beads' ? '每包約 1000 顆' : '門市自取'}
                      </span>

                      {qty > 0 ? (
                        <div className="flex items-center border border-[#8B5B43] rounded-lg bg-white">
                          <button
                            type="button"
                            onClick={() => updateCartQty(prod.id, -1)}
                            className="px-2 py-1 text-[#8B5B43] hover:bg-[#FAF7F2]"
                          >
                            <Minus className="w-3.5 h-3.5" />
                          </button>
                          <span className="px-2.5 font-mono font-bold text-xs">{qty}</span>
                          <button
                            type="button"
                            onClick={() => updateCartQty(prod.id, 1)}
                            className="px-2 py-1 text-[#8B5B43] hover:bg-[#FAF7F2]"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => updateCartQty(prod.id, 1)}
                          className="px-3 py-1.5 bg-[#FAF7F2] hover:bg-[#8B5B43] text-[#8B5B43] hover:text-white border border-[#E8DEC8] hover:border-[#8B5B43] rounded-lg text-xs font-bold transition flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>加購</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Beads Color Notes Input if Beads in Cart */}
          {hasBeadsInCart && (
            <div className="bg-white p-4 sm:p-5 rounded-2xl border border-[#E8DEC8] space-y-2 animate-fade-in">
              <label className="block text-xs font-bold text-[#8B5B43] flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" />
                <span>🌈 10g 融合豆 — 色號明細填寫：</span>
              </label>
              <textarea
                rows="2"
                value={beadColorNote}
                onChange={e => setBeadColorNote(e.target.value)}
                placeholder="請輸入您欲購買的色號與包數（例如：A01 x2包、B12 x3包、黑色 5包...，若尚未決定亦可取貨現場挑選）"
                className="w-full px-3 py-2 text-xs font-medium border border-[#E8DEC8] rounded-xl outline-none focus:border-[#8B5B43] text-[#3E332B]"
              />
            </div>
          )}
        </div>

        {/* Checkout & Payment Box */}
        {cartItemsList.length > 0 && (
          <form
            onSubmit={handleOrderSubmit}
            className="bg-white rounded-3xl p-6 sm:p-8 border-2 border-[#8B5B43] shadow-xl space-y-6 animate-fade-in"
          >
            <div className="flex items-center gap-2 pb-4 border-b border-[#E8DEC8]">
              <div className="w-8 h-8 rounded-xl bg-[#8B5B43] flex items-center justify-center text-white">
                <ShoppingBag className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-lg font-black text-[#3E332B]">預購清單與付款資訊確認</h3>
                <p className="text-xs text-[#8C8279]">共選擇 {cartItemsList.length} 種品項</p>
              </div>
            </div>

            {/* Cart Items List */}
            <div className="space-y-2 text-xs">
              {cartItemsList.map(item => (
                <div key={item.product.id} className="flex justify-between items-center py-1.5 border-b border-[#FAF7F2]">
                  <div>
                    <span className="font-bold text-[#3E332B]">{item.product.name}</span>
                    <span className="text-[#8C8279] ml-2">x {item.qty}</span>
                  </div>
                  <span className="font-mono font-bold text-[#8B5B43]">
                    NT$ {item.subtotal.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            {/* Delivery Method (Store Pickup locked for now, extensible for shipping) */}
            <div className="space-y-2">
              <label className="block text-xs font-bold text-[#6D5D52]">取貨方式：</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setDeliveryMethod('store_pickup')}
                  className={`p-3 rounded-xl border text-left flex items-center gap-2.5 transition ${
                    deliveryMethod === 'store_pickup'
                      ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                      : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8]'
                  }`}
                >
                  <Store className="w-4 h-4 shrink-0" />
                  <div>
                    <strong className="block font-bold">🏪 門市現場自取（免運費）</strong>
                    <span className="text-[11px] opacity-80">到貨將發送 LINE 通知至門市櫃檯出示單號領取</span>
                  </div>
                </button>

                {paymentConfig?.enable_shipping && (
                  <button
                    type="button"
                    onClick={() => setDeliveryMethod('shipping')}
                    className={`p-3 rounded-xl border text-left flex items-center gap-2.5 transition ${
                      deliveryMethod === 'shipping'
                        ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                        : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8]'
                    }`}
                  >
                    <Truck className="w-4 h-4 shrink-0" />
                    <div>
                      <strong className="block font-bold">🚚 宅配 / 郵寄（運費 NT$ {paymentConfig.shipping_fee}）</strong>
                      <span className="text-[11px] opacity-80">商品到貨後直接配送至指定收件地址</span>
                    </div>
                  </button>
                )}
              </div>
            </div>

            {/* Payment Method Selector */}
            <div className="space-y-3">
              <label className="block text-xs font-bold text-[#6D5D52]">選擇付款方式：</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {paymentConfig?.payment_methods?.map(method => {
                  const isCtbc = method.code === 'ctbc_pool';
                  const isPoolEmpty = isCtbc && paymentConfig?.ctbc_pool_available_count === 0;

                  return (
                    <button
                      key={method.code}
                      type="button"
                      disabled={isPoolEmpty}
                      onClick={() => {
                        if (isPoolEmpty) return;
                        setSelectedPaymentCode(method.code);
                        if (method.bank_accounts_json?.length > 0) {
                          const b = method.bank_accounts_json[0];
                          setSelectedBankInfo(`${b.bank_name} (${b.bank_code}) ${b.account}`);
                        } else {
                          setSelectedBankInfo('');
                        }
                      }}
                      className={`p-3 rounded-xl border text-left transition ${
                        isPoolEmpty
                          ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed opacity-60'
                          : selectedPaymentCode === method.code
                            ? 'bg-[#8B5B43] text-white border-[#8B5B43] shadow-xs'
                            : 'bg-[#FAF7F2] text-[#3E332B] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-0.5">
                        <strong className="block font-bold">{method.name}</strong>
                        {isCtbc && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                            isPoolEmpty
                              ? 'bg-rose-100 text-rose-700'
                              : selectedPaymentCode === method.code
                                ? 'bg-white/20 text-white'
                                : 'bg-emerald-100 text-emerald-800'
                          }`}>
                            {isPoolEmpty ? '目前已發畢' : `剩餘 ${paymentConfig.ctbc_pool_available_count} 組`}
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] opacity-80 line-clamp-1">
                        {isPoolEmpty
                          ? '一次性帳號已全數配發完畢，請選一般匯款'
                          : method.code === 'ctbc_pool'
                            ? '系統自動配發一次性專屬帳號'
                            : '依說明完成匯款或支付'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Dynamic Instructions of Selected Payment */}
              {selectedPaymentMethod && (
                <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] space-y-3 text-xs">
                  <div className="text-[#3E332B] leading-relaxed font-medium">
                    {selectedPaymentMethod.display_instructions}
                  </div>

                  {/* Multi-bank dropdown if applicable */}
                  {selectedPaymentMethod.method_type === 'MULTI_BANK' && Array.isArray(selectedPaymentMethod.bank_accounts_json) && (
                    <div className="space-y-1.5 pt-1">
                      <span className="font-bold text-[#6D5D52] block">請選擇欲匯款的銀行：</span>
                      <select
                        value={selectedBankInfo}
                        onChange={e => setSelectedBankInfo(e.target.value)}
                        className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] outline-none"
                      >
                        {selectedPaymentMethod.bank_accounts_json.map((acc, idx) => (
                          <option key={idx} value={`${acc.bank_name} (${acc.bank_code}) 帳號：${acc.account} 戶名：${acc.holder || '拾光製所'}`}>
                            {acc.bank_name} ({acc.bank_code}) - {acc.account}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Remittance last 5 digits input */}
                  {selectedPaymentMethod.require_last5 && (
                    <div className="pt-2 border-t border-[#E8DEC8] space-y-1.5">
                      <label className="block text-xs font-bold text-[#3E332B]">
                        ✏️ 預先填寫匯款末五碼（選填，稍後亦可隨時在訂單內回報）：
                      </label>
                      <input
                        type="text"
                        maxLength="5"
                        value={remittanceLast5}
                        onChange={e => setRemittanceLast5(e.target.value.replace(/\D/g, ''))}
                        placeholder="例如：58291"
                        className="w-full sm:w-48 px-3 py-1.5 bg-white border border-[#E8DEC8] rounded-lg text-xs font-bold font-mono outline-none"
                      />
                    </div>
                  )}

                  {/* 2 Days Deadline Reminder */}
                  <div className="flex items-center gap-1.5 text-[11px] text-amber-800 font-bold">
                    <Clock className="w-3.5 h-3.5 text-amber-700" />
                    <span>⚠️ 請於下單後 2 天內完成訂金支付，逾期名額將自動取消釋出</span>
                  </div>
                </div>
              )}
            </div>

            {/* General Customer Notes */}
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-[#6D5D52]">訂單備註（選填）：</label>
              <input
                type="text"
                value={customerNote}
                onChange={e => setCustomerNote(e.target.value)}
                placeholder="有任何特殊需求歡迎於此備註..."
                className="w-full px-4 py-2 bg-[#FAF7F2] border border-[#E8DEC8] rounded-xl text-xs font-medium outline-none text-[#3E332B]"
              />
            </div>

            {/* Total Breakdown and Submit Button */}
            <div className="pt-4 border-t border-[#E8DEC8] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-[#8C8279]">訂單總金額</span>
                  <span className="text-xl sm:text-2xl font-black text-[#3E332B]">
                    NT$ {cartTotalAmount.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs font-extrabold text-emerald-800">
                    本次應付訂金：NT$ {cartDepositRequired.toLocaleString()}
                  </span>
                  <span className="text-xs text-[#8C8279]">
                    (門市取貨付尾款 NT$ {(cartTotalAmount - cartDepositRequired).toLocaleString()})
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full sm:w-auto px-8 py-3.5 bg-[#8B5B43] hover:bg-[#7A4F3A] disabled:opacity-50 text-white rounded-2xl font-black text-sm shadow-lg transition flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <span>處理訂單中...</span>
                ) : (
                  <>
                    <span>確認送出預購訂單</span>
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

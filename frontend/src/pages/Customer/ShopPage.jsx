import React, { useState, useEffect, useMemo } from 'react';
import {
  ShoppingBag,
  Sparkles,
  Package,
  Clock,
  Check,
  CreditCard,
  Copy,
  ChevronRight,
  ChevronLeft,
  Plus,
  Minus,
  Truck,
  Store,
  MessageCircle,
  Gift,
  Search,
  Palette,
  X,
  ZoomIn
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/axios';
import {
  MARD_SERIES_INFO,
  getMergedBeadColors,
  getContrastTextColor,
  getBeadSwatchStyle,
  calculateBeadsSubtotalWithMode
} from '../../utils/mardBeadColors';

const SHOP_DRAFT_STORAGE_KEY = 'shiguang_shop_draft_cart';

export default function ShopPage({ userRole }) {
  const navigate = useNavigate();
  const isLoggedInCustomer = userRole === 'customer';
  const [products, setProducts] = useState([]);
  const [paymentConfig, setPaymentConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cart, setCart] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) || '{}');
      return saved.cart && typeof saved.cart === 'object' ? saved.cart : {};
    } catch (e) {
      return {};
    }
  }); // { [productId]: quantity }
  const [wishNote, setWishNote] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) || '{}');
      return saved.wishNote || '';
    } catch (e) {
      return '';
    }
  });
  const [customerNote, setCustomerNote] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) || '{}');
      return saved.customerNote || '';
    } catch (e) {
      return '';
    }
  });
  const [beadColorNote, setBeadColorNote] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) || '{}');
      return saved.beadColorNote || '';
    } catch (e) {
      return '';
    }
  });
  const [beadColorSelections, setBeadColorSelections] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) || '{}');
      return saved.beadColorSelections && typeof saved.beadColorSelections === 'object'
        ? saved.beadColorSelections
        : {};
    } catch (e) {
      return {};
    }
  }); // { [colorCode]: qty }
  const [showBeadPickerModal, setShowBeadPickerModal] = useState(false);
  const [selectedSeriesTab, setSelectedSeriesTab] = useState('ALL');
  const [beadSearchQuery, setBeadSearchQuery] = useState('');
  const [lightboxData, setLightboxData] = useState(null); // { title, images: [], index: 0 }

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

  // Persist draft cart & color selections in sessionStorage so guests don't lose selections after LINE login
  useEffect(() => {
    try {
      sessionStorage.setItem(
        SHOP_DRAFT_STORAGE_KEY,
        JSON.stringify({
          cart,
          beadColorSelections,
          beadColorNote,
          wishNote,
          customerNote
        })
      );
    } catch (e) {}
  }, [cart, beadColorSelections, beadColorNote, wishNote, customerNote]);

  const redirectToLineLoginForShop = () => {
    try {
      sessionStorage.setItem('shiguang_post_login_redirect', '/shop');
    } catch (e) {}

    if (userRole === 'temp_customer') {
      navigate('/register');
      return;
    }

    const channelId = import.meta.env.VITE_LINE_CHANNEL_ID;
    const redirectUri = import.meta.env.VITE_LINE_CALLBACK_URL;
    if (!channelId || !redirectUri || channelId === 'your_channel_id_here') {
      navigate('/');
      return;
    }
    const state = Math.random().toString(36).substring(7);
    const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${channelId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=profile%20openid&bot_prompt=normal`;
    window.location.href = lineLoginUrl;
  };

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

      if (payRes.data?.payment_methods?.length > 0) {
        const methods = payRes.data.payment_methods;
        const poolCount = payRes.data.ctbc_pool_available_count ?? 0;
        const defaultMethod =
          methods.find(m => m.code === 'ctbc_pool' && poolCount > 0) ||
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

  const bundleProduct = products.find(p => p.category === 'bundle');
  const beadsProduct = products.find(p => p.category === 'beads');

  // Merge default 291 MARD colors (with ZG->Z) + admin custom overrides (up to 302+ colors)
  const allBeadColors = useMemo(() => {
    return getMergedBeadColors(paymentConfig?.bead_colors_json || []);
  }, [paymentConfig]);

  // Dynamic series list including any new series added in backend
  const seriesTabs = useMemo(() => {
    const baseKeys = new Set(MARD_SERIES_INFO.map(s => s.key));
    const extraSeries = [];
    for (const c of allBeadColors) {
      if (c.series && !baseKeys.has(c.series)) {
        baseKeys.add(c.series);
        extraSeries.push({
          id: c.series,
          key: c.series,
          name: `${c.series} 擴充色系`,
          shortLabel: `${c.series}系`,
          group: 'custom',
          desc: '店家擴充色號'
        });
      }
    }
    return [...MARD_SERIES_INFO, ...extraSeries];
  }, [allBeadColors]);

  const filteredBeadColors = useMemo(() => {
    const q = beadSearchQuery.trim().toUpperCase();
    return allBeadColors.filter(c => {
      if (q) {
        return (
          c.code.toUpperCase().includes(q) ||
          (c.name && c.name.toUpperCase().includes(q)) ||
          (c.effect && c.effect.toUpperCase().includes(q)) ||
          (c.series && c.series.toUpperCase().includes(q))
        );
      }
      if (selectedSeriesTab === 'ALL') return true;
      if (selectedSeriesTab === 'STANDARD_221') {
        return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'].includes(c.series);
      }
      if (selectedSeriesTab === 'SPECIAL') {
        return !['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'M'].includes(c.series);
      }
      return c.series === selectedSeriesTab;
    });
  }, [allBeadColors, selectedSeriesTab, beadSearchQuery]);

  const selectedColorEntries = useMemo(() => {
    return Object.entries(beadColorSelections)
      .filter(([, q]) => q > 0)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  }, [beadColorSelections]);

  const totalPickedBeadBags = useMemo(() => {
    return selectedColorEntries.reduce((sum, [, q]) => sum + q, 0);
  }, [selectedColorEntries]);

  // Update bead color selection and sync with cart & note
  const updateBeadColorQty = (code, delta) => {
    setBeadColorSelections(prev => {
      const current = prev[code] || 0;
      const next = Math.max(0, current + delta);
      const updated = { ...prev };
      if (next === 0) {
        delete updated[code];
      } else {
        updated[code] = next;
      }

      const entries = Object.entries(updated)
        .filter(([, q]) => q > 0)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
      const sumBags = entries.reduce((s, [, q]) => s + q, 0);

      if (beadsProduct) {
        setCart(prevCart => {
          const nextCart = { ...prevCart };
          if (sumBags === 0) {
            delete nextCart[beadsProduct.id];
          } else {
            nextCart[beadsProduct.id] = sumBags;
          }
          return nextCart;
        });
      }

      if (entries.length > 0) {
        setBeadColorNote(entries.map(([c, q]) => `${c}×${q}包`).join('、'));
      } else {
        setBeadColorNote('');
      }

      return updated;
    });
  };

  const clearAllBeadColors = () => {
    setBeadColorSelections({});
    setBeadColorNote('');
    if (beadsProduct) {
      setCart(prev => {
        const copy = { ...prev };
        delete copy[beadsProduct.id];
        return copy;
      });
    }
  };

  const updateCartQty = (productId, delta) => {
    setCart(prev => {
      const current = prev[productId] || 0;
      const next = Math.max(0, current + delta);
      if (next === 0) {
        if (beadsProduct && productId === beadsProduct.id) {
          setBeadColorSelections({});
          setBeadColorNote('');
        }
        const copy = { ...prev };
        delete copy[productId];
        return copy;
      }
      return { ...prev, [productId]: next };
    });
  };

  const getProductImages = (prod) => {
    if (!prod) return [];
    const list = [];
    if (Array.isArray(prod.images_json)) {
      for (const u of prod.images_json) {
        if (u && typeof u === 'string' && !list.includes(u)) list.push(u);
      }
    }
    if (prod.image_url && !list.includes(prod.image_url)) {
      list.unshift(prod.image_url);
    }
    return list;
  };

  const openProductLightbox = (prod, startIndex = 0) => {
    const imgs = getProductImages(prod);
    if (imgs.length === 0) return;
    setLightboxData({
      title: prod.name,
      images: imgs,
      index: startIndex
    });
  };

  const calculateItemSubtotal = (product, qty) => {
    if (!product || qty <= 0) return 0;
    if (product.category === 'beads') {
      return calculateBeadsSubtotalWithMode(product, qty, beadColorSelections);
    }
    return calculateBeadsSubtotalWithMode(product, qty, null);
  };

  const cartItemsList = Object.entries(cart)
    .map(([pId, qty]) => {
      const prod = products.find(p => p.id === parseInt(pId, 10));
      const subtotal = prod ? calculateItemSubtotal(prod, qty) : 0;
      const deposit =
        prod && prod.is_preorder
          ? prod.deposit_amount > 0
            ? Math.min(prod.deposit_amount * qty, subtotal)
            : subtotal
          : subtotal;
      return { product: prod, qty, subtotal, deposit };
    })
    .filter(item => item.product && item.qty > 0);

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

    if (!isLoggedInCustomer) {
      redirectToLineLoginForShop();
      return;
    }

    setIsSubmitting(true);
    try {
      const combinedCustomerNote = [
        hasBeadsInCart && beadColorNote ? `【融合豆色號明細】：${beadColorNote}` : '',
        customerNote ? `【一般備註】：${customerNote}` : ''
      ]
        .filter(Boolean)
        .join('\n');

      const payload = {
        items: cartItemsList.map(item => ({
          product_id: item.product.id,
          quantity: item.qty,
          customization_note: item.product.category === 'beads' ? beadColorNote : null,
          color_breakdown:
            item.product.category === 'beads' && Object.keys(beadColorSelections).length > 0
              ? beadColorSelections
              : null
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
      setBeadColorSelections({});
      setBeadColorNote('');
      try {
        sessionStorage.removeItem(SHOP_DRAFT_STORAGE_KEY);
      } catch (e) {}
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

  // If order was just placed, display confirmation card
  if (completedOrder) {
    return (
      <div className="min-h-screen bg-[#FAF7F2] py-8 px-4 sm:px-6">
        <div className="max-w-2xl mx-auto bg-white rounded-3xl shadow-xl border border-[#E8DEC8] overflow-hidden">
          <div className="bg-[#8B5B43] text-white p-6 sm:p-8 text-center space-y-2">
            <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-inner">
              <Check className="w-8 h-8 text-white stroke-[3]" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-black">預購訂單建立成功！</h2>
            <p className="text-sm text-[#FAF7F2]/90">
              感謝您的訂購，我們已為您保留預購商品名額。
            </p>
          </div>

          <div className="p-6 sm:p-8 space-y-6">
            <div className="bg-[#FAF7F2] rounded-2xl p-4 sm:p-5 border border-[#E8DEC8] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <span className="text-xs text-[#8C8279] font-bold block">預購單號</span>
                <span className="font-mono font-black text-lg text-[#3E332B]">{completedOrder.order_ref}</span>
              </div>
              <div className="bg-amber-100 text-amber-900 px-3.5 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5">
                <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                <span>請於 {paymentConfig?.deposit_deadline_days ?? 2} 天內完成款項支付</span>
              </div>
            </div>

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
              {completedOrder.estimated_arrival && (
                <div className="pt-2 border-t border-[#E8DEC8] flex justify-between text-[#6D5D52]">
                  <span>預計到貨說明</span>
                  <span className="font-bold text-[#3E332B]">{completedOrder.estimated_arrival}</span>
                </div>
              )}
              {completedOrder.wish_note && (
                <div className="pt-1 text-[#8B5B43]">
                  <span className="font-bold">您的許願：</span> {completedOrder.wish_note}
                </div>
              )}
            </div>

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

  const bundleImages = getProductImages(bundleProduct);
  const beadsDiscountMode = beadsProduct?.tier_discount_mode || 'combined';

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
            {isLoggedInCustomer ? (
              <>
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
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => navigate('/preview')}
                  className="px-3 py-1.5 bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] text-[#8B5B43] rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-2xs"
                >
                  <span>📅 時段預覽</span>
                </button>
                <button
                  type="button"
                  onClick={redirectToLineLoginForShop}
                  className="px-3.5 py-1.5 bg-[#06C755] hover:bg-[#05b34c] text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-xs"
                >
                  <span>🔑 LINE 登入預購</span>
                </button>
              </>
            )}
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
            <div className="absolute top-0 right-0 bg-[#8B5B43] text-white px-5 py-1.5 rounded-bl-2xl text-xs font-extrabold tracking-wider z-10">
              🔥 鎮店主打 限量預購
            </div>

            <div className="flex flex-col lg:flex-row gap-6 items-start">
              <div
                onClick={() => bundleImages.length > 0 && openProductLightbox(bundleProduct, 0)}
                className={`w-full lg:w-2/5 aspect-4/3 rounded-2xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center p-4 text-center relative overflow-hidden group ${
                  bundleImages.length > 0 ? 'cursor-pointer' : ''
                }`}
              >
                {bundleImages.length > 0 ? (
                  <>
                    <img
                      src={bundleImages[0]}
                      alt={bundleProduct.name}
                      className="w-full h-full object-cover rounded-xl group-hover:scale-105 transition-transform duration-300"
                    />
                    <div className="absolute bottom-3 right-3 bg-black/65 backdrop-blur-xs text-white px-2.5 py-1 rounded-lg text-[11px] font-bold flex items-center gap-1">
                      <ZoomIn className="w-3.5 h-3.5" />
                      <span>{bundleImages.length > 1 ? `點擊放大 (${bundleImages.length}張)` : '點擊放大'}</span>
                    </div>
                  </>
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
                  <p className="text-xs text-[#6D5D52] mt-1.5 leading-relaxed whitespace-pre-line">
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

                {/* Arrival text banner (Only shown if configured) */}
                {bundleProduct.estimated_arrival_text && (
                  <div className="bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8] text-xs text-[#6D5D52] flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#8B5B43] shrink-0" />
                    <span>{bundleProduct.estimated_arrival_text}</span>
                  </div>
                )}

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

                {/* Wish Input Box */}
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

        {/* Individual Items Section */}
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

          {/* Tier Pricing + Interactive Color Picker Banner for Beads */}
          {beadsProduct && (activeCategory === 'all' || activeCategory === 'beads') && (
            <div className="bg-linear-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 sm:p-5 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shadow-2xs">
              <div className="space-y-1.5">
                <div className="flex items-center flex-wrap gap-2">
                  <span className="text-xs sm:text-sm font-black text-amber-950 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-amber-700" />
                    <span>🌈 高品質融合豆 10g 補充包（全店 {allBeadColors.length} 色選色表）：</span>
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[11px] font-extrabold bg-white text-amber-900 border border-amber-300">
                    {beadsDiscountMode === 'per_color'
                      ? '📌 單色獨立計算：單一色號滿 10 包 / 20 包享優惠'
                      : '🎉 混色合計計算：任選色號加總滿 10 包 / 20 包享優惠'}
                  </span>
                </div>
                <p className="text-xs text-amber-800">
                  單包 $16 ｜ <strong className="text-amber-950 font-black">滿 10 包 $150</strong>（每包 $15） ｜ <strong className="text-rose-700 font-black">滿 20 包 $280</strong>（每包 $14）！
                </p>
              </div>
              <div className="flex items-center flex-wrap gap-2 w-full md:w-auto">
                <button
                  type="button"
                  onClick={() => setShowBeadPickerModal(true)}
                  className="flex-1 md:flex-none px-4 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs font-black shadow-sm transition flex items-center justify-center gap-1.5"
                >
                  <Palette className="w-4 h-4" />
                  <span>🎨 開啟互動色號表選色 ({allBeadColors.length}色)</span>
                </button>
                {cart[beadsProduct.id] > 0 && (
                  <span className="px-3 py-2 bg-amber-600 text-white rounded-xl text-xs font-bold shrink-0">
                    已選 {cart[beadsProduct.id]} 包（NT$ {calculateItemSubtotal(beadsProduct, cart[beadsProduct.id])}）
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Products Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {products
              .filter(p => p.category !== 'bundle')
              .filter(p => activeCategory === 'all' || p.category === activeCategory)
              .map(prod => {
                const qty = cart[prod.id] || 0;
                const prodImages = getProductImages(prod);
                const isBeads = prod.category === 'beads';

                return (
                  <div
                    key={prod.id}
                    className="bg-white rounded-2xl p-4 border border-[#E8DEC8] shadow-xs flex flex-col justify-between hover:shadow-md transition"
                  >
                    <div className="space-y-3">
                      {/* Product Image Thumbnail if uploaded */}
                      {prodImages.length > 0 && (
                        <div
                          onClick={() => openProductLightbox(prod, 0)}
                          className="w-full h-44 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] overflow-hidden relative cursor-pointer group"
                        >
                          <img
                            src={prodImages[0]}
                            alt={prod.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                          <div className="absolute bottom-2 right-2 bg-black/60 text-white px-2 py-0.5 rounded-md text-[10px] font-bold flex items-center gap-1">
                            <ZoomIn className="w-3 h-3" />
                            <span>{prodImages.length > 1 ? `${prodImages.length}張圖` : '放大'}</span>
                          </div>
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <div className="flex justify-between items-start gap-2">
                          <h4 className="font-bold text-sm text-[#3E332B]">{prod.name}</h4>
                          <span className="font-black text-sm text-[#8B5B43] whitespace-nowrap">
                            NT$ {prod.price}
                          </span>
                        </div>
                        <p className="text-xs text-[#8C8279] whitespace-pre-line leading-relaxed">
                          {prod.description}
                        </p>
                        {prod.estimated_arrival_text && (
                          <div className="text-[11px] font-bold text-[#8B5B43] bg-[#FAF7F2] px-2.5 py-1 rounded-lg border border-[#E8DEC8] flex items-center gap-1">
                            <Clock className="w-3 h-3 shrink-0" />
                            <span>{prod.estimated_arrival_text}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-[#F5F0EB] flex items-center justify-between gap-2">
                      {isBeads ? (
                        <button
                          type="button"
                          onClick={() => setShowBeadPickerModal(true)}
                          className="text-xs font-bold text-[#8B5B43] bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition"
                        >
                          <Palette className="w-3.5 h-3.5" />
                          <span>點此選色號 ({allBeadColors.length}色)</span>
                        </button>
                      ) : (
                        <span className="text-[11px] text-[#8C8279]">門市自取</span>
                      )}

                      {qty > 0 ? (
                        isBeads && selectedColorEntries.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setShowBeadPickerModal(true)}
                            className="px-3 py-1.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-lg text-xs font-bold transition flex items-center gap-1 shadow-2xs"
                          >
                            <span>已選 {qty} 包 · 調整色號</span>
                          </button>
                        ) : (
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
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => (isBeads ? setShowBeadPickerModal(true) : updateCartQty(prod.id, 1))}
                          className="px-3 py-1.5 bg-[#FAF7F2] hover:bg-[#8B5B43] text-[#8B5B43] hover:text-white border border-[#E8DEC8] hover:border-[#8B5B43] rounded-lg text-xs font-bold transition flex items-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>{isBeads ? '選色加購' : '加購'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Beads Color Notes & Selected Chips Box if Beads in Cart */}
          {hasBeadsInCart && (
            <div className="bg-white p-4 sm:p-5 rounded-2xl border-2 border-[#8B5B43]/40 space-y-3 animate-fade-in">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <label className="text-xs font-bold text-[#8B5B43] flex items-center gap-1.5">
                  <Palette className="w-4 h-4" />
                  <span>🌈 10g 融合豆 — 已選色號與包數明細：</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBeadPickerModal(true)}
                    className="px-3 py-1 bg-[#8B5B43] text-white rounded-lg text-xs font-bold hover:bg-[#724a35] transition"
                  >
                    🎨 開啟色卡增減色號
                  </button>
                  {selectedColorEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={clearAllBeadColors}
                      className="px-2.5 py-1 bg-rose-50 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold hover:bg-rose-100 transition"
                    >
                      清空重選
                    </button>
                  )}
                </div>
              </div>

              {selectedColorEntries.length > 0 && (
                <div className="flex flex-wrap gap-1.5 bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8]">
                  {selectedColorEntries.map(([code, cQty]) => {
                    const colorObj = allBeadColors.find(c => c.code === code);
                    const swatchStyle = getBeadSwatchStyle(colorObj);
                    return (
                      <div
                        key={code}
                        className="inline-flex items-center gap-1.5 bg-white border border-[#E5DFD7] rounded-lg px-2 py-1 text-xs shadow-2xs"
                      >
                        <span
                          className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] font-black border border-[#E8DEC8]/80"
                          style={swatchStyle}
                        >
                          {code}
                        </span>
                        <span className="font-mono font-bold text-[#3E332B]">×{cQty}包</span>
                        <button
                          type="button"
                          onClick={() => updateBeadColorQty(code, -1)}
                          className="text-gray-400 hover:text-rose-600 font-bold ml-0.5"
                          title="減少 1 包"
                        >
                          -
                        </button>
                        <button
                          type="button"
                          onClick={() => updateBeadColorQty(code, 1)}
                          className="text-gray-400 hover:text-emerald-600 font-bold"
                          title="增加 1 包"
                        >
                          +
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              <textarea
                rows="2"
                value={beadColorNote}
                onChange={e => setBeadColorNote(e.target.value)}
                placeholder="可點選上方「開啟色卡」直接點選色號，或手動輸入欲購買的色號與包數（如尚未決定亦可備註現場挑選）"
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
                <div key={item.product.id} className="flex justify-between items-start py-2 border-b border-[#FAF7F2] gap-2">
                  <div>
                    <span className="font-bold text-[#3E332B]">{item.product.name}</span>
                    <span className="text-[#8C8279] ml-2">x {item.qty}</span>
                    {item.product.category === 'beads' && beadColorNote && (
                      <p className="text-[11px] text-[#8B5B43] mt-0.5">色號：{beadColorNote}</p>
                    )}
                  </div>
                  <span className="font-mono font-bold text-[#8B5B43] shrink-0">
                    NT$ {item.subtotal.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            {/* Delivery Method */}
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
                    <span className="text-[11px] opacity-80">備妥後將發送 LINE 通知至門市櫃檯出示單號領取</span>
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
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
                              isPoolEmpty
                                ? 'bg-rose-100 text-rose-700'
                                : selectedPaymentCode === method.code
                                  ? 'bg-white/20 text-white'
                                  : 'bg-emerald-100 text-emerald-800'
                            }`}
                          >
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

              {selectedPaymentMethod && (
                <div className="bg-[#FAF7F2] p-4 rounded-2xl border border-[#E8DEC8] space-y-3 text-xs">
                  <div className="text-[#3E332B] leading-relaxed font-medium">
                    {selectedPaymentMethod.display_instructions}
                  </div>

                  {selectedPaymentMethod.method_type === 'MULTI_BANK' &&
                    Array.isArray(selectedPaymentMethod.bank_accounts_json) && (
                      <div className="space-y-1.5 pt-1">
                        <span className="font-bold text-[#6D5D52] block">請選擇欲匯款的銀行：</span>
                        <select
                          value={selectedBankInfo}
                          onChange={e => setSelectedBankInfo(e.target.value)}
                          className="w-full px-3 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] outline-none"
                        >
                          {selectedPaymentMethod.bank_accounts_json.map((acc, idx) => (
                            <option
                              key={idx}
                              value={`${acc.bank_name} (${acc.bank_code}) 帳號：${acc.account} 戶名：${acc.holder || '拾光製所'}`}
                            >
                              {acc.bank_name} ({acc.bank_code}) - {acc.account}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

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

                  <div className="flex items-center gap-1.5 text-[11px] text-amber-800 font-bold">
                    <Clock className="w-3.5 h-3.5 text-amber-700" />
                    <span>⚠️ 請於下單後 {paymentConfig?.deposit_deadline_days ?? 2} 天內完成訂金支付，逾期名額將自動取消釋出</span>
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

            {!isLoggedInCustomer && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-3.5 text-xs text-emerald-900 flex items-center justify-between flex-wrap gap-2">
                <span>
                  💡 目前為<strong>免登入預覽模式</strong>，您已挑選的商品與拼豆色號會自動保留，點擊下方按鈕登入 LINE 即可直接完成下單！
                </span>
              </div>
            )}

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
                className={`w-full sm:w-auto px-8 py-3.5 disabled:opacity-50 text-white rounded-2xl font-black text-sm shadow-lg transition flex items-center justify-center gap-2 ${
                  isLoggedInCustomer
                    ? 'bg-[#8B5B43] hover:bg-[#7A4F3A]'
                    : 'bg-[#06C755] hover:bg-[#05b34c]'
                }`}
              >
                {isSubmitting ? (
                  <span>處理訂單中...</span>
                ) : isLoggedInCustomer ? (
                  <>
                    <span>確認送出預購訂單</span>
                    <ChevronRight className="w-4 h-4" />
                  </>
                ) : (
                  <>
                    <span>🔑 使用 LINE 登入並送出預購訂單</span>
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Interactive MARD 291/302+ Bead Color Chart Modal */}
      {showBeadPickerModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-3xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl border border-[#E8DEC8]">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 bg-[#3E332B] text-white flex items-center justify-between gap-3">
              <div>
                <h3 className="font-black text-base sm:text-lg flex items-center gap-2">
                  <Palette className="w-5 h-5 text-amber-300" />
                  <span>🎨 拾光製所 MARD 拼豆色號表（共 {allBeadColors.length} 色）</span>
                </h3>
                <p className="text-[11px] sm:text-xs text-[#D5CFC9] mt-0.5">
                  {beadsDiscountMode === 'per_color'
                    ? '📌 單色獨立優惠：單一色號買滿 10 包 $150、滿 20 包 $280（未滿 10 包每包 $16）'
                    : '🎉 混色合計優惠：全色號混搭加總滿 10 包 $150、滿 20 包 $280（未滿 10 包每包 $16）'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowBeadPickerModal(false)}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search & Series Filter Bar */}
            <div className="p-3 sm:p-4 bg-[#FAF7F2] border-b border-[#E8DEC8] space-y-2.5">
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-[#8C8279] absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={beadSearchQuery}
                    onChange={e => setBeadSearchQuery(e.target.value)}
                    placeholder="搜尋色號、名稱或材質（例如：Z1、L1、高透、半透、亮片、夜光、溫變、光變、珠光...）"
                    className="w-full pl-9 pr-8 py-2 bg-white border border-[#E8DEC8] rounded-xl text-xs font-bold text-[#3E332B] outline-none focus:border-[#8B5B43]"
                  />
                  {beadSearchQuery && (
                    <button
                      type="button"
                      onClick={() => setBeadSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Series Tabs */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs font-bold">
                {[
                  { key: 'ALL', label: `全部 (${allBeadColors.length})` },
                  { key: 'STANDARD_221', label: '標準221色 (A~M)' },
                  { key: 'SPECIAL', label: '✨ 特殊色系總覽 (L/P/Q/R/T/Y/Z)' },
                  ...seriesTabs.map(s => {
                    const count = allBeadColors.filter(c => c.series === s.key).length;
                    return {
                      key: s.key,
                      label: `${s.shortLabel || `${s.key}系`} (${count})`
                    };
                  })
                ].map(tab => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => {
                      setSelectedSeriesTab(tab.key);
                      setBeadSearchQuery('');
                    }}
                    className={`px-3 py-1.5 rounded-xl whitespace-nowrap transition ${
                      selectedSeriesTab === tab.key && !beadSearchQuery
                        ? 'bg-[#8B5B43] text-white shadow-xs'
                        : 'bg-white text-[#6D5D52] border border-[#E8DEC8] hover:bg-[#F2ECE4]'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Color Grid */}
            <div className="p-3 sm:p-5 overflow-y-auto flex-1 bg-white">
              <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2.5">
                {filteredBeadColors.map(color => {
                  const qty = beadColorSelections[color.code] || 0;
                  const isAvailable = color.is_available !== false;
                  const swatchStyle = getBeadSwatchStyle(color);

                  return (
                    <div
                      key={color.code}
                      className={`p-2.5 rounded-2xl border transition flex flex-col items-center justify-between gap-2 ${
                        !isAvailable
                          ? 'bg-gray-100 border-gray-200 opacity-55'
                          : qty > 0
                            ? 'bg-amber-50/70 border-2 border-[#8B5B43] shadow-xs'
                            : 'bg-[#FAF7F2]/60 border-[#E8DEC8] hover:border-[#8B5B43]/50'
                      }`}
                    >
                      <div className="flex items-center gap-2 w-full">
                        <div
                          className="w-10 h-10 rounded-full flex items-center justify-center font-mono font-black text-xs border border-[#E8DEC8]/80 shrink-0"
                          style={swatchStyle}
                          title={color.gradient ? `${color.code} ${color.name} (變色漸層)` : `${color.code} ${color.name || ''}`}
                        >
                          {color.code}
                        </div>
                        <div className="min-w-0 flex-1 text-left">
                          <div className="font-bold text-xs text-[#3E332B] truncate">{color.name || color.code}</div>
                          <div className="text-[10px] text-[#8C8279] font-medium truncate">
                            {color.effect && color.effect !== '標準色' ? (
                              <span className="text-[#8B5B43] font-bold">{color.effect}系</span>
                            ) : (
                              <span className="font-mono">{color.hex}</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {!isAvailable ? (
                        <span className="w-full py-1 text-center text-[11px] font-bold bg-gray-200 text-gray-500 rounded-lg">
                          補貨中
                        </span>
                      ) : (
                        <div className="flex items-center justify-between w-full bg-white border border-[#E5DFD7] rounded-xl px-1.5 py-1">
                          <button
                            type="button"
                            disabled={qty <= 0}
                            onClick={() => updateBeadColorQty(color.code, -1)}
                            className="w-6 h-6 rounded-lg bg-[#FAF7F2] hover:bg-[#EBE5DF] disabled:opacity-30 text-[#8B5B43] font-black flex items-center justify-center"
                          >
                            -
                          </button>
                          <span className="font-mono font-black text-xs text-[#3E332B]">
                            {qty > 0 ? `${qty}包` : '0'}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateBeadColorQty(color.code, 1)}
                            className="w-6 h-6 rounded-lg bg-[#8B5B43] hover:bg-[#724a35] text-white font-black flex items-center justify-center"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Modal Footer Summary */}
            <div className="p-4 bg-[#FAF7F2] border-t border-[#E8DEC8] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-xs sm:text-sm font-black text-[#3E332B]">
                  已選 <span className="text-[#8B5B43]">{selectedColorEntries.length}</span> 種色號，共{' '}
                  <span className="text-[#8B5B43]">{totalPickedBeadBags}</span> 包 ｜ 小計：
                  <span className="text-base sm:text-lg text-emerald-800 ml-1">
                    NT$ {beadsProduct ? calculateItemSubtotal(beadsProduct, totalPickedBeadBags) : 0}
                  </span>
                </div>
                {selectedColorEntries.length > 0 && (
                  <p className="text-[11px] text-[#6D5D52] line-clamp-1">
                    明細：{selectedColorEntries.map(([c, q]) => `${c}×${q}`).join('、')}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                {selectedColorEntries.length > 0 && (
                  <button
                    type="button"
                    onClick={clearAllBeadColors}
                    className="px-3.5 py-2.5 bg-white border border-rose-200 text-rose-600 rounded-xl text-xs font-bold hover:bg-rose-50"
                  >
                    清空
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowBeadPickerModal(false)}
                  className="flex-1 sm:flex-none px-6 py-2.5 bg-[#8B5B43] hover:bg-[#724a35] text-white rounded-xl text-xs sm:text-sm font-black shadow-sm"
                >
                  完成選色並帶入購物車
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Product Image Lightbox Modal */}
      {lightboxData && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setLightboxData(null)}
        >
          <div
            className="relative max-w-3xl w-full flex flex-col items-center gap-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-full flex items-center justify-between text-white px-2">
              <h4 className="font-bold text-sm sm:text-base">{lightboxData.title}</h4>
              <button
                type="button"
                onClick={() => setLightboxData(null)}
                className="p-2 rounded-full bg-white/15 hover:bg-white/25 text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="relative w-full bg-black/40 rounded-2xl overflow-hidden flex items-center justify-center max-h-[75vh]">
              <img
                src={lightboxData.images[lightboxData.index]}
                alt={lightboxData.title}
                className="max-h-[75vh] w-auto object-contain rounded-xl"
              />
              {lightboxData.images.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxData(prev => ({
                        ...prev,
                        index: (prev.index - 1 + prev.images.length) % prev.images.length
                      }))
                    }
                    className="absolute left-3 p-2.5 rounded-full bg-black/60 hover:bg-black/80 text-white"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setLightboxData(prev => ({
                        ...prev,
                        index: (prev.index + 1) % prev.images.length
                      }))
                    }
                    className="absolute right-3 p-2.5 rounded-full bg-black/60 hover:bg-black/80 text-white"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}
            </div>

            {lightboxData.images.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto py-1">
                {lightboxData.images.map((imgUrl, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setLightboxData(prev => ({ ...prev, index: idx }))}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition ${
                      lightboxData.index === idx ? 'border-amber-400 scale-105' : 'border-transparent opacity-60'
                    }`}
                  >
                    <img src={imgUrl} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

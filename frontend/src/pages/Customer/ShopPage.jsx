import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Sparkles,
  Grid,
  Check,
  Plus,
  Minus,
  Clock,
  Copy,
  MessageCircle,
} from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import BottomTabBar from '../../components/customer/BottomTabBar';
import BottomActionBar from '../../components/customer/BottomActionBar';
import Button from '../../components/customer/Button';
import Pill from '../../components/customer/Pill';
import { Card, KV, Divider } from '../../components/customer/Card';
import Field from '../../components/customer/Field';
import Stepper from '../../components/customer/Stepper';
import EmptyState from '../../components/customer/EmptyState';
import { BeadLoader, BeadRow } from '../../components/customer/Bead';
import { SoftBox, ErrorBanner } from '../../components/customer/Banners';
import BeadPickerSheet from '../../components/customer/sheets/BeadPickerSheet';
import { useToast } from '../../components/customer/Toast';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useCustomerProfile } from '../../hooks/customer/useCustomerProfile';
import api from '../../api/axios';
import { initiateLineOAuth } from '../../utils/lineAuth';
import {
  formatMoney,
  formatMoneyBig,
  formatDateShort,
} from '../../utils/customer/format';
import {
  getMergedBeadColors,
  calculateBeadsSubtotalWithMode,
} from '../../utils/mardBeadColors';

const SHOP_DRAFT_STORAGE_KEY = 'shiguang_shop_draft_cart';

function loadSavedShopDraft() {
  try {
    const raw =
      sessionStorage.getItem(SHOP_DRAFT_STORAGE_KEY) ||
      localStorage.getItem(SHOP_DRAFT_STORAGE_KEY) ||
      '{}';
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

const CATEGORY_TABS = [
  { id: 'all', label: '全部' },
  { id: 'beads', label: '融合豆' },
  { id: 'tools_3d', label: '3D 工具' },
  { id: 'boards', label: '豆板' },
  { id: 'ironing_cloth', label: '烘焙布' },
];

export default function ShopPage({ userRole, isLineEntry = false }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();

  const view = searchParams.get('view') || 'list'; // 'list' | 'checkout' | 'done'
  const doneOrderId = searchParams.get('order') || null;

  const { settings: globalSettings } = useGlobalSettings();
  const { user } = useCustomerProfile();
  const isLoggedInCustomer = user?.role === 'customer' || userRole === 'customer';

  // Products and config state
  const [products, setProducts] = useState([]);
  const [paymentConfig, setPaymentConfig] = useState(null);
  const [loading, setLoading] = useState(true);

  // Cart draft state
  const initialDraft = useMemo(() => loadSavedShopDraft(), []);
  const [cart, setCart] = useState(() => (initialDraft.cart && typeof initialDraft.cart === 'object' ? initialDraft.cart : {}));
  const [beadColorSelections, setBeadColorSelections] = useState(() => (initialDraft.beadColorSelections && typeof initialDraft.beadColorSelections === 'object' ? initialDraft.beadColorSelections : {}));
  const [wishNote, setWishNote] = useState(() => initialDraft.wishNote || '');
  const [customerNote, setCustomerNote] = useState(() => initialDraft.customerNote || '');

  // Active filter tab
  const [activeCategory, setActiveCategory] = useState('all');

  // Sheet state
  const [showBeadPicker, setShowBeadPicker] = useState(false);

  // Checkout form state
  const [deliveryMethod, setDeliveryMethod] = useState('store_pickup'); // 'store_pickup' | 'delivery'
  const [shippingAddress, setShippingAddress] = useState({ name: '', phone: '', address: '' });
  const [selectedPaymentCode, setSelectedPaymentCode] = useState('');
  const [selectedBankInfo, setSelectedBankInfo] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Done page state
  const [doneOrder, setDoneOrder] = useState(null);
  const [doneOrderLoading, setDoneOrderLoading] = useState(false);
  const [remittanceLast5Input, setRemittanceLast5Input] = useState('');
  const [reportingLast5, setReportingLast5] = useState(false);
  const [reportedSuccess, setReportedSuccess] = useState(false);

  // Persist cart
  useEffect(() => {
    try {
      const serialized = JSON.stringify({
        cart,
        beadColorSelections,
        wishNote,
        customerNote,
      });
      sessionStorage.setItem(SHOP_DRAFT_STORAGE_KEY, serialized);
      localStorage.setItem(SHOP_DRAFT_STORAGE_KEY, serialized);
    } catch (e) {}
  }, [cart, beadColorSelections, wishNote, customerNote]);

  // Fetch products and payment methods
  const fetchShopData = async () => {
    try {
      setLoading(true);
      const [prodRes, payRes] = await Promise.all([
        api.get('/shop/products'),
        api.get('/shop/payment-methods').catch(() => ({ data: null })),
      ]);
      setProducts(Array.isArray(prodRes.data) ? prodRes.data : []);
      if (payRes.data) {
        setPaymentConfig(payRes.data);
        const methods = payRes.data.payment_methods || [];
        const isCtbcAvailable = (payRes.data.ctbc_pool_available_count || 0) > 0;
        const availableMethods = methods.filter((m) => {
          if (m.code === 'ctbc_pool') return isCtbcAvailable;
          return true;
        });
        const defaultMethod = availableMethods[0] || methods[0];
        if (defaultMethod) {
          setSelectedPaymentCode(defaultMethod.code);
          const rawAccounts = defaultMethod.bank_accounts_json;
          const bankAccounts = Array.isArray(rawAccounts)
            ? rawAccounts
            : typeof rawAccounts === 'string'
            ? JSON.parse(rawAccounts || '[]')
            : [];
          if (bankAccounts.length > 0) {
            const b = bankAccounts[0];
            setSelectedBankInfo(`${b.bank_name} (${b.bank_code}) ${b.account}`);
          } else {
            setSelectedBankInfo('');
          }
        }
      }
    } catch (err) {
      console.error('Failed to load shop data', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPaymentMethod = (m) => {
    setSelectedPaymentCode(m.code);
    const rawAccounts = m.bank_accounts_json;
    const bankAccounts = Array.isArray(rawAccounts)
      ? rawAccounts
      : typeof rawAccounts === 'string'
      ? JSON.parse(rawAccounts || '[]')
      : [];
    if (bankAccounts.length > 0) {
      const b = bankAccounts[0];
      setSelectedBankInfo(`${b.bank_name} (${b.bank_code}) ${b.account}`);
    } else {
      setSelectedBankInfo('');
    }
  };

  useEffect(() => {
    fetchShopData();
  }, []);

  // Fetch order for done view
  useEffect(() => {
    if (view === 'done' && doneOrderId) {
      setDoneOrderLoading(true);
      api.get('/shop/my-orders')
        .then((res) => {
          const list = Array.isArray(res.data) ? res.data : [];
          const found = list.find((o) => String(o.id) === String(doneOrderId) || o.order_number === doneOrderId);
          if (found) {
            setDoneOrder(found);
            if (found.remittance_last5) setReportedSuccess(true);
          } else {
            navigate('/history?tab=orders', { replace: true });
          }
        })
        .catch(() => {
          navigate('/history?tab=orders', { replace: true });
        })
        .finally(() => {
          setDoneOrderLoading(false);
        });
    }
  }, [view, doneOrderId, navigate]);

  const bundleProduct = useMemo(() => products.find((p) => p.category === 'bundle'), [products]);
  const beadsProduct = useMemo(() => products.find((p) => p.category === 'beads'), [products]);

  const allBeadColors = useMemo(() => {
    return getMergedBeadColors(paymentConfig?.bead_colors_json || []);
  }, [paymentConfig]);

  // Available categories
  const availableCategoryTabs = useMemo(() => {
    const existingCats = new Set(products.map((p) => p.category));
    return CATEGORY_TABS.filter((tab) => tab.id === 'all' || existingCats.has(tab.id));
  }, [products]);

  // Cart operations
  const updateCartQty = (productId, delta) => {
    setCart((prev) => {
      const cur = prev[productId] || 0;
      const next = Math.max(0, cur + delta);
      const updated = { ...prev };
      if (next <= 0) {
        delete updated[productId];
      } else {
        updated[productId] = next;
      }
      return updated;
    });
  };

  const setCartQtyDirect = (productId, qty) => {
    setCart((prev) => {
      const updated = { ...prev };
      if (qty <= 0) {
        delete updated[productId];
      } else {
        updated[productId] = qty;
      }
      return updated;
    });
  };

  // Sync beads quantity with color selections
  const handleUpdateBeadColors = (newColors) => {
    setBeadColorSelections(newColors);
    const totalBags = Object.values(newColors).reduce((acc, q) => acc + (Number(q) || 0), 0);
    if (beadsProduct) {
      setCartQtyDirect(beadsProduct.id, totalBags);
    }
  };

  // Cart calculations
  const { totalItemsCount, totalAmount, depositTotal, itemsBreakdown } = useMemo(() => {
    let itemsCount = 0;
    let sumTotal = 0;
    let sumDeposit = 0;
    const breakdown = [];

    // Bundle
    if (bundleProduct && cart[bundleProduct.id] > 0) {
      const q = cart[bundleProduct.id];
      itemsCount += q;
      const itemSubtotal = (bundleProduct.price || 0) * q;
      const itemDeposit = (bundleProduct.deposit_amount || bundleProduct.price || 0) * q;
      sumTotal += itemSubtotal;
      sumDeposit += itemDeposit;
      breakdown.push({
        product: bundleProduct,
        qty: q,
        subtotal: itemSubtotal,
        deposit: itemDeposit,
      });
    }

    // Beads
    if (beadsProduct && cart[beadsProduct.id] > 0) {
      itemsCount += 1; // Section 6.17: 融合豆整筆算 1 件
      const q = cart[beadsProduct.id];
      const itemSubtotal = calculateBeadsSubtotalWithMode(beadsProduct, q, beadColorSelections);
      const itemDeposit = (beadsProduct.deposit_amount || beadsProduct.price || 0) * q;
      sumTotal += itemSubtotal;
      sumDeposit += itemDeposit;
      breakdown.push({
        product: beadsProduct,
        qty: q,
        subtotal: itemSubtotal,
        deposit: itemDeposit,
        isBeads: true,
      });
    }

    // Other items
    for (const p of products) {
      if (p.category === 'bundle' || p.category === 'beads') continue;
      const q = cart[p.id];
      if (q > 0) {
        itemsCount += q;
        const itemSubtotal = (p.price || 0) * q;
        const itemDeposit = (p.deposit_amount || p.price || 0) * q;
        sumTotal += itemSubtotal;
        sumDeposit += itemDeposit;
        breakdown.push({
          product: p,
          qty: q,
          subtotal: itemSubtotal,
          deposit: itemDeposit,
        });
      }
    }

    return {
      totalItemsCount: itemsCount,
      totalAmount: sumTotal,
      depositTotal: sumDeposit,
      itemsBreakdown: breakdown,
    };
  }, [products, cart, bundleProduct, beadsProduct, beadColorSelections]);

  // Shipping fee
  const shippingFee = deliveryMethod === 'delivery' ? (globalSettings?.shop_shipping_fee ?? 60) : 0;
  const finalTotalAmount = totalAmount + shippingFee;
  const finalDepositAmount = depositTotal + (deliveryMethod === 'delivery' ? shippingFee : 0);

  // Filtered products (excluding bundle product)
  const filteredProducts = useMemo(() => {
    let list = products.filter((p) => p.category !== 'bundle');
    if (activeCategory !== 'all') {
      list = list.filter((p) => p.category === activeCategory);
    }
    return list;
  }, [products, activeCategory]);

  // Handle Checkout Button
  const handleGoToCheckout = () => {
    if (!isLoggedInCustomer) {
      initiateLineOAuth({ prefix: 'preorder_', returnPath: '/shop?view=checkout' });
      return;
    }
    setSearchParams({ view: 'checkout' });
  };

  // Submit Order
  const handleSubmitOrder = async () => {
    if (deliveryMethod === 'delivery') {
      if (!shippingAddress.name?.trim() || !shippingAddress.phone?.trim() || !shippingAddress.address?.trim()) {
        toast.show('請填寫完整宅配收件人資訊', { type: 'error' });
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const beadEntries = Object.entries(beadColorSelections)
        .filter(([, q]) => Number(q) > 0)
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
      const beadColorNote = beadEntries.map(([code, q]) => `${code}×${q}包`).join('、');
      const hasBeads = itemsBreakdown.some((i) => i.isBeads);
      const hasBundleInCart = !!(bundleProduct && cart[bundleProduct.id] > 0);

      const combinedCustomerNote = [
        hasBeads && beadColorNote ? `【融合豆色號明細】：${beadColorNote}` : '',
        customerNote.trim() ? `【一般備註】：${customerNote.trim()}` : '',
      ].filter(Boolean).join('\n');

      const payload = {
        items: itemsBreakdown.map((item) => ({
          product_id: item.product.id,
          quantity: item.qty,
          customization_note: item.isBeads ? beadColorNote : null,
          color_breakdown: item.isBeads && beadEntries.length > 0 ? beadColorSelections : null,
        })),
        payment_method_code: selectedPaymentCode,
        selected_bank_info: selectedBankInfo || null,
        delivery_method: deliveryMethod === 'delivery' ? 'shipping' : 'store_pickup',
        shipping_info: deliveryMethod === 'delivery' ? shippingAddress : null, // { name, phone, address }
        wish_note: hasBundleInCart && wishNote.trim() ? wishNote.trim() : null,
        customer_note: combinedCustomerNote || null,
        remittance_last5: null,
      };

      const res = await api.post('/shop/orders', payload);
      const createdOrder = res.data?.order || res.data;

      // Clear draft cart
      try {
        sessionStorage.removeItem(SHOP_DRAFT_STORAGE_KEY);
        localStorage.removeItem(SHOP_DRAFT_STORAGE_KEY);
      } catch (e) {}

      navigate(`/shop?view=done&order=${createdOrder.id || createdOrder.order_number}`, { replace: true });
    } catch (err) {
      console.error('Failed to submit order', err);
      const msg = err.response?.data?.message || err.response?.data?.error || '送出失敗，請重試';
      toast.show(msg, { type: 'error' });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Submit Remittance on Done page
  const handleReportRemittance = async () => {
    if (!doneOrder) return;
    const clean = remittanceLast5Input.trim();
    if (!/^\d{5}$/.test(clean)) {
      toast.show('請輸入 5 位數字帳號末五碼', { type: 'error' });
      return;
    }
    setReportingLast5(true);
    try {
      await api.patch(`/shop/orders/${doneOrder.id}/remittance`, { remittance_last5: clean });
      toast.show('已回報末五碼', { type: 'success' });
      setReportedSuccess(true);
    } catch (err) {
      console.error('Failed to report remittance', err);
      toast.show('回報失敗，請稍後再試', { type: 'error' });
    } finally {
      setReportingLast5(false);
    }
  };

  // Copy bank account on Done page
  const handleCopyAccount = async (account) => {
    const unspaced = account.replace(/\s+/g, '');
    try {
      await navigator.clipboard.writeText(unspaced);
      toast.show('已複製帳號', { type: 'success' });
    } catch (e) {
      toast.show(unspaced, { type: 'info' });
    }
  };

  // Has preorder items flag for AppBar right pill
  const hasPreorderItems = products.some((p) => p.is_preorder !== false);

  // -------------------------------------------------------------
  // VIEW: DONE (?view=done)
  // -------------------------------------------------------------
  if (view === 'done') {
    if (doneOrderLoading) {
      return (
        <CustomerLayout bare>
          <div className="py-20 flex justify-center">
            <BeadLoader />
          </div>
        </CustomerLayout>
      );
    }

    const orderNumber = doneOrder?.order_number || doneOrder?.id || doneOrderId;
    const depositRequired = doneOrder?.deposit_required || 0;
    const deadlineStr = doneOrder?.payment_deadline ? formatDateShort(doneOrder.payment_deadline) : '';
    const assignedAccount = doneOrder?.assigned_pool_account || doneOrder?.assigned_account || '9012 3456 7890 12';
    const isTransfer = doneOrder?.payment_method !== 'ONSITE';

    return (
      <CustomerLayout bare>
        <div className="flex flex-col min-h-[100dvh]">
          {/* 1. Grid Area */}
          <div className="sg-peg border-b border-sg-line grid justify-items-center gap-2 text-center px-5 pt-[max(28px,calc(env(safe-area-inset-top)+20px))] pb-[18px]">
            <div className="h-[50px] w-[50px] rounded-full bg-sg-sage text-white grid place-items-center shadow-sg-pop">
              <Check className="w-7 h-7" strokeWidth={2.4} />
            </div>
            <h1 className="font-display text-[24px] leading-[1.3] font-bold text-sg-ink">
              預購成功！
            </h1>
            <div className="font-num sg-small">{orderNumber}</div>
          </div>

          {/* 2. Content */}
          <div className="grid gap-3 px-4 pt-[14px] pb-5 flex-1">
            {isTransfer ? (
              <Card gap={8}>
                <div className="text-[14px] font-bold text-sg-ink">
                  {deadlineStr ? `請在 ${deadlineStr} 前匯款訂金` : '請盡快匯款訂金'}
                </div>
                <div className="font-num font-extrabold text-[28px] leading-[1.1] text-sg-brown">
                  {formatMoneyBig(depositRequired)}
                </div>

                <div className="grid gap-[2px] rounded-[12px] bg-sg-bg px-3 py-[10px]">
                  <div className="sg-small">中國信託 822 · 這筆訂單專用</div>
                  <div className="flex justify-between items-center">
                    <span className="font-num font-extrabold text-[16px] text-sg-ink">
                      {assignedAccount}
                    </span>
                    <Button
                      variant="text"
                      size="sm"
                      icon={<Copy className="w-4 h-4" />}
                      onClick={() => handleCopyAccount(assignedAccount)}
                      className="text-sg-brown font-bold"
                    >
                      複製
                    </Button>
                  </div>
                </div>

                {/* Remittance report */}
                {reportedSuccess ? (
                  <div className="text-sg-sage-ink text-[12px] font-bold">
                    已回報末五碼 {remittanceLast5Input || doneOrder?.remittance_last5}，店家確認後會更新狀態
                  </div>
                ) : (
                  <div className="flex gap-[6px]">
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      value={remittanceLast5Input}
                      onChange={(e) => setRemittanceLast5Input(e.target.value.replace(/\D/g, '').slice(0, 5))}
                      placeholder="匯款後輸入帳號末五碼"
                      className="flex-1 min-w-0 rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-3 py-[6px] text-[16px] text-sg-ink placeholder:text-sg-full focus:border-sg-brown focus:outline-none"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      loading={reportingLast5}
                      onClick={handleReportRemittance}
                      className="min-h-[44px] px-4"
                    >
                      回報
                    </Button>
                  </div>
                )}
              </Card>
            ) : (
              <Card gap={8}>
                <div className="text-[14px] font-bold text-sg-ink">到店付款，不用先匯款</div>
                <div className="font-num font-extrabold text-[28px] leading-[1.1] text-sg-brown">
                  {formatMoneyBig(depositRequired)}
                </div>
              </Card>
            )}

            <div className="sg-small px-1">
              到貨後會用 LINE 通知你到門市取貨並付尾款。
            </div>
          </div>

          {/* 3. Fixed Bottom Area */}
          <div className="sticky bottom-0 z-40 bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] grid gap-2">
            {globalSettings?.official_line_url && (
              <Button
                variant="secondary"
                size="sm"
                icon={<MessageCircle className="w-4 h-4" />}
                onClick={() => window.open(globalSettings.official_line_url, '_blank')}
                className="w-full"
              >
                傳 LINE 給我們對帳
              </Button>
            )}
            <Button
              variant="text"
              size="sm"
              onClick={() => navigate('/history?tab=orders')}
              className="w-full text-sg-brown font-bold"
            >
              查看我的預購
            </Button>
          </div>
        </div>
      </CustomerLayout>
    );
  }

  // -------------------------------------------------------------
  // VIEW: CHECKOUT (?view=checkout)
  // -------------------------------------------------------------
  if (view === 'checkout') {
    const isDepositEqualTotal = finalDepositAmount >= finalTotalAmount;
    const summaryPrefix = isDepositEqualTotal
      ? `總額 ${formatMoney(finalTotalAmount)} · 一次付清`
      : `總額 ${formatMoney(finalTotalAmount)} · 先付訂金`;

    const paymentMethods = paymentConfig?.payment_methods || [
      { code: 'ctbc_pool', name: '中信專屬轉帳帳號' },
    ];

    const isShippingOpen = paymentConfig?.enable_shipping;

    return (
      <CustomerLayout
        header={
          <AppBar
            variant="back"
            title="確認訂單"
            onBack={() => navigate('/shop')}
          />
        }
        bottom={
          <BottomActionBar
            summary={summaryPrefix}
            price={finalDepositAmount}
            actionLabel="送出預購"
            loading={isSubmitting}
            disabled={isSubmitting || totalItemsCount === 0}
            onAction={handleSubmitOrder}
            hasTabBarBelow={false}
          />
        }
      >
        <div className="grid gap-[10px] pb-8">
          {/* 1. Items Card */}
          <Card gap={6}>
            {itemsBreakdown.map((item, idx) => {
              if (item.isBeads) {
                const beadEntries = Object.entries(beadColorSelections).filter(([, q]) => Number(q) > 0);
                const colorBreakdownText = beadEntries.map(([code, q]) => `${code}×${q}包`).join('、');
                return (
                  <div key={idx} className="grid gap-1">
                    <KV
                      label={`融合豆 ${item.qty} 包（${beadEntries.length} 色）`}
                      value={<b className="font-num">{formatMoney(item.subtotal)}</b>}
                    />
                    {colorBreakdownText && (
                      <div className="sg-small text-sg-muted pl-1">
                        {colorBreakdownText}
                      </div>
                    )}
                  </div>
                );
              }
              return (
                <KV
                  key={idx}
                  label={`${item.product.name} ×${item.qty}`}
                  value={<b className="font-num">{formatMoney(item.subtotal)}</b>}
                />
              );
            })}
          </Card>

          {/* 2. Delivery Method */}
          <div className="grid gap-[6px]">
            <div className="text-[14px] font-bold text-sg-ink">取貨方式</div>
            {isShippingOpen ? (
              <>
                <div
                  role="tablist"
                  className="grid grid-cols-2 gap-[3px] rounded-[14px] bg-sg-brown-soft p-[3px] select-none text-center"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={deliveryMethod === 'store_pickup'}
                    onClick={() => setDeliveryMethod('store_pickup')}
                    className={`min-h-[44px] rounded-[11px] py-1 transition ${
                      deliveryMethod === 'store_pickup'
                        ? 'bg-sg-paper text-sg-ink shadow-[0_1px_3px_rgba(62,51,43,0.10)]'
                        : 'text-sg-muted'
                    }`}
                  >
                    <b className="block text-[13px] text-sg-ink">門市自取</b>
                    <span className="text-[12px] text-sg-muted">免運費</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={deliveryMethod === 'delivery'}
                    onClick={() => setDeliveryMethod('delivery')}
                    className={`min-h-[44px] rounded-[11px] py-1 transition ${
                      deliveryMethod === 'delivery'
                        ? 'bg-sg-paper text-sg-ink shadow-[0_1px_3px_rgba(62,51,43,0.10)]'
                        : 'text-sg-muted'
                    }`}
                  >
                    <b className="block text-[13px] text-sg-ink">宅配</b>
                    <span className="text-[12px] text-sg-muted">+ NT${globalSettings?.shop_shipping_fee ?? 60}</span>
                  </button>
                </div>

                {deliveryMethod === 'delivery' && (
                  <div className="grid gap-3 p-3 rounded-[14px] bg-sg-paper border border-sg-line mt-1">
                    <Field
                      label="收件人"
                      required
                      value={shippingAddress.name}
                      onChange={(e) => setShippingAddress({ ...shippingAddress, name: e.target.value })}
                      placeholder="收件人姓名"
                    />
                    <Field
                      label="手機號碼"
                      required
                      type="tel"
                      value={shippingAddress.phone}
                      onChange={(e) => setShippingAddress({ ...shippingAddress, phone: e.target.value })}
                      placeholder="0912 345 678"
                    />
                    <Field
                      label="地址"
                      required
                      value={shippingAddress.address}
                      onChange={(e) => setShippingAddress({ ...shippingAddress, address: e.target.value })}
                      placeholder="完整寄送地址"
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="sg-small text-sg-muted">
                門市自取（免運費）
              </div>
            )}
          </div>

          {/* 3. Payment Method */}
          <div className="grid gap-[6px]">
            <div className="text-[14px] font-bold text-sg-ink">付款方式</div>
            <div className="grid gap-2">
              {paymentMethods.map((m) => {
                const isPool = m.code === 'ctbc_pool';
                const isPoolExhausted = isPool && paymentConfig?.ctbc_pool_available_count === 0;
                const isSelected = selectedPaymentCode === m.code;
                const rawAccounts = m.bank_accounts_json;
                const bankAccounts = Array.isArray(rawAccounts)
                  ? rawAccounts
                  : typeof rawAccounts === 'string'
                  ? JSON.parse(rawAccounts || '[]')
                  : [];
                const hasMultipleBanks = bankAccounts.length > 1;

                return (
                  <div key={m.code} className="grid gap-1.5">
                    <label
                      className={`flex items-center gap-[10px] rounded-[14px] border-[1.5px] bg-sg-paper px-3 py-[9px] cursor-pointer transition select-none ${
                        isSelected
                          ? 'border-sg-brown bg-sg-selected'
                          : 'border-sg-line'
                      } ${isPoolExhausted ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <input
                        type="radio"
                        name="payment_method"
                        value={m.code}
                        disabled={isPoolExhausted}
                        checked={isSelected}
                        onChange={() => handleSelectPaymentMethod(m)}
                        className="sr-only"
                      />
                      <div
                        className={`w-[18px] h-[18px] rounded-full border-2 transition grid place-items-center shrink-0 ${
                          isSelected
                            ? 'border-[5px] border-sg-brown bg-white'
                            : 'border-sg-line'
                        }`}
                      />
                      <div className="flex-1 text-[13px] leading-[1.4]">
                        <b>{isPool ? '中信專屬轉帳帳號' : m.name}</b>
                        {isPool && (
                          <div className="sg-small">
                            {isPoolExhausted
                              ? '目前帳號已發完，請選其他方式'
                              : '送出後給你一組中信專用轉帳帳號，對帳最快'}
                          </div>
                        )}
                      </div>
                    </label>

                    {isSelected && hasMultipleBanks && (
                      <div className="pl-7 pr-2 grid gap-1.5">
                        <div className="text-[12px] font-bold text-sg-muted">請選擇匯款銀行：</div>
                        {bankAccounts.map((b, bIdx) => {
                          const bankStr = `${b.bank_name} (${b.bank_code}) ${b.account}`;
                          const isBankSelected = selectedBankInfo === bankStr;
                          return (
                            <label
                              key={bIdx}
                              className={`flex items-center gap-2 px-3 py-2 rounded-[10px] border text-[13px] cursor-pointer transition ${
                                isBankSelected
                                  ? 'border-sg-brown bg-sg-paper font-bold text-sg-ink shadow-sm'
                                  : 'border-sg-line bg-sg-bg text-sg-muted hover:text-sg-ink'
                              }`}
                            >
                              <input
                                type="radio"
                                name="selected_bank"
                                value={bankStr}
                                checked={isBankSelected}
                                onChange={() => setSelectedBankInfo(bankStr)}
                                className="sr-only"
                              />
                              <div
                                className={`w-3.5 h-3.5 rounded-full border transition grid place-items-center shrink-0 ${
                                  isBankSelected
                                    ? 'border-[4px] border-sg-brown bg-white'
                                    : 'border-sg-line'
                                }`}
                              />
                              <span>{b.bank_name} ({b.bank_code}) {b.account}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. Wish note if bundle allows it */}
          {bundleProduct && cart[bundleProduct.id] > 0 && bundleProduct.allow_wish_input && (
            <Field
              label="許願款式（選填）"
              isTextarea
              rows={2}
              value={wishNote}
              onChange={(e) => setWishNote(e.target.value)}
              placeholder={bundleProduct.wish_input_placeholder || '可以寫下你想要的顏色或款式'}
            />
          )}

          {/* 5. Customer note */}
          <Field
            label="備註（選填）"
            isTextarea
            rows={2}
            value={customerNote}
            onChange={(e) => setCustomerNote(e.target.value)}
            placeholder="其他需要備註的需求"
          />
        </div>
      </CustomerLayout>
    );
  }

  // -------------------------------------------------------------
  // VIEW: LIST (Catalog)
  // -------------------------------------------------------------
  const summaryBottomText = `已選 ${totalItemsCount} 件${depositTotal > 0 ? ` · 訂金 ${formatMoney(depositTotal)}` : ''}`;

  return (
    <CustomerLayout
      header={
        <AppBar
          variant="brand"
          title="商品預購"
          right={hasPreorderItems && <Pill variant="peach">限量預購</Pill>}
        />
      }
      bottom={
        (totalItemsCount > 0 || isLoggedInCustomer) && (
          <div>
            {totalItemsCount > 0 && (
              <BottomActionBar
                summary={summaryBottomText}
                price={totalAmount}
                actionLabel="去結帳"
                onAction={handleGoToCheckout}
                hasTabBarBelow={isLoggedInCustomer}
              />
            )}
            {isLoggedInCustomer && (
              <BottomTabBar
                shopEnabled={globalSettings?.shop_enabled !== false && globalSettings?.show_shop_button !== false}
              />
            )}
          </div>
        )
      }
    >
      <div className="grid gap-3 pb-8">
        {loading ? (
          <div className="py-20 flex justify-center">
            <BeadLoader />
          </div>
        ) : (
          <>
            {/* 1. Bundle Hero Card */}
            {bundleProduct && (
              <Card p={0} gap={0} className="overflow-hidden">
                {/* Image */}
                <div className="h-[96px] relative bg-sg-peach-soft grid place-items-center">
                  {bundleProduct.image_url ? (
                    <img
                      src={bundleProduct.image_url}
                      alt={bundleProduct.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="sg-peg w-full h-full grid place-items-center">
                      <BeadRow count={24} size={14} gap={4} />
                    </div>
                  )}
                </div>

                {/* Content */}
                <div className="grid gap-2 px-[14px] py-3">
                  <div className="flex justify-between items-center">
                    <b className="text-[15px] text-sg-ink">{bundleProduct.name}</b>
                    <span className="font-num font-extrabold text-[18px] text-sg-brown">
                      {formatMoney(bundleProduct.price)}
                    </span>
                  </div>

                  {/* Gifts */}
                  <div className="grid gap-[3px] sg-small">
                    <div className="flex items-center gap-[6px]">
                      <Check className="w-[14px] h-[14px] text-sg-sage-ink stroke-[2.5]" />
                      <span>加贈 3D 列印工具組（可許願）</span>
                    </div>
                    <div className="flex items-center gap-[6px]">
                      <Check className="w-[14px] h-[14px] text-sg-sage-ink stroke-[2.5]" />
                      <span>取貨再送中板代燙 5 次卡</span>
                    </div>
                  </div>

                  <div className="flex justify-between items-center pt-1 border-t border-sg-line">
                    <span className="sg-small">
                      訂金 {formatMoney(bundleProduct.deposit_amount || bundleProduct.price)}，到貨取件付尾款
                    </span>
                    <Stepper
                      value={cart[bundleProduct.id] || 0}
                      min={0}
                      max={99}
                      onMinus={() => updateCartQty(bundleProduct.id, -1)}
                      onPlus={() => updateCartQty(bundleProduct.id, 1)}
                      label={bundleProduct.name}
                    />
                  </div>
                </div>
              </Card>
            )}

            {/* 2. Sticky Category Bar */}
            <div className="sticky top-[calc(53px+env(safe-area-inset-top))] z-[25] bg-sg-bg py-2 -mx-4 px-4 flex gap-[6px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {availableCategoryTabs.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className={`min-h-[32px] px-3 py-1 rounded-full text-[12px] font-bold transition select-none flex-none ${
                    activeCategory === cat.id
                      ? 'bg-sg-brown text-white'
                      : 'bg-sg-paper border border-sg-line text-sg-muted hover:text-sg-ink'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {/* 3. Product Grid (2 columns) */}
            <div className="grid grid-cols-2 gap-2">
              {filteredProducts.map((p) => {
                const isBeads = p.category === 'beads';
                const qtyInCart = cart[p.id] || 0;
                const isSoldOut = p.status === 'SOLD_OUT';

                // Placeholder icon and bg based on category
                let bgClass = 'bg-sg-peach-soft';
                let IconComponent = Sparkles;
                if (p.category === 'boards') {
                  bgClass = 'bg-[#E9EFE4]';
                  IconComponent = Grid;
                } else if (p.category === 'ironing_cloth') {
                  bgClass = 'bg-sg-brown-soft';
                  IconComponent = Grid;
                } else if (p.category === 'tools_3d') {
                  bgClass = 'bg-[#F3E9DF]';
                  IconComponent = Sparkles;
                }

                return (
                  <div
                    key={p.id}
                    className="grid overflow-hidden rounded-[16px] border border-sg-line bg-sg-paper"
                  >
                    {/* Image */}
                    <div className="aspect-square relative overflow-hidden">
                      {p.image_url ? (
                        <img
                          src={p.image_url}
                          alt={p.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className={`sg-peg w-full h-full grid place-items-center ${bgClass}`}>
                          {isBeads ? (
                            <BeadRow count={12} size={12} gap={3} />
                          ) : (
                            <IconComponent className="w-[34px] h-[34px] text-sg-brown/60" />
                          )}
                        </div>
                      )}

                      {isSoldOut && (
                        <div className="absolute inset-0 bg-black/40 grid place-items-center">
                          <Pill variant="full">已售完</Pill>
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="grid gap-1 px-[10px] pt-2 pb-[10px]">
                      <div className="text-[13px] font-bold leading-[1.4] line-clamp-2 min-h-[36px]">
                        {p.name}
                      </div>

                      <div className="flex justify-between items-center mt-1">
                        <span className="font-num font-extrabold text-[15px] text-sg-brown">
                          {formatMoney(p.price)}
                        </span>

                        {isBeads ? (
                          <button
                            type="button"
                            disabled={isSoldOut}
                            onClick={() => setShowBeadPicker(true)}
                            aria-label={`加入 ${p.name}`}
                            className={`min-h-[44px] min-w-[44px] -mr-2 -my-2 grid place-items-center ${
                              isSoldOut ? 'opacity-40 cursor-not-allowed' : ''
                            }`}
                          >
                            <span className="w-7 h-7 rounded-full bg-sg-brown text-white grid place-items-center text-[12px] font-bold">
                              {qtyInCart > 0 ? qtyInCart : <Plus className="w-4 h-4 stroke-[2.5]" />}
                            </span>
                          </button>
                        ) : qtyInCart > 0 ? (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => updateCartQty(p.id, -1)}
                              aria-label={`減少 ${p.name}`}
                              className="w-7 h-7 rounded-full border border-sg-line bg-sg-paper text-sg-brown grid place-items-center"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="font-num font-bold text-[14px] min-w-[16px] text-center">
                              {qtyInCart}
                            </span>
                            <button
                              type="button"
                              onClick={() => updateCartQty(p.id, 1)}
                              aria-label={`增加 ${p.name}`}
                              className="w-7 h-7 rounded-full bg-sg-brown text-white grid place-items-center"
                            >
                              <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={isSoldOut}
                            onClick={() => updateCartQty(p.id, 1)}
                            aria-label={`加入 ${p.name}`}
                            className={`min-h-[44px] min-w-[44px] -mr-2 -my-2 grid place-items-center ${
                              isSoldOut ? 'opacity-40 cursor-not-allowed' : ''
                            }`}
                          >
                            <span className="w-7 h-7 rounded-full bg-sg-brown text-white grid place-items-center">
                              <Plus className="w-4 h-4 stroke-[2.5]" />
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Bead Picker Sheet */}
      {beadsProduct && (
        <BeadPickerSheet
          isOpen={showBeadPicker}
          onClose={() => setShowBeadPicker(false)}
          product={beadsProduct}
          selectedColors={beadColorSelections}
          onChangeColors={handleUpdateBeadColors}
          allColors={allBeadColors}
        />
      )}
    </CustomerLayout>
  );
}

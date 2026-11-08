import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  Calendar,
  Grid,
  QrCode,
  Search,
  ExternalLink,
  LogOut,
  Pencil,
  Clock,
  Copy,
  MessageCircle,
} from 'lucide-react';
import CustomerLayout from '../../components/customer/CustomerLayout';
import AppBar from '../../components/customer/AppBar';
import BottomTabBar from '../../components/customer/BottomTabBar';
import Button from '../../components/customer/Button';
import Pill from '../../components/customer/Pill';
import { Card, KV, Divider } from '../../components/customer/Card';
import { SoftBox, ErrorBanner } from '../../components/customer/Banners';
import StepIndicator from '../../components/customer/StepIndicator';
import EmptyState from '../../components/customer/EmptyState';
import { BeadLoader } from '../../components/customer/Bead';
import BarcodeSheet from '../../components/customer/sheets/BarcodeSheet';
import EquipmentAddonSheet from '../../components/customer/sheets/EquipmentAddonSheet';
import ConfirmSheet from '../../components/customer/sheets/ConfirmSheet';
import { useToast } from '../../components/customer/Toast';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';
import { useCustomerProfile } from '../../hooks/customer/useCustomerProfile';
import api from '../../api/axios';
import {
  formatDateShort,
  formatDateFull,
  weekdayChar,
  formatMoney,
  formatBookingRef,
  formatShortRef,
  formatPhone,
  formatYMD,
  toDateObj,
} from '../../utils/customer/format';
import { shortBoardName } from '../../utils/customer/pricing';

const QUICK_TAGS = ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起'];

// Helper to parse datePart safely handling ISO strings and Date objects
function parseReservationDate(datePart) {
  if (!datePart) return [new Date().getFullYear(), 1, 1];
  const d = toDateObj(datePart);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

function formatBoardTimeRange(e, resStartTime) {
  let startT = '';
  let endT = '';
  if (Array.isArray(e.covered_sessions) && e.covered_sessions.length > 0) {
    const firstCovered = e.covered_sessions[0];
    const lastCovered = e.covered_sessions[e.covered_sessions.length - 1];
    startT = firstCovered.includes('-') ? firstCovered.split('-')[0] : firstCovered;
    endT = lastCovered.includes('-') ? lastCovered.split('-')[1] : lastCovered;
  } else if ((e.start_time || resStartTime) && e.rental_hours) {
    const baseStart = e.start_time || resStartTime;
    const [sh, sm] = baseStart.split(':').map(Number);
    startT = baseStart;
    const eh = sh + (e.rental_hours || 0);
    endT = `${String(eh).padStart(2, '0')}:${String(sm || 0).padStart(2, '0')}`;
  }
  if (startT && endT) {
    return `${startT} 到 ${endT}`;
  }
  return e.rental_hours ? `${e.rental_hours} 小時` : '';
}

// Pill status helper for reservations (Section 6.13)
function getReservationStatusPill(r) {
  if (r.status === 'cancelled') {
    return { variant: 'full', text: '已取消' };
  }

  const now = new Date();
  const datePart = r.session_date || r.session?.session_date || '';
  const [y, m, d] = parseReservationDate(datePart);
  const [eH, eM] = (r.end_time || r.session?.end_time || '23:59').split(':').map(Number);
  const [sH, sM] = (r.start_time || r.session?.start_time || '00:00').split(':').map(Number);
  const endDt = new Date(y, m - 1, d, eH, eM, 0, 0);
  const startDt = new Date(y, m - 1, d, sH, sM, 0, 0);

  const isCheckedIn = r.attendance === 'checked_in';
  const hasEnded = now.getTime() >= endDt.getTime();

  if (isCheckedIn && hasEnded) {
    return { variant: 'full', text: '已完成' };
  }
  if (isCheckedIn && !hasEnded) {
    return { variant: 'ok', text: '已報到' };
  }

  // Not checked in, and 15 mins past start or ended
  const startPlus15 = new Date(startDt.getTime() + 15 * 60 * 1000);
  if (!isCheckedIn && (now.getTime() >= startPlus15.getTime() || hasEnded)) {
    return { variant: 'full', text: '預約未到' };
  }

  // Check days difference
  const today = new Date();
  const todayMid = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const resMid = new Date(y, m - 1, d);
  const diffDays = Math.round((resMid.getTime() - todayMid.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return { variant: 'brand', text: '已預約 · 今天' };
  }
  if (diffDays === 1) {
    return { variant: 'brand', text: '已預約 · 明天' };
  }
  return { variant: 'brand', text: `已預約 · 還有 ${diffDays} 天` };
}

// Order status helper (Section 6.15)
function getOrderStatusInfo(o) {
  if (o.order_status === 'cancelled') {
    return { pill: { variant: 'full', text: '已取消' }, step: 'none' };
  }
  if (o.payment_status === 'refunded') {
    return { pill: { variant: 'full', text: '已退款' }, step: 'none' };
  }
  if (o.order_status === 'picked_up') {
    return { pill: { variant: 'full', text: '已取貨' }, step: 'all' };
  }
  if (o.order_status === 'arrived') {
    return { pill: { variant: 'peach', text: '已到貨，可取貨' }, step: 3 };
  }
  if (o.payment_status === 'deposit_verified' || o.payment_status === 'fully_paid') {
    return { pill: { variant: 'brand', text: '備貨中' }, step: 2 };
  }
  if (o.payment_status === 'reported_pending_verify') {
    return { pill: { variant: 'low', text: '待確認入帳' }, step: 1 };
  }
  return { pill: { variant: 'low', text: '待付訂金' }, step: 1 };
}

export default function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const activeTab = searchParams.get('tab') || 'bookings';
  const detailRef = searchParams.get('ref') || null;

  const { settings: globalSettings } = useGlobalSettings();
  const { user } = useCustomerProfile();

  // Reservations state
  const [reservations, setReservations] = useState([]);
  const [loadingReservations, setLoadingReservations] = useState(true);
  const [resSearch, setResSearch] = useState('');
  const [pastLimit, setPastLimit] = useState(10);

  // Detail view state
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Sheet states
  const [activeBarcodeData, setActiveBarcodeData] = useState(null);
  const [activeAddonRes, setActiveAddonRes] = useState(null);

  // Orders state
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [remittanceInputs, setRemittanceInputs] = useState({});
  const [editingRemittance, setEditingRemittance] = useState({});
  const [reportingRemittance, setReportingRemittance] = useState({});

  // Passes state
  const [passes, setPasses] = useState([]);
  const [loadingPasses, setLoadingPasses] = useState(false);

  const fetchReservations = async () => {
    try {
      setLoadingReservations(true);
      const res = await api.get('/reservations/my');
      setReservations(Object.values(res.data || {}));
    } catch (err) {
      console.error('Failed to fetch reservations', err);
    } finally {
      setLoadingReservations(false);
    }
  };

  const fetchOrders = async () => {
    try {
      setLoadingOrders(true);
      const res = await api.get('/shop/my-orders');
      setOrders(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch orders', err);
    } finally {
      setLoadingOrders(false);
    }
  };

  const fetchPasses = async () => {
    try {
      setLoadingPasses(true);
      const res = await api.get('/passes/my');
      setPasses(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.error('Failed to fetch passes', err);
    } finally {
      setLoadingPasses(false);
    }
  };

  useEffect(() => {
    fetchReservations();
  }, []);

  useEffect(() => {
    if (activeTab === 'orders' && orders.length === 0) {
      fetchOrders();
    } else if (activeTab === 'passes' && passes.length === 0) {
      fetchPasses();
    }
  }, [activeTab]);

  // Tab switch
  const handleTabChange = (tab) => {
    setSearchParams({ tab }, { replace: true });
  };

  // Logout handler
  const handleLogout = async () => {
    try {
      await api.post('/auth/logout');
    } catch (e) {}
    try {
      sessionStorage.clear();
      localStorage.removeItem('shiguang_auth_token');
    } catch (e) {}
    window.location.href = '/';
  };

  // Find detail reservation if ?ref= is present
  const currentDetailRes = useMemo(() => {
    if (!detailRef) return null;
    return reservations.find((r) => r.booking_ref === detailRef) || null;
  }, [detailRef, reservations]);

  // When detail reservation opens, initialize note draft
  useEffect(() => {
    if (currentDetailRes) {
      setNoteDraft(currentDetailRes.customer_note || '');
      setEditingNote(false);
    }
  }, [currentDetailRes]);

  // Filter reservations into upcoming and past
  const { upcomingList, pastList } = useMemo(() => {
    const now = new Date();
    const up = [];
    const past = [];

    for (const r of reservations) {
      if (r.status === 'cancelled') {
        past.push(r);
        continue;
      }
      const datePart = r.session_date || r.session?.session_date || '';
      const [y, m, d] = parseReservationDate(datePart);
      const [eH, eM] = (r.end_time || r.session?.end_time || '23:59').split(':').map(Number);
      const endDt = new Date(y, m - 1, d, eH, eM, 0, 0);

      if (now.getTime() < endDt.getTime()) {
        up.push(r);
      } else {
        past.push(r);
      }
    }

    // Sort upcoming by start date/time ascending
    up.sort((a, b) => {
      const aDate = String(a.session_date || a.session?.session_date || '').slice(0, 10);
      const bDate = String(b.session_date || b.session?.session_date || '').slice(0, 10);
      const aTime = `${aDate} ${a.start_time || ''}`;
      const bTime = `${bDate} ${b.start_time || ''}`;
      return aTime.localeCompare(bTime);
    });

    // Sort past by start date/time descending
    past.sort((a, b) => {
      const aDate = String(a.session_date || a.session?.session_date || '').slice(0, 10);
      const bDate = String(b.session_date || b.session?.session_date || '').slice(0, 10);
      const aTime = `${aDate} ${a.start_time || ''}`;
      const bTime = `${bDate} ${b.start_time || ''}`;
      return bTime.localeCompare(aTime);
    });

    return { upcomingList: up, pastList: past };
  }, [reservations]);

  // Filter past list by search query if > 10 items
  const filteredPastList = useMemo(() => {
    const q = resSearch.trim().toLowerCase();
    if (!q) return pastList;
    return pastList.filter((r) => {
      const refMatch = (r.booking_ref || '').toLowerCase().includes(q);
      const cleanDate = String(r.session_date || r.session?.session_date || '').slice(0, 10);
      const dateMatch = cleanDate.includes(q);
      return refMatch || dateMatch;
    });
  }, [pastList, resSearch]);

  // Check if detail reservation can be modified for smart boards
  const canModifyAddon = useMemo(() => {
    if (!currentDetailRes) return false;
    if (currentDetailRes.status === 'cancelled') return false;
    const now = new Date();
    const datePart = currentDetailRes.session_date || currentDetailRes.session?.session_date || '';
    const [y, m, d] = parseReservationDate(datePart);
    const [eH, eM] = (currentDetailRes.end_time || currentDetailRes.session?.end_time || '23:59').split(':').map(Number);
    const endDt = new Date(y, m - 1, d, eH, eM, 0, 0);
    const twoHoursBeforeEnd = new Date(endDt.getTime() - 120 * 60 * 1000);
    return now.getTime() < twoHoursBeforeEnd.getTime();
  }, [currentDetailRes]);

  // Check if reservation is ended
  const isDetailEnded = useMemo(() => {
    if (!currentDetailRes) return false;
    const now = new Date();
    const datePart = currentDetailRes.session_date || currentDetailRes.session?.session_date || '';
    const [y, m, d] = parseReservationDate(datePart);
    const [eH, eM] = (currentDetailRes.end_time || currentDetailRes.session?.end_time || '23:59').split(':').map(Number);
    const endDt = new Date(y, m - 1, d, eH, eM, 0, 0);
    return now.getTime() >= endDt.getTime();
  }, [currentDetailRes]);

  // Check cancellation eligibility
  const canCancel = useMemo(() => {
    if (!currentDetailRes) return false;
    if (currentDetailRes.status === 'cancelled') return false;
    if (currentDetailRes.is_paid) return false;
    if (currentDetailRes.attendance === 'checked_in') return false;
    const now = new Date();
    const datePart = currentDetailRes.session_date || currentDetailRes.session?.session_date || '';
    const [y, m, d] = parseReservationDate(datePart);
    const [sH, sM] = (currentDetailRes.start_time || currentDetailRes.session?.start_time || '00:00').split(':').map(Number);
    const startDt = new Date(y, m - 1, d, sH, sM, 0, 0);
    return now.getTime() < startDt.getTime();
  }, [currentDetailRes]);

  // Save Note in Detail View
  const handleSaveNote = async () => {
    if (!currentDetailRes) return;
    setSavingNote(true);
    try {
      await api.patch(`/reservations/${currentDetailRes.booking_ref}/notes`, {
        customer_note: noteDraft.trim() || null,
      });
      toast.show('已更新備註', { type: 'success' });
      setEditingNote(false);
      fetchReservations();
    } catch (err) {
      console.error('Failed to update note', err);
      toast.show('更新失敗，請稍後再試', { type: 'error' });
    } finally {
      setSavingNote(false);
    }
  };

  // Cancel Reservation
  const handleCancelBooking = async () => {
    if (!currentDetailRes) return;
    setCancelling(true);
    try {
      await api.delete(`/reservations/${currentDetailRes.booking_ref}`);
      toast.show('已取消預約', { type: 'success' });
      setShowCancelConfirm(false);
      fetchReservations();
      navigate('/history?tab=bookings', { replace: true });
    } catch (err) {
      console.error('Failed to cancel reservation', err);
      const msg = err.response?.data?.message || err.response?.data?.error || '取消失敗，請洽門市';
      toast.show(msg, { type: 'error' });
    } finally {
      setCancelling(false);
    }
  };

  // Submit Remittance
  const handleReportRemittance = async (orderId) => {
    const code = (remittanceInputs[orderId] || '').trim();
    if (!/^\d{5}$/.test(code)) {
      toast.show('請輸入 5 位數字帳號末五碼', { type: 'error' });
      return;
    }
    setReportingRemittance((prev) => ({ ...prev, [orderId]: true }));
    try {
      await api.patch(`/shop/orders/${orderId}/remittance`, { remittance_last5: code });
      toast.show('已回報末五碼', { type: 'success' });
      setEditingRemittance((prev) => ({ ...prev, [orderId]: false }));
      fetchOrders();
    } catch (err) {
      console.error('Failed to report remittance', err);
      toast.show('回報失敗，請稍後再試', { type: 'error' });
    } finally {
      setReportingRemittance((prev) => ({ ...prev, [orderId]: false }));
    }
  };

  // Copy account number
  const handleCopyAccount = async (account) => {
    const unspaced = account.replace(/\s+/g, '');
    try {
      await navigator.clipboard.writeText(unspaced);
      toast.show('已複製帳號', { type: 'success' });
    } catch (e) {
      toast.show(unspaced, { type: 'info' });
    }
  };

  // Customer display name
  const customerName = user?.name ? (user.name.length > 8 ? `${user.name.slice(0, 8)}…` : user.name) : '';

  // -------------------------------------------------------------
  // RENDER: DETAIL VIEW (?ref=...)
  // -------------------------------------------------------------
  if (detailRef && currentDetailRes) {
    const r = currentDetailRes;
    const pill = getReservationStatusPill(r);
    const cleanDateStr = formatYMD(r.session_date || r.session?.session_date);
    const dateParts = cleanDateStr ? cleanDateStr.split('-') : [];
    const monthDay = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : cleanDateStr;
    const weekday = cleanDateStr ? `週${weekdayChar(cleanDateStr)}` : '';
    const timeRange = `${r.start_time} 到 ${r.end_time}${r.is_unlimited ? '（不限時）' : ''}`;
    const amountLabel = r.is_paid ? '金額（已付款）' : '預估金額';
    const contactInfo = `${r.customer_name || user?.name || ''} · ${formatPhone(r.customer_phone || user?.phone || '')}`;

    // Equipment lines
    const boards = r.equipments || [];
    const hasBoards = boards.some((e) => e.equipment_id !== 'bring_own');

    const cancelSummary = `${cleanDateStr ? formatDateShort(cleanDateStr) : ''} ${r.start_time} 到 ${r.end_time} · ${r.pax} 位`;

    return (
      <CustomerLayout
        header={
          <AppBar
            variant="backTwoLine"
            subtitle="預約詳情"
            onBack={() => navigate('/history?tab=bookings')}
          />
        }
      >
        <div className="grid gap-3 pb-8">
          {/* 1. Info Card */}
          <Card gap={8}>
            <div className="flex justify-between items-center">
              <Pill variant={pill.variant}>{pill.text}</Pill>
              <span className="font-num sg-small">{formatBookingRef(r.booking_ref)}</span>
            </div>

            <div className="flex items-baseline my-1">
              <span className="font-num font-extrabold text-[26px] leading-[1.2] text-sg-ink mr-2">
                {monthDay}
              </span>
              <span className="font-body text-[15px] font-bold text-sg-ink">
                {weekday}
              </span>
            </div>

            <KV label="時段" value={<b>{timeRange}</b>} />
            <KV label="人數" value={<b>{r.pax} 位</b>} />
            <KV
              label="智能拼豆板"
              value={
                !hasBoards ? (
                  '尚未加租'
                ) : (
                  <div className="text-right">
                    {boards
                      .filter((e) => e.equipment_id !== 'bring_own')
                      .map((e, idx) => {
                        const name = shortBoardName(e.equipment_name_snapshot || e.name || '智能板');
                        const timeSpan = formatBoardTimeRange(e, r.start_time || r.session?.start_time);
                        return (
                          <div key={idx}>
                            {name} ×{e.quantity || 1}（{timeSpan}）
                          </div>
                        );
                      })}
                  </div>
                )
              }
            />
            <KV label={amountLabel} value={<b className="font-num">{formatMoney(r.total_amount)}</b>} />
            <KV label="聯絡人" value={contactInfo} />
          </Card>

          {/* 2. Note Card */}
          <Card gap={6}>
            <div className="flex justify-between items-center">
              <div className="text-[14px] font-bold">備註</div>
              {!editingNote && (
                <Button
                  variant="text"
                  size="sm"
                  icon={<Pencil className="w-[15px] h-[15px]" />}
                  onClick={() => setEditingNote(true)}
                  className="text-sg-brown"
                >
                  編輯
                </Button>
              )}
            </div>

            {editingNote ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-[6px]">
                  {QUICK_TAGS.map((tag) => {
                    const isTagActive = (noteDraft || '').includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          let current = (noteDraft || '').trim();
                          if (current.includes(tag)) {
                            const regex = new RegExp(`(^|，|\\s*)${tag}(，|\\s*|$)`, 'g');
                            current = current.replace(regex, '，').replace(/^，|，$/g, '').replace(/，{2,}/g, '，').trim();
                          } else {
                            current = current ? `${current}，${tag}` : tag;
                          }
                          setNoteDraft(current);
                        }}
                        className={`min-h-[32px] px-[10px] py-[3px] rounded-full text-[12px] font-bold transition select-none ${
                          isTagActive
                            ? 'bg-sg-brown-soft text-sg-brown'
                            : 'bg-sg-full-soft text-sg-muted hover:text-sg-ink'
                        }`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>

                <textarea
                  rows={2}
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder="也可以直接打字寫其他需求"
                  maxLength={120}
                  className="w-full rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-[10px] py-2 text-[16px] text-sg-ink placeholder:text-sg-full focus:border-sg-brown focus:outline-none resize-none"
                />

                <div className="flex gap-2 justify-end mt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={savingNote}
                    onClick={() => setEditingNote(false)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={savingNote}
                    disabled={savingNote}
                    onClick={handleSaveNote}
                  >
                    儲存
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-sg-muted">
                {r.customer_note || '沒有備註'}
              </div>
            )}
          </Card>

          {/* 3. Addon Smart Board Button */}
          {canModifyAddon && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Grid className="w-4 h-4" />}
              onClick={() => setActiveAddonRes(r)}
              className="w-full"
            >
              {hasBoards ? '修改智能拼豆板' : '加租智能拼豆板'}
            </Button>
          )}
          {!isDetailEnded && !canModifyAddon && (
            <div className="sg-small text-center">
              距離結束不到 2 小時，智能板請洽現場
            </div>
          )}

          {/* 4. Cancellation Area */}
          <div className="grid gap-[2px] text-center mt-2">
            {canCancel && (
              <>
                <Button
                  variant="dangerText"
                  onClick={() => setShowCancelConfirm(true)}
                  className="justify-self-center"
                >
                  取消這筆預約
                </Button>
                <div className="sg-small">
                  開始前都可以線上取消；已付款請洽門市
                </div>
              </>
            )}
            {r.is_paid && !canCancel && r.status !== 'cancelled' && (
              <div className="sg-small">
                已付款的預約請洽門市取消
              </div>
            )}
            {!canCancel && !r.is_paid && r.status !== 'cancelled' && !isDetailEnded && (
              <div className="sg-small">
                預約已開始，如需協助請洽門市
              </div>
            )}
          </div>
        </div>

        {/* Cancellation Confirm Sheet */}
        <ConfirmSheet
          isOpen={showCancelConfirm}
          onClose={() => setShowCancelConfirm(false)}
          onConfirm={handleCancelBooking}
          loading={cancelling}
          title="確定取消這筆預約？"
          summary={cancelSummary}
          description="取消後名額會釋出，需要的話請重新預約。"
          confirmText="確定取消"
          cancelText="先不要"
          confirmVariant="danger"
        />

        {/* Equipment Addon Sheet */}
        <EquipmentAddonSheet
          isOpen={!!activeAddonRes}
          onClose={() => setActiveAddonRes(null)}
          reservation={activeAddonRes}
          onSuccess={fetchReservations}
        />
      </CustomerLayout>
    );
  }

  // -------------------------------------------------------------
  // RENDER: MEMBER CENTER LIST VIEWS
  // -------------------------------------------------------------
  return (
    <CustomerLayout
      header={
        <AppBar
          variant="brandTwoLine"
          subtitle="我的會員"
          right={customerName && <span className="sg-small truncate max-w-[8em]">{customerName}</span>}
        />
      }
      bottom={
        <BottomTabBar
          shopEnabled={globalSettings?.shop_enabled !== false && globalSettings?.show_shop_button !== false}
        />
      }
    >
      <div className="grid gap-3 pb-8">
        {/* 1. Segment Switch */}
        <div
          role="tablist"
          className="grid grid-cols-3 gap-[3px] rounded-[14px] bg-sg-brown-soft p-[3px] select-none"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'bookings'}
            onClick={() => handleTabChange('bookings')}
            className={`min-h-[40px] rounded-[11px] text-[13px] font-bold transition ${
              activeTab === 'bookings'
                ? 'bg-sg-paper text-sg-ink shadow-[0_1px_3px_rgba(62,51,43,0.10)]'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            手作預約
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'orders'}
            onClick={() => handleTabChange('orders')}
            className={`min-h-[40px] rounded-[11px] text-[13px] font-bold transition ${
              activeTab === 'orders'
                ? 'bg-sg-paper text-sg-ink shadow-[0_1px_3px_rgba(62,51,43,0.10)]'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            商品預購
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'passes'}
            onClick={() => handleTabChange('passes')}
            className={`min-h-[40px] rounded-[11px] text-[13px] font-bold transition ${
              activeTab === 'passes'
                ? 'bg-sg-paper text-sg-ink shadow-[0_1px_3px_rgba(62,51,43,0.10)]'
                : 'text-sg-muted hover:text-sg-ink'
            }`}
          >
            卡券
          </button>
        </div>

        {/* -------------------------------------------------------- */}
        {/* TAB 1: BOOKINGS */}
        {/* -------------------------------------------------------- */}
        {activeTab === 'bookings' && (
          <div className="grid gap-3">
            {loadingReservations ? (
              <div className="py-12 flex justify-center">
                <BeadLoader />
              </div>
            ) : reservations.length === 0 ? (
              <EmptyState
                title="還沒有預約"
                description="選一個時段，來拼一段屬於你的時光"
                actionLabel="去預約"
                onAction={() => navigate('/booking')}
              />
            ) : (
              <>
                {/* Upcoming bookings */}
                {upcomingList.map((r, idx) => {
                  const pill = getReservationStatusPill(r);
                  const cleanResDate = formatYMD(r.session_date || r.session?.session_date);
                  const resParts = cleanResDate ? cleanResDate.split('-') : [];
                  const monthDay = resParts.length === 3 ? `${resParts[1]}/${resParts[2]}` : cleanResDate;
                  const weekday = cleanResDate ? `週${weekdayChar(cleanResDate)}` : '';
                  const dateShort = formatDateShort(cleanResDate);
                  const timeDesc = `${r.start_time} 到 ${r.end_time} · ${r.pax} 位 · ${formatMoney(r.total_amount)}`;
                  const boards = r.equipments || [];
                  const hasBoards = boards.some((e) => e.equipment_id !== 'bring_own');

                  // Check if can add/modify smart board
                  const now = new Date();
                  const [y, m, d] = parseReservationDate(r.session_date || r.session?.session_date);
                  const [eH, eM] = (r.end_time || '23:59').split(':').map(Number);
                  const endDt = new Date(y, m - 1, d, eH, eM, 0, 0);
                  const canAddon = now.getTime() < endDt.getTime() - 120 * 60 * 1000;

                  const isNearest = idx === 0;

                  return (
                    <Card
                      key={r.booking_ref}
                      gap={10}
                      className="cursor-pointer active:scale-[0.99] transition hover:border-sg-brown select-none"
                      onClick={() => navigate(`/history?tab=bookings&ref=${r.booking_ref}`)}
                    >
                      {/* Top row */}
                      <div className="flex justify-between items-center">
                        <Pill variant={pill.variant}>{pill.text}</Pill>
                        <span className="font-num sg-small">{formatShortRef(r.booking_ref)}</span>
                      </div>

                      {/* Date & Time */}
                      <div className="text-left group">
                        <div className="flex items-baseline">
                          <span className="font-num font-extrabold text-[26px] leading-[1.2] text-sg-ink mr-2 group-hover:text-sg-brown transition">
                            {monthDay}
                          </span>
                          <span className="font-body text-[15px] font-bold text-sg-ink">
                            {weekday}
                          </span>
                        </div>
                        <div className="text-[14px] text-sg-muted mt-[2px]">
                          {timeDesc}
                        </div>
                      </div>

                      {/* Smart board row */}
                      {canAddon && (
                        <div
                          className="flex items-center gap-2 rounded-[12px] bg-sg-bg p-[10px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Grid className="w-[18px] h-[18px] text-sg-muted shrink-0" />
                          <div className="text-[13px] flex-1 text-sg-ink">
                            {!hasBoards ? (
                              '尚未加租智能拼豆板'
                            ) : (() => {
                              const filteredBoards = boards.filter((e) => e.equipment_id !== 'bring_own');
                              const totalCount = filteredBoards.reduce((sum, e) => sum + (e.quantity || 1), 0);
                              if (totalCount >= 3) {
                                return <span>智能板 {totalCount} 台</span>;
                              }
                              return (
                                <span>
                                  {filteredBoards
                                    .map((e) => {
                                      const name = shortBoardName(e.equipment_name_snapshot || e.name || '智能板');
                                      const timeSpan = formatBoardTimeRange(e, r.start_time || r.session?.start_time);
                                      return `${name} ×${e.quantity || 1} · ${timeSpan}`;
                                    })
                                    .join('、')}
                                </span>
                              );
                            })()}
                          </div>
                          <Button
                            variant="text"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveAddonRes(r);
                            }}
                            className="text-sg-brown font-bold"
                          >
                            {hasBoards ? '修改' : '加租'}
                          </Button>
                        </div>
                      )}

                      {/* Barcode button */}
                      <Button
                        variant={isNearest ? 'primary' : 'secondary'}
                        size="sm"
                        icon={<QrCode className="w-4 h-4" />}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveBarcodeData({
                            ref: r.booking_ref,
                            summary: `${dateShort} ${r.start_time} 到 ${r.end_time} · ${r.pax} 位`,
                          });
                        }}
                        className="w-full mt-1"
                      >
                        出示到店條碼
                      </Button>

                      {/* Link to details and cancel */}
                      <div className="flex justify-end pt-0.5">
                        <span className="text-[13px] font-bold text-sg-brown hover:underline inline-flex items-center">
                          詳情與取消 ›
                        </span>
                      </div>
                    </Card>
                  );
                })}

                {/* Past Bookings */}
                {pastList.length > 0 && (
                  <div className="grid gap-2 mt-4">
                    <div className="sg-small px-1">過去的預約</div>

                    {reservations.length > 10 && (
                      <div className="flex items-center gap-2 rounded-[12px] border border-sg-line bg-sg-paper px-3 py-2">
                        <Search className="w-4 h-4 text-sg-muted shrink-0" />
                        <input
                          type="text"
                          value={resSearch}
                          onChange={(e) => setResSearch(e.target.value)}
                          placeholder="搜尋日期或預約編號"
                          className="w-full bg-transparent text-[14px] text-sg-ink placeholder:text-sg-full focus:outline-none"
                        />
                      </div>
                    )}

                    {filteredPastList.slice(0, pastLimit).map((r) => {
                      const pill = getReservationStatusPill(r);
                      const cleanPastDate = formatYMD(r.session_date || r.session?.session_date);
                      const dateShort = formatDateShort(cleanPastDate);
                      const timeDesc = `${r.start_time} 到 ${r.end_time} · ${r.pax} 位`;

                      return (
                        <Card
                          key={r.booking_ref}
                          gap={4}
                          className="opacity-[.85] cursor-pointer hover:border-sg-brown transition"
                          onClick={() => navigate(`/history?tab=bookings&ref=${r.booking_ref}`)}
                        >
                          <div className="flex justify-between items-center">
                            <span className="font-num font-bold text-[14px] text-sg-ink">
                              {dateShort}
                            </span>
                            <Pill variant={pill.variant}>{pill.text}</Pill>
                          </div>
                          <div className="sg-small">{timeDesc}</div>
                        </Card>
                      );
                    })}

                    {filteredPastList.length > pastLimit && (
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => setPastLimit((prev) => prev + 10)}
                        className="justify-self-center text-sg-brown font-bold"
                      >
                        看更多
                      </Button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* -------------------------------------------------------- */}
        {/* TAB 2: ORDERS */}
        {/* -------------------------------------------------------- */}
        {activeTab === 'orders' && (
          <div className="grid gap-3">
            {loadingOrders ? (
              <div className="py-12 flex justify-center">
                <BeadLoader />
              </div>
            ) : orders.length === 0 ? (
              <EmptyState
                title="還沒有預購"
                actionLabel="去逛商城"
                onAction={() => navigate('/shop')}
              />
            ) : (
              orders.map((o) => {
                const statusInfo = getOrderStatusInfo(o);
                const firstItem = (o.items && o.items[0]) || {};
                const otherCount = (o.items?.length || 1) - 1;
                const itemSummary = firstItem.product_name
                  ? `${firstItem.product_name}${otherCount > 0 ? ` 等 ${otherCount + 1} 項` : ''}`
                  : '預購商品';
                const totalAmount = o.total_amount || 0;
                const depositRequired = o.deposit_required || 0;
                const paidAmount = o.paid_amount || 0;
                const depositRemain = Math.max(0, depositRequired - paidAmount);

                const isPendingPayment =
                  o.payment_status === 'pending_payment' ||
                  o.payment_status === 'reported_pending_verify';
                const isTransfer = o.payment_method !== 'ONSITE';

                const deadlineStr = o.payment_deadline ? formatDateShort(o.payment_deadline) : '';

                // Account info
                const assignedAccount = o.assigned_pool_account || o.assigned_account || '9012 3456 7890 12';
                const hasReportedLast5 = !!o.remittance_last5;
                const isEditingLast5 = editingRemittance[o.id];

                return (
                  <Card key={o.id} gap={10}>
                    {/* 1. Header */}
                    <div className="flex justify-between items-center">
                      <span className="font-num sg-small">{o.order_number || o.id}</span>
                      <Pill variant={statusInfo.pill.variant}>{statusInfo.pill.text}</Pill>
                    </div>

                    {/* 2. Product name & summary */}
                    <div>
                      <div className="text-[15px] font-bold text-sg-ink">
                        {itemSummary}
                      </div>
                      <div className="sg-small mt-0.5">
                        ×{o.items?.reduce((a, b) => a + (b.quantity || 1), 0) || 1} · 總額 {formatMoney(totalAmount)} · 訂金 {formatMoney(depositRequired)}
                        {o.shipping_method === 'DELIVERY' && ' · 宅配'}
                      </div>
                    </div>

                    {/* 3. StepIndicator */}
                    <StepIndicator
                      steps={['已下單', '付訂金', '已到貨', '已取貨']}
                      currentStep={statusInfo.step}
                      className="my-1"
                    />

                    {/* 4. Payment Box */}
                    {isPendingPayment && isTransfer && (
                      <div className="grid gap-[6px] rounded-[12px] bg-sg-bg px-3 py-[10px]">
                        <div className="text-[13px] font-bold text-sg-ink">
                          {deadlineStr ? `請在 ${deadlineStr} 前匯款 ${formatMoney(depositRemain)}` : `請盡快匯款 ${formatMoney(depositRemain)}`}
                        </div>

                        {/* Account row */}
                        <div className="flex justify-between items-center">
                          <div>
                            <div className="sg-small">中國信託 822</div>
                            <div className="font-num text-[14px] font-bold text-sg-ink tracking-wide">
                              {assignedAccount}
                            </div>
                          </div>
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

                        {/* Last 5 digits row */}
                        {hasReportedLast5 && !isEditingLast5 ? (
                          <div className="flex items-center justify-between text-[12px] text-sg-sage-ink font-bold pt-1">
                            <span>已回報末五碼 {o.remittance_last5}，等待店家確認</span>
                            <Button
                              variant="text"
                              size="sm"
                              onClick={() => setEditingRemittance((prev) => ({ ...prev, [o.id]: true }))}
                              className="text-[12px] text-sg-muted"
                            >
                              修改
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-[6px] pt-1">
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={5}
                              value={remittanceInputs[o.id] || ''}
                              onChange={(e) =>
                                setRemittanceInputs((prev) => ({
                                  ...prev,
                                  [o.id]: e.target.value.replace(/\D/g, '').slice(0, 5),
                                }))
                              }
                              placeholder="匯款帳號末五碼"
                              className="flex-1 min-w-0 rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-3 py-[6px] text-[16px] text-sg-ink placeholder:text-sg-full focus:border-sg-brown focus:outline-none"
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              loading={reportingRemittance[o.id]}
                              onClick={() => handleReportRemittance(o.id)}
                              className="min-h-[44px] px-4"
                            >
                              回報
                            </Button>
                          </div>
                        )}

                        {/* LINE verify button */}
                        {globalSettings?.official_line_url && (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={<MessageCircle className="w-4 h-4" />}
                            onClick={() => window.open(globalSettings.official_line_url, '_blank')}
                            className="w-full mt-1"
                          >
                            傳 LINE 給我們對帳
                          </Button>
                        )}
                      </div>
                    )}

                    {/* 5. Estimated Arrival */}
                    {o.estimated_arrival && (
                      <div className="flex items-center gap-[6px] sg-small">
                        <Clock className="w-[15px] h-[15px] text-sg-muted shrink-0" />
                        <span>{o.estimated_arrival}</span>
                      </div>
                    )}

                    {/* 6. Wish notes */}
                    {o.wish_note && (
                      <div className="sg-small">
                        許願款式：{o.wish_note}
                      </div>
                    )}
                    {o.wish_reply && (
                      <SoftBox>
                        店家回覆：{o.wish_reply}
                      </SoftBox>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* -------------------------------------------------------- */}
        {/* TAB 3: PASSES */}
        {/* -------------------------------------------------------- */}
        {activeTab === 'passes' && (
          <div className="grid gap-3">
            {loadingPasses ? (
              <div className="py-12 flex justify-center">
                <BeadLoader />
              </div>
            ) : passes.length === 0 ? (
              <EmptyState
                title="還沒有卡券"
                description="購買套裝或參加活動送的卡券會出現在這裡"
              />
            ) : (
              passes.map((p) => {
                const isActive = p.status === 'ACTIVE';
                const isPunchCard = p.pass_type === 'PUNCH_CARD';
                const totalQuota = p.total_quota || 0;
                const remainingQuota = p.remaining_quota || 0;

                // Status pill calculation (Section 6.16)
                let pillVariant = 'full';
                let pillText = '已用完';
                if (isActive) {
                  const now = new Date();
                  if (p.expires_at) {
                    const expDt = new Date(p.expires_at);
                    const diffDays = Math.ceil((expDt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                    if (diffDays <= 14 && diffDays >= 0) {
                      pillVariant = 'low';
                      pillText = `剩 ${diffDays} 天`;
                    } else {
                      pillVariant = 'ok';
                      pillText = '可使用';
                    }
                  } else {
                    pillVariant = 'ok';
                    pillText = '可使用';
                  }
                } else if (p.status === 'EXPIRED') {
                  pillText = '已過期';
                } else if (p.status === 'REVOKED') {
                  pillText = '已停用';
                }

                // Details string joined by ·
                const details = [];
                if (!p.expires_at) {
                  details.push('無使用期限');
                } else if (p.pass_type === 'MONTHLY_PASS' || p.pass_type === 'TIME_PASS') {
                  details.push(`${formatDateFull(p.created_at)} 到 ${formatDateShort(p.expires_at)}`);
                } else {
                  details.push(`有效至 ${formatDateFull(p.expires_at)}`);
                }

                if (p.order_product_name) {
                  const prefix = /^[0-9A-Za-z]/.test(p.order_product_name) ? '購買 ' : '購買';
                  details.push(`${prefix}${p.order_product_name}贈送`);
                } else if (p.order_ref) {
                  details.push('購買商品贈送');
                }

                if (p.day_restriction === 'WEEKDAY_ONLY') details.push('僅限平日');
                if (p.day_restriction === 'WEEKEND_ONLY') details.push('僅限假日');
                if (p.pass_type === 'DISCOUNT_VOUCHER') details.push('結帳時出示條碼使用');

                const detailsText = details.join(' · ');

                return (
                  <Card key={p.id} gap={8} className={!isActive ? 'gap-1 opacity-75' : ''}>
                    {/* Top row */}
                    <div className="flex justify-between items-center">
                      <b className="text-[15px] text-sg-ink">{p.plan_name_snapshot || p.name || '卡券'}</b>
                      <Pill variant={pillVariant}>{pillText}</Pill>
                    </div>

                    {/* Punch card beads row */}
                    {isPunchCard && totalQuota <= 20 && totalQuota > 0 && (
                      <div className="flex items-center gap-[6px] my-1 flex-wrap">
                        {Array.from({ length: totalQuota }).map((_, i) => (
                          <span
                            key={i}
                            className={`sg-bead ${i < remainingQuota ? '' : 'sg-bead-empty'}`}
                            style={{
                              '--sg-bead-size': '18px',
                              '--sg-bead-bw': '5px',
                              '--sg-bead-color': i < remainingQuota ? '#8B5B43' : '#E6DDD2',
                            }}
                          />
                        ))}
                        <span className="sg-small ml-[6px]">
                          剩 <b className="font-num text-[15px] text-sg-ink">{remainingQuota}</b> / {totalQuota} 次
                        </span>
                      </div>
                    )}

                    {/* Punch card text fallback */}
                    {isPunchCard && totalQuota > 20 && (
                      <div className="sg-small">
                        剩 <b className="font-num text-[15px] text-sg-ink">{remainingQuota}</b> / {totalQuota} 次
                      </div>
                    )}

                    {/* Details line */}
                    <div className="sg-small">{detailsText}</div>

                    {/* Active barcode button */}
                    {isActive && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setActiveBarcodeData({
                            ref: p.pass_code,
                            isPass: true,
                            passCode: p.pass_code,
                            passName: p.plan_name_snapshot || '卡券',
                          })
                        }
                        className="w-full mt-1"
                      >
                        <QrCode className="w-4 h-4 mr-1" />
                        出示卡券條碼
                      </Button>
                    )}
                  </Card>
                );
              })
            )}
          </div>
        )}

        {/* 6. Page bottom buttons (all 3 tabs) */}
        <div className="flex items-center justify-center gap-1 sg-small text-sg-muted mt-4">
          {globalSettings?.show_line_button !== false && globalSettings?.official_line_url && (
            <>
              <a
                href={globalSettings.official_line_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sg-brown font-bold hover:underline inline-flex items-center gap-1"
              >
                加入官方 LINE
                <ExternalLink className="w-[14px] h-[14px]" />
              </a>
              <span>·</span>
            </>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="text-sg-brown font-bold hover:underline inline-flex items-center gap-1"
          >
            登出
            <LogOut className="w-[14px] h-[14px]" />
          </button>
        </div>
      </div>

      {/* Barcode Sheet */}
      <BarcodeSheet
        isOpen={!!activeBarcodeData}
        onClose={() => setActiveBarcodeData(null)}
        bookingRef={activeBarcodeData?.ref}
        summaryText={activeBarcodeData?.summary}
        isPass={activeBarcodeData?.isPass}
        passCode={activeBarcodeData?.passCode}
        passName={activeBarcodeData?.passName}
      />

      {/* Equipment Addon Sheet */}
      <EquipmentAddonSheet
        isOpen={!!activeAddonRes}
        onClose={() => setActiveAddonRes(null)}
        reservation={activeAddonRes}
        onSuccess={fetchReservations}
      />
    </CustomerLayout>
  );
}

import React, { useState, useMemo, useEffect } from 'react';
import StepIndicator from '../../../components/customer/StepIndicator';
import { Card, KV, Divider } from '../../../components/customer/Card';
import PriceLines from '../../../components/customer/PriceLines';
import Button from '../../../components/customer/Button';
import Pill from '../../../components/customer/Pill';
import Skeleton from '../../../components/customer/Skeleton';
import EmptyState from '../../../components/customer/EmptyState';
import { ErrorBanner } from '../../../components/customer/Banners';
import BottomActionBar from '../../../components/customer/BottomActionBar';
import StoreContactCard from '../../../components/customer/StoreContactCard';
import SplitSeatSheet from '../../../components/customer/sheets/SplitSeatSheet';
import Stepper from '../../../components/customer/Stepper';
import { BeadLoader } from '../../../components/customer/Bead';
import { useToast } from '../../../components/customer/Toast';
import api from '../../../api/axios';
import { earliestEntry, ironText as buildIronText } from '../../../../../shared/selfService.js';
import {
  formatDateShort,
  weekdayChar,
  formatTimeRange,
  formatMoney,
} from '../../../utils/customer/format';
import {
  buildPriceLines,
  buildDiscountConfig,
  calcPromoDiscount,
} from '../../../utils/customer/pricing';
import { validateCouponPax } from '../../../utils/customer/couponPaxValidation';

const QUICK_TAGS = ['第一次玩', '有小孩同行', '生日慶祝', '希望坐一起'];

export default function StepConfirm({
  date,
  mode,
  bookingSessions = [],
  pax,
  units,
  customerNote,
  onChangeNote,
  promo,
  onChangePromo,
  globalSettings,
  dayPricing,
  daily = null,
  selfPassUses = {},
  onChangeSelfPassUses = () => {},
  selfTransferMethod = null,
  onChangeSelfTransferMethod = () => {},
  selfServiceAck = false,
  onChangeSelfServiceAck = () => {},
  hasPricing = true,
  globalLoading = false,
  globalError = null,
  onReloadPricing,
  equipmentConfigs = [],
  onBack,
  onBookingSuccess,
  onGoBackToSelectTime,
}) {
  const toast = useToast();
  const [promoInput, setPromoInput] = useState('');
  const [promoLoading, setPromoLoading] = useState(false);
  const [promoError, setPromoError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bookingLimitError, setBookingLimitError] = useState('');
  const [showSplitSheet, setShowSplitSheet] = useState(false);

  const isSelfService = Boolean(daily?.is_self_service);
  const [prepayOptions, setPrepayOptions] = useState(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [prepayQuote, setPrepayQuote] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [quoteNonce, setQuoteNonce] = useState(0);
  const quoteSeqRef = React.useRef(0);

  const H = bookingSessions.length;
  const startTime = bookingSessions[0]?.start_time || '';
  const endTime = bookingSessions[H - 1]?.end_time || '';
  const hourStartTimes = useMemo(() => bookingSessions.map((s) => s.start_time), [bookingSessions]);

  const configsMap = useMemo(() => {
    const map = {};
    equipmentConfigs.forEach((c) => {
      const eqId = c.equipment_id || c.id;
      if (eqId) map[eqId] = c;
    });
    return map;
  }, [equipmentConfigs]);

  const discountCfg = useMemo(() => buildDiscountConfig(globalSettings || {}), [globalSettings]);

  const noteChips = useMemo(() => {
    if (Array.isArray(globalSettings?.booking_note_chips) && globalSettings.booking_note_chips.length > 0) {
      return globalSettings.booking_note_chips;
    }
    return QUICK_TAGS;
  }, [globalSettings]);

  // Pricing calculations
  const priceCalculation = useMemo(() => {
    if (!dayPricing) {
      return { lines: [], seat: { raw: 0, total: 0, capSaving: 0 }, equipmentTotal: 0, promoAmount: 0, total: 0, saving: 0 };
    }
    return buildPriceLines({
      pax,
      hours: H,
      startTime,
      endTime,
      day: dayPricing,
      mode,
      units,
      configs: configsMap,
      discountCfg,
      promo,
      bookingSessions,
    });
  }, [pax, H, startTime, endTime, dayPricing, mode, units, configsMap, discountCfg, promo, bookingSessions]);

  const passUsesList = useMemo(() => {
    return Object.entries(selfPassUses || {})
      .map(([id, count]) => ({ user_pass_id: Number(id), units: Number(count) || 0 }))
      .filter((item) => Number.isFinite(item.user_pass_id) && item.units > 0);
  }, [selfPassUses]);

  const totalPassPersons = useMemo(
    () => passUsesList.reduce((sum, item) => sum + item.units, 0),
    [passUsesList]
  );

  // Auto-cancel promo if pax (or unpaid pax on self-service day) requirement not met (Round 18 & 25)
  useEffect(() => {
    if (promo) {
      const checkPax = isSelfService ? Math.max(0, pax - totalPassPersons) : pax;
      const check = validateCouponPax(promo, checkPax);
      if (check.cancelled) {
        onChangePromo(null);
        toast.show(check.message, { type: 'info' });
      }
    }
  }, [pax, totalPassPersons, isSelfService, promo]);

  const allUsingPass = isSelfService && totalPassPersons >= pax;

  // Clear promo when all participants use punch cards
  useEffect(() => {
    if (allUsingPass && promo) {
      onChangePromo(null);
      setPromoError('');
    }
  }, [allUsingPass, promo, onChangePromo]);

  // Fetch prepay options on self-service days
  useEffect(() => {
    if (!isSelfService || !date) {
      setPrepayOptions(null);
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    api.get(`/reservations/prepay-options?date=${encodeURIComponent(date)}&pax=${pax}`)
      .then((res) => {
        if (cancelled) return;
        const data = res.data || null;
        setPrepayOptions(data);

        // Clamp pass selection against updated usable_units & pax
        const availMap = Object.fromEntries(
          (data?.passes || []).map((p) => [p.user_pass_id, p.usable_units ?? p.remaining_uses ?? 0])
        );
        let changed = false;
        let running = 0;
        const nextUses = {};
        for (const [k, rawVal] of Object.entries(selfPassUses || {})) {
          const val = Math.max(0, Number(rawVal) || 0);
          const cap = availMap[Number(k)] ?? 0;
          const allowed = Math.min(val, cap, Math.max(0, pax - running));
          if (allowed > 0) {
            nextUses[k] = allowed;
            running += allowed;
          }
          if (allowed !== val) changed = true;
        }
        if (changed) {
          onChangeSelfPassUses(nextUses);
        }

        // Auto-select default transfer method if unset or unavailable
        const methods = data?.transfer_methods || [];
        const isMethodUsable = (m) =>
          m && !(m.code === 'ctbc_pool' && (m.pool_available ?? data?.ctbc_pool_available_count ?? 1) === 0);
        const curCode = selfTransferMethod?.code;
        const matched = methods.find((m) => m.code === curCode && isMethodUsable(m));
        if (!matched) {
          const first = methods.find(isMethodUsable);
          if (first) {
            let banks = [];
            try {
              banks = Array.isArray(first.bank_accounts_json)
                ? first.bank_accounts_json
                : JSON.parse(first.bank_accounts_json || '[]');
            } catch (e) {
              banks = [];
            }
            const firstBank = banks[0] ? `${banks[0].bank_name} (${banks[0].bank_code}) ${banks[0].account}` : null;
            onChangeSelfTransferMethod({ code: first.code, bank_info: firstBank });
          } else {
            onChangeSelfTransferMethod(null);
          }
        }
      })
      .catch((err) => {
        console.error('Failed to fetch prepay options', err);
        if (!cancelled) setPrepayOptions(null);
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isSelfService, date, pax]);

  // Fetch server prepay quote on self-service days
  useEffect(() => {
    if (!isSelfService || !bookingSessions.length) {
      setPrepayQuote(null);
      setQuoteError('');
      return;
    }
    let cancelled = false;
    const seq = ++quoteSeqRef.current;
    setQuoteLoading(true);
    setQuoteError('');

    const sessionIds = bookingSessions.map((s) => s.id || s.session_id).filter(Boolean);
    const payloadEquipments = units.map((u) => {
      const cfg = configsMap[u.equipment_id] || {};
      return {
        equipment_id: u.equipment_id,
        name: cfg.name || '',
        quantity: 1,
        rental_hours: u.to - u.from,
        start_time: hourStartTimes[u.from],
      };
    });

    api.post('/reservations/prepay-quote', {
      session_ids: sessionIds,
      pax,
      isUnlimited: mode === 'unlimited',
      equipments: payloadEquipments,
      promo_code: (!allUsingPass && promo?.code) ? promo.code : null,
      pass_uses: passUsesList,
    })
      .then((res) => {
        if (cancelled || seq !== quoteSeqRef.current) return;
        setPrepayQuote(res.data || null);
      })
      .catch((err) => {
        if (cancelled || seq !== quoteSeqRef.current) return;
        const msg = err.response?.data?.error || err.response?.data?.message || '試算金額失敗';
        setQuoteError(msg);
      })
      .finally(() => {
        if (!cancelled && seq === quoteSeqRef.current) {
          setQuoteLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isSelfService, bookingSessions, pax, mode, units, configsMap, hourStartTimes, promo, allUsingPass, passUsesList, quoteNonce]);

  // Validate Promo Code
  const handleApplyPromo = async () => {
    if (allUsingPass) {
      setPromoError('全部用卡時不能使用優惠碼');
      return;
    }
    const cleanCode = promoInput.trim().toUpperCase();
    if (!cleanCode) return;

    setPromoLoading(true);
    setPromoError('');

    try {
      const effectivePax = isSelfService ? Math.max(0, pax - totalPassPersons) : pax;
      const effectiveSeating = isSelfService
        ? (prepayQuote?.entry_amount ?? Math.round((priceCalculation.seat.total * effectivePax) / Math.max(1, pax)))
        : priceCalculation.seat.total;
      const effectiveEquip = isSelfService
        ? (prepayQuote?.board_amount ?? priceCalculation.equipmentTotal)
        : priceCalculation.equipmentTotal;
      const payload = {
        code: cleanCode,
        session_date: date,
        pax: effectivePax,
        hours: H,
        is_unlimited: mode === 'unlimited' || priceCalculation.seat.isCapped,
        base_amount: effectiveSeating + effectiveEquip,
        seating_amount: effectiveSeating,
        equipment_amount: effectiveEquip,
        hourly_price: dayPricing?.hourly,
      };

      const res = await api.post('/checkout/promo-codes/validate', payload);
      const promoData = res.data?.promo || res.data?.promo_code || res.data;
      const check = validateCouponPax(promoData, effectivePax);
      if (check.cancelled) {
        setPromoError(check.message);
        toast.show(check.message, { type: 'error' });
        return;
      }
      onChangePromo(promoData);
      setPromoInput('');
      toast.show('已套用折扣碼', { type: 'success' });
    } catch (err) {
      console.error('Promo code validation failed', err);
      const msg = err.response?.data?.message || err.response?.data?.error || '折扣碼無效或已過期';
      setPromoError(msg);
    } finally {
      setPromoLoading(false);
    }
  };

  const handleRemovePromo = () => {
    onChangePromo(null);
    setPromoError('');
  };

  // Note Quick Tags toggle
  const handleToggleTag = (tag) => {
    let current = (customerNote || '').trim();
    if (current.includes(tag)) {
      // Remove tag
      const regex = new RegExp(`(^|，|\\s*)${tag}(，|\\s*|$)`, 'g');
      current = current.replace(regex, '，').replace(/^，|，$/g, '').replace(/，{2,}/g, '，').trim();
    } else {
      // Add tag
      current = current ? `${current}，${tag}` : tag;
    }
    onChangeNote(current);
  };

  // Submit Reservation
  const executeBooking = async (forceSplit = false) => {
    setSubmitting(true);
    setBookingLimitError('');
    try {
      const sessionIds = bookingSessions.map((s) => s.id || s.session_id).filter(Boolean);
      const payloadEquipments = units.map((u) => {
        const cfg = configsMap[u.equipment_id] || {};
        return {
          equipment_id: u.equipment_id,
          name: cfg.name || '',
          quantity: 1,
          rental_hours: u.to - u.from,
          start_time: hourStartTimes[u.from],
        };
      });

      const body = {
        session_ids: sessionIds,
        pax,
        isUnlimited: mode === 'unlimited',
        equipments: payloadEquipments,
        promo_code: (!allUsingPass && promo?.code) ? promo.code : null,
        customer_note: customerNote.trim() || null,
        forceSplit,
        ...(isSelfService
          ? {
              self_service_ack: selfServiceAck,
              prepay: {
                pass_uses: passUsesList,
                transfer: (prepayQuote?.transfer_amount ?? 0) > 0 ? selfTransferMethod : null,
                expected_transfer_amount: prepayQuote?.transfer_amount ?? 0,
              },
            }
          : {}),
      };

      const res = await api.post('/reservations', body);
      onBookingSuccess(res.data);
    } catch (err) {
      console.error('Reservation submission failed', err);
      const status = err.response?.status;
      const data = err.response?.data;
      const errorMsg = data?.message || data?.error || '';

      if (status === 400 && (data?.code === 'SESSION_STARTED' || data?.code === 'SESSIONS_NOT_CONTIGUOUS')) {
        toast.show(errorMsg || '選的時段無法預約，請重新選擇', { type: 'error' });
        onGoBackToSelectTime();
      } else if ((status === 409 && data?.code === 'TOO_MANY_ACTIVE_BOOKINGS') || (status === 400 && data?.code === 'PAX_LIMIT')) {
        setBookingLimitError(errorMsg || '已超過線上預約上限，請用 LINE 聯繫我們');
      } else if (status === 429 || data?.code === 'RATE_LIMITED') {
        toast.show(errorMsg || '預約送出太頻繁，請 10 分鐘後再試', { type: 'error' });
      } else if (status === 409 && (data?.code === 'AMOUNT_CHANGED' || errorMsg.includes('金額'))) {
        setQuoteNonce((n) => n + 1);
        toast.show(errorMsg || '金額已更新，請確認最新金額後再送出', { type: 'info' });
      } else if (status === 409 && errorMsg.includes('拆散')) {
        setShowSplitSheet(true);
      } else if ((status === 409 || status === 400) && (errorMsg.includes('capacity') || errorMsg.includes('額滿') || errorMsg.includes('Not enough'))) {
        toast.show('剛剛有人訂走了部分時段，請重新選擇', { type: 'error' });
        onGoBackToSelectTime();
      } else if (status === 409) {
        toast.show(errorMsg || '智能板庫存不足', { type: 'error' });
      } else if (status === 401) {
        toast.show('登入已過期，請重新用 LINE 登入', { type: 'error' });
        setTimeout(() => {
          window.location.href = '/';
        }, 1500);
      } else if (status === 400 || status === 403) {
        toast.show(errorMsg || '無法完成預約', { type: 'error' });
      } else {
        toast.show('送出失敗，請稍後再試', { type: 'error' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Date and Time labels
  const dayTypeSuffix =
    dayPricing?.dayType === 'special'
      ? '（特別價）'
      : dayPricing?.dayType === 'weekend'
      ? '（假日）'
      : '（平日）';
  const dateLineText = `${formatDateShort(date)}${dayTypeSuffix}`;
  const timeLineText =
    mode === 'unlimited'
      ? `${startTime} 到 ${endTime}，當日不限時暢玩`
      : `${startTime} 到 ${endTime}，${H} 小時`;

  // Bottom action bar summary
  const savingAmount = priceCalculation.saving;
  const selfTransferOpen = isSelfService
    ? Boolean(prepayQuote?.transfer_open ?? prepayOptions?.transfer_open ?? true)
    : true;
  const needsTransferOnSelfDay = isSelfService && (prepayQuote?.transfer_amount ?? 0) > 0;
  const deadlineHourStr = `${String(daily?.self_service?.prepay_deadline_hour ?? 12).padStart(2, '0')}:00`;
  const selfIronText =
    daily?.self_service?.iron_text ||
    buildIronText({ iron_mode: daily?.iron_mode, iron_date: daily?.iron_date, date });
  const selfEarliestTime = earliestEntry(startTime, daily?.self_service?.early_minutes ?? 30);

  const summaryNode = isSelfService ? (
    <div className="flex items-center gap-1">
      <span>{prepayQuote?.transfer_amount === 0 ? '計次卡全額折抵' : '需先匯款'}</span>
    </div>
  ) : (
    <div className="flex items-center gap-1">
      <span>現場付款</span>
      {savingAmount > 0 && (
        <span className="font-bold text-sg-sage-ink ml-1">
          · 共省 <span className="font-num">{formatMoney(savingAmount)}</span>
        </span>
      )}
    </div>
  );

  return (
    <>
      {/* 1. Step Indicator */}
      <StepIndicator currentStep="確認" />

      {globalError && !hasPricing ? (
        <EmptyState
          title="暫時抓不到價格"
          description="請檢查網路後重新整理"
          action={<Button size="sm" onClick={onReloadPricing}>重新整理</Button>}
        />
      ) : (
        <>
          {globalError && (
            <ErrorBanner
              message="最新價格更新失敗，請檢查網路後重新整理"
              action={<Button size="sm" onClick={onReloadPricing}>重新整理</Button>}
            />
          )}

          {/* 2. Detail Card */}
          <Card gap={8}>
            <KV label="日期" value={<b>{dateLineText}</b>} />
            <KV label="時段" value={<b className="font-num">{timeLineText}</b>} />
            <KV label="人數" value={<b>{pax} 位</b>} />
            {isSelfService && (
              <>
                <KV label="最早進場" value={<b className="font-num">{selfEarliestTime}</b>} />
                <KV label="熨燙" value={<span className="font-medium text-right">{selfIronText}</span>} />
              </>
            )}

            {!isSelfService && (
              <>
                <Divider className="my-1" />

                {(!hasPricing || !dayPricing) ? (
                  <div className="grid gap-2 py-2">
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ) : (
                  <PriceLines lines={priceCalculation.lines} />
                )}
              </>
            )}

        <Divider className="my-1" />

        {/* Promo code inline input / status */}
        {allUsingPass ? (
          <div className="text-[13px] text-sg-muted py-1">
            全部用卡時不能使用優惠碼
          </div>
        ) : promo ? (
          <div className="grid gap-1">
            <div className="flex items-center justify-between py-1">
              <span className="text-[13px] font-bold text-sg-sage-ink">
                已套用 {promo.code}
              </span>
              <Button
                variant="text"
                size="sm"
                onClick={handleRemovePromo}
                className="text-[13px] text-sg-muted hover:text-sg-ink"
              >
                移除
              </Button>
            </div>
            {isSelfService && totalPassPersons > 0 && totalPassPersons < pax && (
              <div className="text-[12px] text-sg-muted">
                優惠碼只折抵沒有用卡的 {pax - totalPassPersons} 位
              </div>
            )}
          </div>
        ) : (
          <div className="grid gap-1">
            <div className="flex gap-[6px]">
              <input
                type="text"
                value={promoInput}
                onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                placeholder="輸入折扣碼"
                maxLength={30}
                className="flex-1 min-w-0 rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-3 py-[9px] text-[16px] text-sg-ink uppercase placeholder:text-sg-full focus:border-sg-brown focus:outline-none"
              />
              <Button
                variant="secondary"
                size="sm"
                loading={promoLoading}
                disabled={!promoInput.trim() || promoLoading}
                onClick={handleApplyPromo}
                className="min-h-[44px] px-4"
              >
                套用
              </Button>
            </div>
            {isSelfService && totalPassPersons > 0 && totalPassPersons < pax && (
              <div className="text-[12px] text-sg-muted px-1">
                優惠碼只折抵沒有用卡的 {pax - totalPassPersons} 位
              </div>
            )}
            {promoError && (
              <div className="text-[12px] text-sg-danger px-1">
                {promoError}
              </div>
            )}
          </div>
        )}
      </Card>

      {isSelfService && (
        <Card gap={10} data-testid="self-payment-card">
          <div className="text-[15px] font-bold text-sg-ink">付款方式</div>

          {/* Punch cards */}
          <div className="grid gap-2 rounded-[12px] bg-sg-bg/70 border border-sg-line p-3">
            <div className="flex items-center justify-between">
              <div className="text-[13.5px] font-bold text-sg-ink">計次不限時卡</div>
              {totalPassPersons > 0 && (
                <span className="text-[12px] font-bold text-sg-sage-ink">
                  這次用卡 {totalPassPersons} 位
                </span>
              )}
            </div>
            {optionsLoading && !prepayOptions ? (
              <Skeleton className="h-10 w-full" />
            ) : !prepayOptions?.passes?.length ? (
              <div className="text-[13px] text-sg-muted">你目前沒有計次不限時卡</div>
            ) : (
              <div className="grid gap-2.5">
                {prepayOptions.passes.map((pass) => {
                  const cur = Number(selfPassUses?.[pass.user_pass_id] || 0);
                  const remainingGlobal = Math.max(0, pax - totalPassPersons);
                  const maxForPass = Math.min(pass.usable_units ?? pass.remaining_uses ?? 0, cur + remainingGlobal);
                  return (
                    <div
                      key={pass.user_pass_id}
                      data-testid={`self-pass-row-${pass.user_pass_id}`}
                      className="flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="text-[13.5px] font-bold text-sg-ink truncate">
                          {pass.name || '計次不限時卡'}
                        </div>
                        <div className="text-[12px] text-sg-muted">
                          剩 <span className="font-num font-bold">{pass.remaining_uses}</span> 次
                        </div>
                      </div>
                      <Stepper
                        value={cur}
                        min={0}
                        max={maxForPass}
                        label={`${pass.name || '計次不限時卡'} 使用次數`}
                        onMinus={() =>
                          onChangeSelfPassUses((prev) => ({
                            ...(prev || {}),
                            [pass.user_pass_id]: Math.max(0, cur - 1),
                          }))
                        }
                        onPlus={() =>
                          onChangeSelfPassUses((prev) => ({
                            ...(prev || {}),
                            [pass.user_pass_id]: Math.min(maxForPass, cur + 1),
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Server quote breakdown */}
          {quoteLoading && !prepayQuote ? (
            <div className="grid gap-2 py-1">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : quoteError ? (
            <div className="text-[13px] text-sg-danger bg-sg-danger-soft rounded-[10px] px-3 py-2">
              {quoteError}
            </div>
          ) : prepayQuote ? (
            <div className="grid gap-1.5 text-[14px]" data-testid="self-quote-breakdown">
              {prepayQuote.pass_persons > 0 && (
                <div className="flex justify-between items-center text-sg-ink">
                  <span>入場費 用卡 {prepayQuote.pass_persons} 位</span>
                  <span className="font-num font-bold text-sg-sage-ink">已用卡折抵</span>
                </div>
              )}
              {prepayQuote.unpaid_entry_persons > 0 && (
                <div className="flex justify-between items-center text-sg-ink">
                  <span>入場費 匯款 {prepayQuote.unpaid_entry_persons} 位</span>
                  <span className="font-num font-bold">{formatMoney(prepayQuote.entry_amount)}</span>
                </div>
              )}
              {prepayQuote.board_amount > 0 && (
                <div className="flex justify-between items-center text-sg-ink">
                  <span>智能板</span>
                  <span className="font-num font-bold">{formatMoney(prepayQuote.board_amount)}</span>
                </div>
              )}
              {prepayQuote.promo?.discount > 0 && (
                <div className="flex justify-between items-center text-sg-sage-ink">
                  <span>優惠碼 {prepayQuote.promo.code}</span>
                  <span className="font-num font-bold">−{formatMoney(prepayQuote.promo.discount)}</span>
                </div>
              )}
              <Divider className="my-0.5" />
              <div className="flex justify-between items-center text-[15px] font-bold text-sg-ink">
                <span>需要匯款</span>
                <span className="font-num text-[17px] text-sg-brown" data-testid="self-quote-transfer-amount">
                  {formatMoney(prepayQuote.transfer_amount)}
                </span>
              </div>
            </div>
          ) : null}

          {/* Transfer selection or 0-transfer notice */}
          {prepayQuote && !quoteError && (
            prepayQuote.transfer_amount === 0 ? (
              <div
                data-testid="self-no-transfer-notice"
                className="rounded-[12px] bg-sg-sage-soft border border-sg-sage/40 px-3 py-2.5 text-[13px] font-bold text-sg-sage-ink"
              >
                不需要匯款，送出後預約直接成立
              </div>
            ) : !selfTransferOpen ? (
              <div
                data-testid="self-deadline-passed-notice"
                className="rounded-[12px] bg-sg-danger-soft border border-sg-danger/40 px-3 py-2.5 text-[13px] font-bold text-sg-danger"
              >
                已超過付款期限（前一日 {deadlineHourStr}），需要匯款的預約無法線上成立。全部用計次不限時卡而且不租智能板，仍然可以預約。
              </div>
            ) : (
              <div className="grid gap-2">
                <div className="text-[13px] font-bold text-sg-ink">選擇匯款帳號</div>
                {(prepayOptions?.transfer_methods || []).map((m) => {
                  const isPool = m.code === 'ctbc_pool';
                  const poolAvail = m.pool_available ?? prepayOptions?.ctbc_pool_available_count ?? 1;
                  const isPoolExhausted = isPool && poolAvail === 0;
                  const isSelected = selfTransferMethod?.code === m.code;
                  let bankAccounts = [];
                  try {
                    bankAccounts = Array.isArray(m.bank_accounts_json)
                      ? m.bank_accounts_json
                      : JSON.parse(m.bank_accounts_json || '[]');
                  } catch (e) {
                    bankAccounts = [];
                  }
                  const hasMultipleBanks = bankAccounts.length > 1;
                  return (
                    <div key={m.code} className="grid gap-1.5">
                      <label
                        className={`flex items-center gap-[10px] rounded-[12px] border-[1.5px] bg-sg-paper px-3 py-2 cursor-pointer transition select-none ${
                          isSelected ? 'border-sg-brown bg-sg-selected' : 'border-sg-line'
                        } ${isPoolExhausted ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <input
                          type="radio"
                          name="self_transfer_method"
                          value={m.code}
                          disabled={isPoolExhausted}
                          checked={isSelected}
                          onChange={() => {
                            const firstBank = bankAccounts[0]
                              ? `${bankAccounts[0].bank_name} (${bankAccounts[0].bank_code}) ${bankAccounts[0].account}`
                              : null;
                            onChangeSelfTransferMethod({ code: m.code, bank_info: firstBank });
                          }}
                          className="sr-only"
                        />
                        <div
                          className={`w-[18px] h-[18px] rounded-full border-2 transition grid place-items-center shrink-0 ${
                            isSelected ? 'border-[5px] border-sg-brown bg-white' : 'border-sg-line'
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
                        <div className="pl-6 pr-1 grid gap-1.5">
                          <div className="text-[12px] font-bold text-sg-muted">請選擇匯款銀行：</div>
                          {bankAccounts.map((b, bIdx) => {
                            const bankStr = `${b.bank_name} (${b.bank_code}) ${b.account}`;
                            const isBankSelected = selfTransferMethod?.bank_info === bankStr;
                            return (
                              <label
                                key={bIdx}
                                className={`flex items-center gap-2 px-3 py-2 rounded-[10px] border text-[13px] cursor-pointer transition ${
                                  isBankSelected
                                    ? 'border-sg-brown bg-sg-paper font-bold text-sg-ink shadow-sm'
                                    : 'border-sg-line bg-sg-bg text-sg-muted'
                                }`}
                              >
                                <input
                                  type="radio"
                                  name="self_transfer_bank"
                                  value={bankStr}
                                  checked={isBankSelected}
                                  onChange={() =>
                                    onChangeSelfTransferMethod({ code: m.code, bank_info: bankStr })
                                  }
                                  className="sr-only"
                                />
                                <div
                                  className={`w-3.5 h-3.5 rounded-full border transition grid place-items-center shrink-0 ${
                                    isBankSelected ? 'border-[4px] border-sg-brown bg-white' : 'border-sg-line'
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
                <div className="text-[12px] text-sg-muted px-0.5">
                  送出後顯示帳號，前一日 {deadlineHourStr} 前匯款並回報末五碼
                </div>
              </div>
            )
          )}
        </Card>
      )}

      {/* 3. Note Card */}
      <Card gap={8}>
        <div className="text-[14px] font-bold">備註（選填）</div>

        {/* Quick tags */}
        <div className="flex flex-wrap gap-[6px]">
          {noteChips.map((tag) => {
            const isTagActive = (customerNote || '').includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => handleToggleTag(tag)}
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

        {/* Note textarea */}
        <textarea
          rows={2}
          value={customerNote}
          onChange={(e) => onChangeNote(e.target.value)}
          placeholder="也可以直接打字寫其他需求"
          maxLength={120}
          className="w-full rounded-[10px] border-[1.5px] border-sg-line bg-sg-paper px-[10px] py-2 text-[16px] text-sg-ink placeholder:text-sg-full focus:border-sg-brown focus:ring-[3px] focus:ring-sg-brown-soft focus:outline-none resize-none"
        />
      </Card>

      {isSelfService && (
        <label className="flex items-start gap-2.5 rounded-[14px] border border-sg-line bg-sg-paper px-3.5 py-3 cursor-pointer select-none">
          <input
            type="checkbox"
            data-testid="self-ack-checkbox"
            checked={selfServiceAck}
            onChange={(e) => onChangeSelfServiceAck(e.target.checked)}
            className="mt-0.5 h-[18px] w-[18px] accent-sg-brown shrink-0"
          />
          <span className="text-[13.5px] font-bold text-sg-ink leading-[1.45]">
            我已經會玩拼豆，了解當天部分時段沒有店員教學
          </span>
        </label>
      )}

      {/* 4. Small notice text */}
      <div className="sg-small px-1">
        {isSelfService
          ? `前一日 ${deadlineHourStr} 前未完成匯款，預約將自動取消。`
          : '座位保留 15 分鐘，遲到請先傳 LINE 告訴我們；費用在現場報到後付款。'}
      </div>
        </>
      )}

      {/* 5. Bottom bar */}
      {bookingLimitError && (
        <div
          data-testid="booking-limit-error-box"
          className="rounded-[14px] border border-sg-danger/40 bg-sg-danger-soft/70 px-3.5 py-3 grid gap-2"
        >
          <div className="text-[13.5px] font-bold text-sg-danger leading-snug">
            {bookingLimitError}
          </div>
          <StoreContactCard globalSettings={globalSettings} showPhone={false} showLine={true} />
        </div>
      )}
      <div className="sticky bottom-0 z-40 -mx-4 -mb-5 mt-auto">
        <BottomActionBar
          summary={summaryNode}
          price={
            isSelfService
              ? (prepayQuote ? prepayQuote.transfer_amount : null)
              : (hasPricing && dayPricing ? priceCalculation.total : null)
          }
          actionLabel="送出預約"
          loading={submitting}
          disabled={
            submitting ||
            !hasPricing ||
            !dayPricing ||
            globalLoading ||
            Boolean(globalError) ||
            (isSelfService &&
              (!selfServiceAck ||
                quoteLoading ||
                !prepayQuote ||
                Boolean(quoteError) ||
                (needsTransferOnSelfDay && (!selfTransferOpen || !selfTransferMethod?.code))))
          }
          onAction={() => executeBooking(false)}
          hasTabBarBelow={false}
        />
      </div>

      {/* Split Seat Sheet */}
      <SplitSeatSheet
        isOpen={showSplitSheet}
        onClose={() => setShowSplitSheet(false)}
        loading={submitting}
        onConfirmForceSplit={() => {
          setShowSplitSheet(false);
          executeBooking(true);
        }}
        onBackToSelectTime={() => {
          setShowSplitSheet(false);
          onGoBackToSelectTime();
        }}
      />
    </>
  );
}

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
import SplitSeatSheet from '../../../components/customer/sheets/SplitSeatSheet';
import { BeadLoader } from '../../../components/customer/Bead';
import { useToast } from '../../../components/customer/Toast';
import api from '../../../api/axios';
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
  const [showSplitSheet, setShowSplitSheet] = useState(false);

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

  // Validate Promo Code
  const handleApplyPromo = async () => {
    const cleanCode = promoInput.trim().toUpperCase();
    if (!cleanCode) return;

    setPromoLoading(true);
    setPromoError('');

    try {
      const payload = {
        code: cleanCode,
        session_date: date,
        pax,
        hours: H,
        is_unlimited: mode === 'unlimited' || priceCalculation.seat.isCapped,
        base_amount: priceCalculation.seat.raw,
        seating_amount: priceCalculation.seat.total,
        equipment_amount: priceCalculation.equipmentTotal,
        hourly_price: dayPricing?.hourly,
      };

      const res = await api.post('/checkout/promo-codes/validate', payload);
      const promoData = res.data?.promo_code || res.data;
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
        promo_code: promo?.code || null,
        customer_note: customerNote.trim() || null,
        forceSplit,
      };

      const res = await api.post('/reservations', body);
      onBookingSuccess(res.data);
    } catch (err) {
      console.error('Reservation submission failed', err);
      const status = err.response?.status;
      const data = err.response?.data;
      const errorMsg = data?.message || data?.error || '';

      if (status === 409 && errorMsg.includes('拆散')) {
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
  const summaryNode = (
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

        <Divider className="my-1" />

        {/* Promo code inline input / status */}
        {promo ? (
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
            {promoError && (
              <div className="text-[12px] text-sg-danger px-1">
                {promoError}
              </div>
            )}
          </div>
        )}
      </Card>

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

      {/* 4. Small notice text */}
      <div className="sg-small px-1">
        座位保留 15 分鐘，遲到請先傳 LINE 告訴我們；費用在現場報到後付款。
      </div>
        </>
      )}

      {/* 5. Bottom bar */}
      <div className="sticky bottom-0 z-40 -mx-4 -mb-5 mt-auto">
        <BottomActionBar
          summary={summaryNode}
          price={hasPricing && dayPricing ? priceCalculation.total : null}
          actionLabel="送出預約"
          loading={submitting}
          disabled={submitting || !hasPricing || !dayPricing || globalLoading || Boolean(globalError)}
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

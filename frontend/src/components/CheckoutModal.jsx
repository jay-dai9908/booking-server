import React, { useState, useEffect, useMemo } from 'react';
import api from '../api/axios';
import {
  buildFullReceiptCommands,
  buildPersonSplitReceiptCommands,
  sendCommandsToSunmiPrinter,
  isSunmiPosAvailable,
  PAYMENT_METHOD_LABELS
} from '../utils/sunmiPrinter';

export default function CheckoutModal({
  isOpen,
  onClose,
  reservation,
  onCheckoutSuccess
}) {
  const [promoCodes, setPromoCodes] = useState([]);
  const [addonPresets, setAddonPresets] = useState([]);
  const [people, setPeople] = useState([]);
  const [orderAddons, setOrderAddons] = useState([]);
  const [appliedPromos, setAppliedPromos] = useState([]);
  const [manualDiscount, setManualDiscount] = useState(0);
  const [discountSplitMode, setDiscountSplitMode] = useState('even'); // 'even' | 'person_0'
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [checkoutNote, setCheckoutNote] = useState('');
  const [promoInput, setPromoInput] = useState('');
  const [promoError, setPromoError] = useState('');

  // Target selector when clicking addon quick buttons: 'order' or person index '0', '1', ...
  const [addonTarget, setAddonTarget] = useState('order');
  const [customAddonName, setCustomAddonName] = useState('');
  const [customAddonPrice, setCustomAddonPrice] = useState('');

  // Sub-modals: 'none' | 'promo_manager' | 'addon_manager' | 'receipt_preview'
  const [subModal, setSubModal] = useState('none');
  const [previewCommands, setPreviewCommands] = useState([]);
  const [previewTitle, setPreviewTitle] = useState('');
  const [showRawJson, setShowRawJson] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);

  // New Promo Form State
  const [newPromo, setNewPromo] = useState({
    code: '',
    name: '',
    description: '',
    discount_type: 'fixed_order',
    discount_value: 30,
    min_pax: 1,
    min_hours: 0,
    min_amount: 0,
    applicable_days: 'all',
    applicable_mode: 'all',
    max_uses: '',
    max_uses_per_user: '',
    valid_until: '',
    is_pos_quick_select: true
  });

  // New Addon Form State
  const [newAddon, setNewAddon] = useState({
    name: '',
    price: 30,
    category: 'charm'
  });

  const showToast = (msg, type = 'success') => {
    setToastMsg({ msg, type });
    setTimeout(() => setToastMsg(null), 3200);
  };

  // Pricing info from backend or fallback
  const pricingInfo = useMemo(() => {
    if (reservation?.pricing_info) {
      return reservation.pricing_info;
    }
    const d = reservation?.session_date ? new Date(reservation.session_date) : new Date();
    const day = isNaN(d.getTime()) ? 0 : d.getUTCDay();
    const isWeekend = day === 0 || day === 6;
    return {
      hourly_price: isWeekend ? 180 : 150,
      unlimited_price: isWeekend ? 1100 : 750,
      allow_unlimited: true,
      is_weekend: isWeekend
    };
  }, [reservation]);

  // Fetch promo codes and addon presets when modal opens
  const fetchConfigs = async () => {
    try {
      const [promoRes, addonRes] = await Promise.all([
        api.get('/checkout/promo-codes'),
        api.get('/checkout/addons')
      ]);
      setPromoCodes(promoRes.data || []);
      setAddonPresets(addonRes.data || []);
    } catch (err) {
      console.error('Failed to fetch checkout configs:', err);
    }
  };

  useEffect(() => {
    if (!isOpen || !reservation) return;
    fetchConfigs();

    const saved = reservation.checkout_details;
    if (saved && Array.isArray(saved.people) && saved.people.length > 0) {
      setPeople(saved.people);
      setOrderAddons(saved.order_addons || []);
      setAppliedPromos(saved.applied_promos || []);
      setManualDiscount(saved.manual_discount || 0);
      setDiscountSplitMode(saved.discount_split_mode || 'even');
      setPaymentMethod(reservation.payment_method || saved.payment_method || 'cash');
      setCheckoutNote(saved.note || '');
    } else {
      // Initialize per-person cards from reservation data
      const paxCount = Math.max(1, parseInt(reservation.pax, 10) || 1);
      const baseHours = Math.max(1, parseInt(reservation.session_count, 10) || 1);
      const isUnlimitedDefault = Boolean(reservation.is_unlimited);
      const seats = Array.isArray(reservation.assigned_seats) ? reservation.assigned_seats : [];

      // Distribute booked equipment fees across people (default to Person 1 or distribute per unit)
      const equipments = Array.isArray(reservation.equipments) ? reservation.equipments : [];
      const totalEqQty = equipments.reduce((s, e) => s + (e.quantity || 0), 0);
      const totalEqFee = equipments.reduce((s, e) => s + (e.subtotal_price || 0), 0);
      const unitEqFee = totalEqQty > 0 ? Math.round(totalEqFee / totalEqQty) : 0;

      let remainingEqUnits = totalEqQty;
      const initialPeople = [];
      for (let i = 0; i < paxCount; i++) {
        const seatLabel = seats[i] ? ` (${seats[i]})` : '';
        let personEqFee = 0;
        let personEqQty = 0;
        if (remainingEqUnits > 0) {
          if (i === paxCount - 1) {
            personEqQty = remainingEqUnits;
            personEqFee = totalEqFee - unitEqFee * (totalEqQty - remainingEqUnits);
            remainingEqUnits = 0;
          } else {
            personEqQty = 1;
            personEqFee = unitEqFee;
            remainingEqUnits -= 1;
          }
        }

        initialPeople.push({
          id: `p_${i + 1}`,
          label: `第 ${i + 1} 位${seatLabel}`,
          base_hours: baseHours,
          extra_half_hours: 0, // Number of +0.5hr blocks
          is_unlimited: isUnlimitedDefault,
          equipment_qty: personEqQty,
          equipment_fee: personEqFee,
          addons: []
        });
      }

      setPeople(initialPeople);
      setOrderAddons([]);

      if (reservation.promo_code && reservation.discount_amount > 0) {
        setAppliedPromos([
          {
            code: reservation.promo_code,
            name: reservation.promo_code,
            discount_type: 'fixed_order',
            discount_value: reservation.discount_amount
          }
        ]);
      } else {
        setAppliedPromos([]);
      }
      setManualDiscount(0);
      setDiscountSplitMode('even');
      setPaymentMethod(reservation.payment_method || 'cash');
      setCheckoutNote('');
    }
    setAddonTarget('order');
    setSubModal('none');
  }, [isOpen, reservation]);

  // Calculate all per-person and grand totals dynamically
  const computed = useMemo(() => {
    const hourlyRate = pricingInfo.hourly_price || 150;
    const unlimitedRate = pricingInfo.unlimited_price || 750;
    const allowUnlimited = pricingInfo.allow_unlimited !== false;

    // 1. Compute raw seating, equipment, and personal addons for each person
    const rawPeople = people.map((p, idx) => {
      const baseH = Math.max(0.5, Number(p.base_hours) || 1);
      const extraHalfBlocks = Math.max(0, parseInt(p.extra_half_hours, 10) || 0);
      const totalHours = baseH + extraHalfBlocks * 0.5;

      const rawHourlyCost = Math.round(totalHours * hourlyRate);
      const isAutoCapped = allowUnlimited && rawHourlyCost >= unlimitedRate;
      const effectiveUnlimited = Boolean(p.is_unlimited) || isAutoCapped;

      const seatingFee = effectiveUnlimited && allowUnlimited
        ? unlimitedRate
        : rawHourlyCost;

      const eqFee = Math.max(0, parseInt(p.equipment_fee, 10) || 0);
      const personalAddonsFee = (p.addons || []).reduce(
        (sum, a) => sum + (parseInt(a.price, 10) || 0) * (parseInt(a.qty, 10) || 1),
        0
      );

      return {
        ...p,
        index: idx,
        total_hours: totalHours,
        raw_hourly_cost: rawHourlyCost,
        is_auto_capped: isAutoCapped,
        effective_unlimited: effectiveUnlimited,
        seating_fee: seatingFee,
        equipment_fee: eqFee,
        addons_fee: personalAddonsFee,
        subtotal_before_discount: seatingFee + eqFee + personalAddonsFee
      };
    });

    const subtotalSeating = rawPeople.reduce((s, p) => s + p.seating_fee, 0);
    const subtotalEquipment = rawPeople.reduce((s, p) => s + p.equipment_fee, 0);
    const subtotalPersonalAddons = rawPeople.reduce((s, p) => s + p.addons_fee, 0);
    const subtotalOrderAddons = orderAddons.reduce(
      (s, a) => s + (parseInt(a.price, 10) || 0) * (parseInt(a.qty, 10) || 1),
      0
    );
    const subtotalAddons = subtotalPersonalAddons + subtotalOrderAddons;
    const baseForDiscount = subtotalSeating + subtotalEquipment;

    // 2. Calculate promo discounts
    const paxCount = Math.max(1, rawPeople.length);
    let promoDiscountTotal = 0;
    const evaluatedPromos = appliedPromos.map(promo => {
      const scope = promo.target_scope || 'all';
      let targetBase = baseForDiscount;
      if (scope === 'seating') {
        targetBase = subtotalSeating;
      } else if (scope === 'equipment') {
        targetBase = subtotalEquipment;
      }

      let amt = 0;
      if (promo.discount_type === 'fixed_order') {
        amt = promo.discount_value;
      } else if (promo.discount_type === 'fixed_per_pax') {
        amt = promo.discount_value * paxCount;
      } else if (promo.discount_type === 'percentage') {
        const val = promo.discount_value;
        const pctOff = val > 50 && val < 100 ? 100 - val : val;
        amt = Math.round(targetBase * (pctOff / 100));
      } else if (promo.discount_type === 'free_hours') {
        amt = Math.round(hourlyRate * promo.discount_value);
      } else {
        amt = promo.discount_value || 0;
      }

      if (promo.max_discount_amount && promo.max_discount_amount > 0) {
        amt = Math.min(amt, promo.max_discount_amount);
      }

      if (targetBase > 0) {
        amt = Math.min(amt, targetBase);
      }

      promoDiscountTotal += amt;
      return { ...promo, calculated_discount: amt };
    });

    const totalDiscount = Math.min(
       subtotalSeating + subtotalEquipment + subtotalAddons,
      promoDiscountTotal + (parseInt(manualDiscount, 10) || 0)
    );

    // 3. Distribute orderAddons and totalDiscount across people so each person has an exact split total
    const orderAddonPerPerson = paxCount > 0 ? Math.floor(subtotalOrderAddons / paxCount) : 0;
    const orderAddonRemainder = subtotalOrderAddons - orderAddonPerPerson * paxCount;

    let remainingDiscount = totalDiscount;
    const finalPeople = rawPeople.map((p, idx) => {
      const sharedAddonShare = idx === 0 ? orderAddonPerPerson + orderAddonRemainder : orderAddonPerPerson;
      let personDiscount = 0;
      if (totalDiscount > 0) {
        if (discountSplitMode === 'person_0') {
          personDiscount = idx === 0 ? totalDiscount : 0;
        } else {
          // Even split across pax
          if (idx === paxCount - 1) {
            personDiscount = remainingDiscount;
          } else {
            personDiscount = Math.floor(totalDiscount / paxCount);
            remainingDiscount -= personDiscount;
          }
        }
      }

      const personTotal = Math.max(0, p.subtotal_before_discount + sharedAddonShare - personDiscount);
      return {
        ...p,
        shared_addon_share: sharedAddonShare,
        discount_fee: personDiscount,
        person_total: personTotal
      };
    });

    const grandTotal = Math.max(
      0,
      subtotalSeating + subtotalEquipment + subtotalAddons - totalDiscount
    );

    // Dual-track stats calculation for Member Profile
    let unlimitedPaxCount = 0;
    let regularHoursSum = 0;
    finalPeople.forEach(p => {
      if (p.effective_unlimited) {
        unlimitedPaxCount += 1;
      } else {
        regularHoursSum += p.total_hours;
      }
    });

    return {
      people: finalPeople,
      subtotalSeating,
      subtotalEquipment,
      subtotalOrderAddons,
      subtotalAddons,
      evaluatedPromos,
      totalDiscount,
      grandTotal,
      unlimitedPaxCount,
      regularHoursSum: Math.round(regularHoursSum * 10) / 10
    };
  }, [people, orderAddons, appliedPromos, manualDiscount, discountSplitMode, pricingInfo]);

  if (!isOpen || !reservation) return null;

  // Handlers for updating individual person cards
  const updatePerson = (idx, patch) => {
    setPeople(prev => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const addPersonCard = () => {
    const nextIdx = people.length + 1;
    setPeople(prev => [
      ...prev,
      {
        id: `p_${Date.now()}`,
        label: `第 ${nextIdx} 位 (現場加人)`,
        base_hours: Math.max(1, parseInt(reservation.session_count, 10) || 1),
        extra_half_hours: 0,
        is_unlimited: false,
        equipment_qty: 0,
        equipment_fee: 0,
        addons: []
      }
    ]);
  };

  const removePersonCard = (idx) => {
    if (people.length <= 1) return;
    setPeople(prev => prev.filter((_, i) => i !== idx));
    if (addonTarget === String(idx)) setAddonTarget('order');
  };

  // Addon item handlers
  const handleSelectAddon = (addonItem) => {
    const itemObj = {
      id: addonItem.id || `custom_${Date.now()}`,
      name: addonItem.name,
      price: parseInt(addonItem.price, 10) || 0,
      qty: 1
    };

    if (addonTarget === 'order') {
      setOrderAddons(prev => {
        const existingIdx = prev.findIndex(a => a.name === itemObj.name && a.price === itemObj.price);
        if (existingIdx >= 0) {
          return prev.map((a, i) => (i === existingIdx ? { ...a, qty: (a.qty || 1) + 1 } : a));
        }
        return [...prev, itemObj];
      });
      showToast(`已加入「${itemObj.name} ($${itemObj.price})」至整單加購`);
    } else {
      const pIdx = parseInt(addonTarget, 10);
      if (!isNaN(pIdx) && people[pIdx]) {
        setPeople(prev =>
          prev.map((p, i) => {
            if (i !== pIdx) return p;
            const curAddons = p.addons || [];
            const exIdx = curAddons.findIndex(a => a.name === itemObj.name && a.price === itemObj.price);
            const nextAddons =
              exIdx >= 0
                ? curAddons.map((a, j) => (j === exIdx ? { ...a, qty: (a.qty || 1) + 1 } : a))
                : [...curAddons, itemObj];
            return { ...p, addons: nextAddons };
          })
        );
        showToast(`已加入「${itemObj.name} ($${itemObj.price})」至 ${people[pIdx].label}`);
      }
    }
  };

  const handleAddCustomAddon = () => {
    const price = parseInt(customAddonPrice, 10);
    if (!customAddonName.trim() || isNaN(price) || price < 0) {
      showToast('請輸入有效的加購品項名稱與金額', 'error');
      return;
    }
    handleSelectAddon({ name: customAddonName.trim(), price });
    setCustomAddonName('');
    setCustomAddonPrice('');
  };

  const removeOrderAddon = (idx) => {
    setOrderAddons(prev => prev.filter((_, i) => i !== idx));
  };

  const removePersonAddon = (pIdx, aIdx) => {
    setPeople(prev =>
      prev.map((p, i) => {
        if (i !== pIdx) return p;
        return { ...p, addons: (p.addons || []).filter((_, j) => j !== aIdx) };
      })
    );
  };

  // Promo quick toggle
  const toggleQuickPromo = (promo) => {
    setAppliedPromos(prev => {
      const exists = prev.some(p => p.code === promo.code);
      if (exists) {
        return prev.filter(p => p.code !== promo.code);
      }
      return [
        ...prev,
        {
          id: promo.id,
          code: promo.code,
          name: promo.name,
          discount_type: promo.discount_type,
          discount_value: promo.discount_value,
          target_scope: promo.target_scope || 'all',
          max_discount_amount: promo.max_discount_amount || null
        }
      ];
    });
  };

  const handleApplyPromoInput = async () => {
    setPromoError('');
    const code = promoInput.trim().toUpperCase();
    if (!code) return;

    if (appliedPromos.some(p => p.code === code)) {
      setPromoError('此優惠碼已套用');
      return;
    }

    try {
      const res = await api.post('/checkout/promo-codes/validate', {
        code,
        session_date: reservation.session_date,
        pax: computed.people.length,
        hours: Math.max(...computed.people.map(p => p.total_hours), 1),
        is_unlimited: computed.unlimitedPaxCount > 0,
        base_amount: computed.subtotalSeating + computed.subtotalEquipment,
        seating_amount: computed.subtotalSeating,
        equipment_amount: computed.subtotalEquipment,
        hourly_price: pricingInfo.hourly_price,
        user_id: reservation.user_id
      });
      if (res.data?.valid && res.data.promo) {
        setAppliedPromos(prev => [...prev, res.data.promo]);
        setPromoInput('');
        showToast(`已套用優惠碼：${res.data.promo.name}`);
      }
    } catch (err) {
      setPromoError(err.response?.data?.error || '折扣碼無效或不符合條件');
    }
  };

  // Build receipt data object for Sunmi V2s
  const getReceiptPayload = () => {
    const dateStr = reservation.session_date
      ? new Date(reservation.session_date).toISOString().split('T')[0]
      : '';
    return {
      bookingRef: reservation.booking_ref,
      customerName: reservation.user?.name || '現場貴賓',
      customerPhone: reservation.user?.phone || '',
      sessionDate: dateStr,
      timeRange: `${reservation.start_time || ''}-${reservation.end_time || ''}`,
      seats: reservation.assigned_seats || [],
      people: computed.people,
      orderAddons,
      appliedPromos: computed.evaluatedPromos,
      subtotalSeating: computed.subtotalSeating,
      subtotalEquipment: computed.subtotalEquipment,
      subtotalAddons: computed.subtotalAddons,
      discountAmount: computed.totalDiscount,
      totalAmount: computed.grandTotal,
      paymentMethod,
      note: checkoutNote
    };
  };

  // Print Full Receipt (Sunmi V2s or Preview)
  const handlePrintFullReceipt = async () => {
    const payload = getReceiptPayload();
    const commands = buildFullReceiptCommands(payload);
    const res = await sendCommandsToSunmiPrinter(commands);
    if (res.printedOnDevice) {
      showToast(res.message, res.success ? 'success' : 'error');
    } else {
      setPreviewTitle('商米 V2s 整單結帳明細預覽 (58mm)');
      setPreviewCommands(commands);
      setSubModal('receipt_preview');
    }
  };

  // Print Single Person Split Receipt (Sunmi V2s or Preview)
  const handlePrintPersonReceipt = async (person, idx) => {
    const payload = getReceiptPayload();
    const commands = buildPersonSplitReceiptCommands(person, idx, payload);
    const res = await sendCommandsToSunmiPrinter(commands);
    if (res.printedOnDevice) {
      showToast(`${person.label} 分單：${res.message}`, res.success ? 'success' : 'error');
    } else {
      setPreviewTitle(`商米 V2s 單人分拆收據預覽 — ${person.label}`);
      setPreviewCommands(commands);
      setSubModal('receipt_preview');
    }
  };

  // Submit Checkout to Backend
  const handleConfirmCheckout = async (shouldPrint = false) => {
    setIsSubmitting(true);
    try {
      const promoCodesJoined = computed.evaluatedPromos.map(p => p.code).join(', ');
      const checkoutDetails = {
        people: computed.people,
        order_addons: orderAddons,
        applied_promos: computed.evaluatedPromos,
        manual_discount: parseInt(manualDiscount, 10) || 0,
        discount_split_mode: discountSplitMode,
        subtotal_seating: computed.subtotalSeating,
        subtotal_equipment: computed.subtotalEquipment,
        subtotal_addons: computed.subtotalAddons,
        discount_amount: computed.totalDiscount,
        total_amount: computed.grandTotal,
        payment_method: paymentMethod,
        note: checkoutNote,
        checked_out_at: new Date().toISOString()
      };

      await api.post(`/checkout/reservations/${reservation.booking_ref}`, {
        total_amount: computed.grandTotal,
        payment_method: paymentMethod,
        checkout_unlimited_pax: computed.unlimitedPaxCount,
        checkout_regular_hours: computed.regularHoursSum,
        checkout_details: checkoutDetails,
        promo_code: promoCodesJoined || null,
        discount_amount: computed.totalDiscount,
        addons_amount: computed.subtotalAddons,
        is_paid: true
      });

      showToast('✅ 結帳完成！已更新營收與會員累計時數');
      if (onCheckoutSuccess) {
        onCheckoutSuccess();
      }

      if (shouldPrint) {
        await handlePrintFullReceipt();
      } else {
        setTimeout(() => {
          onClose();
        }, 600);
      }
    } catch (err) {
      console.error('Checkout failed:', err);
      showToast(err.response?.data?.error || '結帳儲存失敗，請重試', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Admin CRUD for Promo Codes inside Sub-modal
  const handleCreatePromo = async (e) => {
    e.preventDefault();
    try {
      await api.post('/checkout/promo-codes', newPromo);
      showToast('已新增優惠券');
      setNewPromo({
        code: '',
        name: '',
        description: '',
        discount_type: 'fixed_order',
        discount_value: 30,
        min_pax: 1,
        min_hours: 0,
        min_amount: 0,
        applicable_days: 'all',
        applicable_mode: 'all',
        max_uses: '',
        max_uses_per_user: '',
        valid_until: '',
        is_pos_quick_select: true
      });
      fetchConfigs();
    } catch (err) {
      showToast(err.response?.data?.error || '新增優惠券失敗', 'error');
    }
  };

  const handleTogglePromoField = async (promo, field) => {
    try {
      await api.put(`/checkout/promo-codes/${promo.id}`, {
        [field]: !promo[field]
      });
      fetchConfigs();
    } catch (err) {
      showToast('更新優惠券失敗', 'error');
    }
  };

  const handleDeletePromo = async (id) => {
    if (!window.confirm('確定要刪除此優惠券嗎？')) return;
    try {
      await api.delete(`/checkout/promo-codes/${id}`);
      fetchConfigs();
      showToast('已刪除優惠券');
    } catch (err) {
      showToast('刪除失敗', 'error');
    }
  };

  // Admin CRUD for Addon Presets inside Sub-modal
  const handleCreateAddonPreset = async (e) => {
    e.preventDefault();
    try {
      await api.post('/checkout/addons', newAddon);
      setNewAddon({ name: '', price: 30, category: 'charm' });
      fetchConfigs();
      showToast('已新增常用加購品項');
    } catch (err) {
      showToast('新增加購品項失敗', 'error');
    }
  };

  const handleDeleteAddonPreset = async (id) => {
    try {
      await api.delete(`/checkout/addons/${id}`);
      fetchConfigs();
      showToast('已刪除加購品項');
    } catch (err) {
      showToast('刪除失敗', 'error');
    }
  };

  const quickPromos = promoCodes.filter(p => p.is_active && p.is_pos_quick_select);
  const activeAddonPresets = addonPresets.filter(a => a.is_active);
  const sunmiDetected = isSunmiPosAvailable();

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-0 sm:p-4 z-[120] animate-fade-in">
      <div className="bg-slate-50 rounded-none sm:rounded-2xl max-w-5xl w-full h-[100dvh] sm:h-auto sm:max-h-[94dvh] flex flex-col shadow-2xl border-0 sm:border border-slate-200 overflow-hidden">
        {/* Top Header — Compact on POS/Mobile to maximize scrollable height */}
        <div className="bg-[#3E332B] text-[#FAF7F2] px-3 sm:px-6 py-2 sm:py-3.5 flex items-center justify-between gap-2 shrink-0 border-b border-[#2C241E]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-white/10 border border-[#E8DEC8]/20 flex items-center justify-center text-base sm:text-xl shrink-0">
              💳
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                <h3 className="text-sm sm:text-xl font-extrabold tracking-tight truncate">
                  櫃檯結帳與多人拆帳工作台
                </h3>
                {reservation.is_paid ? (
                  <span className="px-2 py-0.5 text-[10px] sm:text-xs font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/30">
                    ✅ 已結帳
                  </span>
                ) : (
                  <span className="px-2 py-0.5 text-[10px] sm:text-xs font-bold rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/30">
                    ⏳ 待結帳
                  </span>
                )}
                <span
                  className={`hidden sm:inline-block px-2.5 py-0.5 text-[11px] font-bold rounded-full border ${
                    sunmiDetected
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/30'
                      : 'bg-white/10 text-[#D5CFC9] border-white/15'
                  }`}
                >
                  {sunmiDetected ? '🖨️ 商米 V2s 已連線' : '💻 桌面 / 收據預覽模式'}
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-[#D5CFC9] mt-0.5 truncate">
                #{String(reservation.booking_ref).slice(0, 8).toUpperCase()} ·
                <strong className="text-white ml-1">{reservation.user?.name || '現場客'}</strong>
                {reservation.user?.phone ? ` (${reservation.user.phone})` : ''} · 座位：
                <span className="text-amber-300 font-semibold ml-0.5">
                  {reservation.assigned_seats?.length > 0 ? reservation.assigned_seats.join(', ') : '未指定'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <a
              href="/admin/coupons"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden md:flex px-3 py-1.5 rounded-lg text-xs font-bold bg-[#8B5B43] hover:bg-[#7A4F3A] text-white border border-[#A6755C] transition items-center gap-1 shadow-xs"
              title="另開新分頁開啟卡券與加購品完整後台"
            >
              🎟️ 卡券管理中心 ↗
            </a>
            <button
              type="button"
              onClick={() => setSubModal(subModal === 'promo_manager' ? 'none' : 'promo_manager')}
              className="hidden md:inline-block px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20 text-white border border-white/15 transition"
            >
              快速加卡券 ({promoCodes.length})
            </button>
            <button
              type="button"
              onClick={() => setSubModal(subModal === 'addon_manager' ? 'none' : 'addon_manager')}
              className="hidden md:inline-block px-3 py-1.5 rounded-lg text-xs font-bold bg-white/10 hover:bg-white/20 text-white border border-white/15 transition"
            >
              快速加品項 ({addonPresets.length})
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-rose-500/80 text-white flex items-center justify-center text-lg font-bold transition shrink-0"
              aria-label="關閉結帳視窗"
            >
              ×
            </button>
          </div>
        </div>

        {/* Toast Alert */}
        {toastMsg && (
          <div
            className={`px-4 py-1.5 text-xs sm:text-sm font-bold text-center shrink-0 ${
              toastMsg.type === 'error'
                ? 'bg-rose-600 text-white'
                : 'bg-emerald-600 text-white'
            }`}
          >
            {toastMsg.msg}
          </div>
        )}

        {/* Main Scrollable Content (min-h-0 ensures proper Flex scrolling on Android/Sunmi POS WebViews) */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2.5 sm:p-5 space-y-3.5 sm:space-y-5">
          {/* Mobile / POS Quick Toolbar & Daily Pricing Rate Banner (scrolls with content so it never hogs screen height) */}
          <div className="bg-[#FAF7F2] rounded-xl border border-[#E8DEC8] px-3 sm:px-4 py-2.5 space-y-2 text-xs text-[#3E332B]">
            <div className="flex md:hidden flex-wrap items-center justify-between gap-1.5 pb-2 border-b border-[#E8DEC8]">
              <span
                className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
                  sunmiDetected
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                    : 'bg-white text-[#6D5D52] border-[#E8DEC8]'
                }`}
              >
                {sunmiDetected ? '🖨️ 商米 V2s 已連線' : '💻 收據預覽模式'}
              </span>
              <div className="flex items-center gap-1.5">
                <a
                  href="/admin/coupons"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2 py-1 rounded-lg text-[11px] font-bold bg-[#8B5B43] text-white"
                >
                  🎟️ 卡券中心
                </a>
                <button
                  type="button"
                  onClick={() => setSubModal(subModal === 'promo_manager' ? 'none' : 'promo_manager')}
                  className="px-2 py-1 rounded-lg text-[11px] font-bold bg-white text-[#3E332B] border border-[#E8DEC8]"
                >
                  ＋卡券 ({promoCodes.length})
                </button>
                <button
                  type="button"
                  onClick={() => setSubModal(subModal === 'addon_manager' ? 'none' : 'addon_manager')}
                  className="px-2 py-1 rounded-lg text-[11px] font-bold bg-white text-[#3E332B] border border-[#E8DEC8]"
                >
                  ＋品項 ({addonPresets.length})
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
                <span className="font-bold">
                  📅 當日費率 ({pricingInfo.is_weekend ? '假日標準' : '平日標準'})：
                </span>
                <span className="bg-white px-2 py-0.5 rounded border border-[#E8DEC8] font-semibold">
                  計時：<strong>${pricingInfo.hourly_price}</strong>/hr
                </span>
                <span className="bg-white px-2 py-0.5 rounded border border-[#E8DEC8] font-semibold">
                  加時(+0.5hr)：<strong>+${Math.round(pricingInfo.hourly_price * 0.5)}</strong>
                </span>
                {pricingInfo.allow_unlimited && (
                  <span className="bg-amber-100/80 text-amber-900 px-2 py-0.5 rounded border border-amber-300 font-bold">
                    ✨ 封頂：<strong>${pricingInfo.unlimited_price}</strong>/人
                  </span>
                )}
              </div>
              <div className="hidden sm:block text-[11px] text-[#8C8279] font-medium">
                💡 單人計時＋加時達封頂金額時自動切換封頂價
              </div>
            </div>
          </div>
          {/* SECTION 1: 多人拆帳與個別時數 / 加時半小時 */}
          <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-[#E8DEC8]">
            <div className="flex flex-wrap justify-between items-center gap-2 mb-4">
              <div>
                <h4 className="text-base font-extrabold text-[#3E332B] flex items-center gap-2">
                  <span>👥 1. 多人拆帳與個別遊玩時數設定</span>
                  <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-[#FAF7F2] text-[#8B5B43] border border-[#E8DEC8]">
                    共 {computed.people.length} 位
                  </span>
                </h4>
                <p className="text-xs text-[#8C8279] mt-0.5">
                  可針對同行每位顧客分別設定遊玩時數、未登錄之「加時半小時 (+0.5hr)」、不限時封頂、洞洞板分攤與個人收據列印
                </p>
              </div>
              <button
                type="button"
                onClick={addPersonCard}
                className="px-3 py-1.5 bg-[#FAF7F2] hover:bg-[#F2ECE4] text-[#8B5B43] border border-[#E8DEC8] rounded-xl text-xs font-bold transition flex items-center gap-1"
              >
                <span>＋</span> 新增同行拆帳人
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {computed.people.map((p, idx) => (
                <div
                  key={p.id || idx}
                  className={`rounded-xl p-3.5 border-2 transition ${
                    p.effective_unlimited
                      ? 'bg-amber-50/40 border-amber-300'
                      : 'bg-[#FAF7F2]/60 border-[#E8DEC8] hover:border-[#8B5B43]'
                  }`}
                >
                  {/* Person Card Top Row */}
                  <div className="flex items-center justify-between gap-2 mb-2.5">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="w-6 h-6 rounded-full bg-[#3E332B] text-white text-xs font-bold flex items-center justify-center shrink-0">
                        {idx + 1}
                      </span>
                      <input
                        type="text"
                        value={p.label}
                        onChange={e => updatePerson(idx, { label: e.target.value })}
                        className="text-sm font-bold text-[#3E332B] bg-transparent border-b border-dashed border-[#D5CFC9] focus:border-[#8B5B43] focus:outline-none px-1 py-0.5 w-full"
                      />
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handlePrintPersonReceipt(p, idx)}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-white hover:bg-[#FAF7F2] text-[#8B5B43] border border-[#E8DEC8] shadow-sm transition"
                        title="單獨列印此位顧客的分拆收據"
                      >
                        🖨️ 印分單
                      </button>
                      {computed.people.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePersonCard(idx)}
                          className="w-6 h-6 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs font-bold flex items-center justify-center"
                          title="移除此位"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Mode & Hours Controls */}
                  <div className="grid grid-cols-2 gap-2 mb-2.5">
                    {/* Left: Mode Toggle */}
                    <div className="bg-white p-2 rounded-lg border border-slate-200">
                      <div className="text-[11px] font-bold text-slate-500 mb-1">計費方案</div>
                      <div className="flex rounded-lg bg-slate-100 p-0.5">
                        <button
                          type="button"
                          onClick={() => updatePerson(idx, { is_unlimited: false })}
                          className={`flex-1 py-1 text-xs font-bold rounded-md transition ${
                            !p.is_unlimited
                              ? 'bg-white text-slate-800 shadow-sm'
                              : 'text-slate-500 hover:text-slate-700'
                          }`}
                        >
                          ⏱️ 計時
                        </button>
                        <button
                          type="button"
                          onClick={() => updatePerson(idx, { is_unlimited: true })}
                          disabled={!pricingInfo.allow_unlimited}
                          className={`flex-1 py-1 text-xs font-bold rounded-md transition ${
                            p.is_unlimited
                              ? 'bg-amber-500 text-white shadow-sm'
                              : 'text-slate-500 hover:text-slate-700 disabled:opacity-40'
                          }`}
                        >
                          ✨ 不限時
                        </button>
                      </div>
                    </div>

                    {/* Right: Base Hours Stepper */}
                    <div className="bg-white p-2 rounded-lg border border-slate-200">
                      <div className="text-[11px] font-bold text-slate-500 mb-1">
                        預約時數 {!p.is_unlimited && `($${pricingInfo.hourly_price}/h)`}
                      </div>
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          disabled={p.is_unlimited || p.base_hours <= 1}
                          onClick={() => updatePerson(idx, { base_hours: Math.max(1, p.base_hours - 1) })}
                          className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-40 font-bold text-slate-700"
                        >
                          -
                        </button>
                        <span className="text-sm font-extrabold text-slate-800">
                          {p.is_unlimited ? '全日封頂' : `${p.base_hours} 小時`}
                        </span>
                        <button
                          type="button"
                          disabled={p.is_unlimited}
                          onClick={() => updatePerson(idx, { base_hours: p.base_hours + 1 })}
                          className="w-7 h-7 rounded-lg bg-slate-100 hover:bg-slate-200 disabled:opacity-40 font-bold text-slate-700"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Half-Hour Unregistered Extension Row (+0.5hr) */}
                  {!p.is_unlimited && (
                    <div className="bg-white p-2 rounded-lg border border-[#E8DEC8] mb-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-bold text-[#3E332B] flex items-center gap-1">
                        <span>⏱️ 現場未登錄加時：</span>
                        {p.extra_half_hours > 0 ? (
                          <span className="text-[#8B5B43] font-black">
                            +{p.extra_half_hours * 0.5} 小時 (+$
                            {Math.round(p.extra_half_hours * 0.5 * pricingInfo.hourly_price)})
                          </span>
                        ) : (
                          <span className="text-[#8C8279] font-normal">無加時</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {[0, 1, 2, 3].map(halfCount => (
                          <button
                            key={halfCount}
                            type="button"
                            onClick={() => updatePerson(idx, { extra_half_hours: halfCount })}
                            className={`px-2 py-1 rounded text-[11px] font-bold border transition ${
                              p.extra_half_hours === halfCount
                                ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                                : 'bg-[#FAF7F2] hover:bg-[#F2ECE4] text-[#6D5D52] border-[#E8DEC8]'
                            }`}
                          >
                            {halfCount === 0 ? '0h' : `+${halfCount * 0.5}h`}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Equipment Fee Share & Personal Addons */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[#6D5D52] font-bold">💡 洞洞板分攤: $</span>
                      <input
                        type="number"
                        min="0"
                        step="10"
                        value={p.equipment_fee}
                        onChange={e =>
                          updatePerson(idx, { equipment_fee: Math.max(0, parseInt(e.target.value, 10) || 0) })
                        }
                        className="w-16 px-1.5 py-0.5 text-xs font-bold border border-[#E8DEC8] rounded bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => setAddonTarget(String(idx))}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold border transition ${
                        addonTarget === String(idx)
                          ? 'bg-[#8B5B43] text-white border-[#8B5B43]'
                          : 'bg-[#FAF7F2] text-[#8B5B43] border-[#E8DEC8] hover:bg-[#F2ECE4]'
                      }`}
                    >
                      {addonTarget === String(idx) ? '🎯 點下方加購品將歸入此人' : '＋ 點此指定個人加購'}
                    </button>
                  </div>

                  {/* Personal Addons Pills */}
                  {p.addons && p.addons.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {p.addons.map((a, aIdx) => (
                        <span
                          key={aIdx}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-[#FAF0ED] text-[#C25E3E] border border-[#F2D6CD]"
                        >
                          {a.name} x{a.qty || 1} (${(a.price || 0) * (a.qty || 1)})
                          <button
                            type="button"
                            onClick={() => removePersonAddon(idx, aIdx)}
                            className="text-[#C25E3E] hover:text-rose-700 ml-0.5 font-extrabold"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Person Subtotal Footer */}
                  <div className="pt-2 border-t border-[#E8DEC8] flex items-center justify-between">
                    <div className="text-[11px] text-[#8C8279] space-x-1.5">
                      <span>座位 ${p.seating_fee}</span>
                      {p.is_auto_capped && !p.is_unlimited && (
                        <span className="px-1.5 py-0.2 bg-amber-100 text-amber-900 border border-amber-300 rounded font-bold">
                          已自動封頂✨
                        </span>
                      )}
                      {p.equipment_fee > 0 && <span>· 設備 ${p.equipment_fee}</span>}
                      {p.addons_fee > 0 && <span>· 個人加購 ${p.addons_fee}</span>}
                      {p.shared_addon_share > 0 && <span>· 共同加購 ${p.shared_addon_share}</span>}
                      {p.discount_fee > 0 && (
                        <span className="text-rose-600 font-bold">· 折抵 -${p.discount_fee}</span>
                      )}
                    </div>
                    <div className="text-right">
                      <span className="text-[11px] text-[#8C8279] mr-1">應付:</span>
                      <span className="text-base font-black text-[#8B5B43]">NT$ {p.person_total}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* SECTION 2: 不同價位吊飾 / 周邊加購區 */}
          <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-[#E8DEC8]">
            <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
              <div>
                <h4 className="text-base font-extrabold text-[#3E332B] flex items-center gap-2">
                  <span>🛍️ 2. 不同價位吊飾／周邊與代燙加購</span>
                  {computed.subtotalAddons > 0 && (
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-[#FAF0ED] text-[#C25E3E] border border-[#F2D6CD]">
                      加購小計 +NT$ {computed.subtotalAddons}
                    </span>
                  )}
                </h4>
                <p className="text-xs text-[#8C8279] mt-0.5">
                  可選擇將加購品計入「整單共同加購」或直接歸入指定顧客的拆帳明細中
                </p>
              </div>

              {/* Target Selector */}
              <div className="flex items-center gap-1.5 bg-[#FAF7F2] p-1 rounded-xl border border-[#E8DEC8]">
                <span className="text-xs font-bold text-[#6D5D52] px-2">加購歸屬：</span>
                <button
                  type="button"
                  onClick={() => setAddonTarget('order')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                    addonTarget === 'order'
                      ? 'bg-[#8B5B43] text-white shadow-xs'
                      : 'text-[#6D5D52] hover:bg-white'
                  }`}
                >
                  整單共同
                </button>
                {computed.people.map((p, idx) => (
                  <button
                    key={p.id || idx}
                    type="button"
                    onClick={() => setAddonTarget(String(idx))}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition ${
                      addonTarget === String(idx)
                        ? 'bg-[#8B5B43] text-white shadow-xs'
                        : 'text-[#6D5D52] hover:bg-white'
                    }`}
                  >
                    第{idx + 1}位
                  </button>
                ))}
              </div>
            </div>

            {/* Quick Preset Addon Buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 mb-3">
              {activeAddonPresets.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelectAddon(item)}
                  className="p-2.5 rounded-xl border border-[#E8DEC8] bg-[#FAF7F2] hover:bg-[#F2ECE4] text-left transition flex flex-col justify-between group"
                >
                  <span className="text-xs font-bold text-[#3E332B] group-hover:text-[#8B5B43] line-clamp-1">
                    {item.name}
                  </span>
                  <span className="text-sm font-black text-[#8B5B43] mt-1">+${item.price}</span>
                </button>
              ))}
            </div>

            {/* Custom Ad-hoc Addon Input */}
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[#E8DEC8]">
              <span className="text-xs font-bold text-[#6D5D52]">自訂加購：</span>
              <input
                type="text"
                placeholder="品項名稱 (例：特殊大鑰匙圈)"
                value={customAddonName}
                onChange={e => setCustomAddonName(e.target.value)}
                className="px-3 py-1.5 text-xs border border-[#E8DEC8] rounded-lg flex-1 min-w-[150px] text-[#3E332B] focus:border-[#8B5B43] outline-none"
              />
              <input
                type="number"
                placeholder="金額 ($)"
                value={customAddonPrice}
                onChange={e => setCustomAddonPrice(e.target.value)}
                className="px-3 py-1.5 text-xs border border-[#E8DEC8] rounded-lg w-24 font-bold text-[#8B5B43] focus:border-[#8B5B43] outline-none"
              />
              <button
                type="button"
                onClick={handleAddCustomAddon}
                className="px-3.5 py-1.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-lg transition shadow-xs"
              >
                ＋ 加入
              </button>
            </div>

            {/* Order-level Addons List */}
            {orderAddons.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#E8DEC8] flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-[#6D5D52]">已選整單加購：</span>
                {orderAddons.map((item, idx) => (
                  <span
                    key={idx}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-[#FAF0ED] text-[#C25E3E] border border-[#F2D6CD]"
                  >
                    <span>
                      {item.name} x{item.qty || 1} (${(item.price || 0) * (item.qty || 1)})
                    </span>
                    <button
                      type="button"
                      onClick={() => removeOrderAddon(idx)}
                      className="text-[#C25E3E] hover:text-rose-700 font-black ml-1"
                      title="移除此加購品"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* SECTION 3: 通用優惠券快捷鍵 & 折扣碼 */}
          <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-200">
            <div className="flex flex-wrap justify-between items-center gap-2 mb-3">
              <div>
                <h4 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
                  <span>🎟️ 3. 現場通用優惠券快捷鍵 & 折扣碼</span>
                  {computed.totalDiscount > 0 && (
                    <span className="text-xs font-bold px-2.5 py-0.5 rounded-full bg-rose-100 text-rose-700">
                      已折抵 -NT$ {computed.totalDiscount}
                    </span>
                  )}
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  點擊下方「通用優惠券」即可一鍵帶入現場活動折扣（如打卡折抵、五星好評等），亦可疊加或手動輸入折扣
                </p>
              </div>

              {/* Discount Split Mode */}
              {computed.people.length > 1 && computed.totalDiscount > 0 && (
                <div className="flex items-center gap-1.5 bg-slate-100 p-1 rounded-xl text-xs">
                  <span className="font-bold text-slate-600 px-2">折扣分攤方式：</span>
                  <button
                    type="button"
                    onClick={() => setDiscountSplitMode('even')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition ${
                      discountSplitMode === 'even'
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'text-slate-600 hover:bg-white'
                    }`}
                  >
                    各人平均分攤
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscountSplitMode('person_0')}
                    className={`px-2.5 py-1 rounded-lg font-bold transition ${
                      discountSplitMode === 'person_0'
                        ? 'bg-rose-600 text-white shadow-sm'
                        : 'text-slate-600 hover:bg-white'
                    }`}
                  >
                    全數折抵第 1 位
                  </button>
                </div>
              )}
            </div>

            {/* POS Quick Select Coupon Buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5 mb-3">
              {quickPromos.map(promo => {
                const isSelected = appliedPromos.some(p => p.code === promo.code);
                return (
                  <button
                    key={promo.id}
                    type="button"
                    onClick={() => toggleQuickPromo(promo)}
                    className={`p-3 rounded-xl border-2 text-left transition flex flex-col justify-between ${
                      isSelected
                        ? 'bg-rose-50 border-rose-500 ring-2 ring-rose-200'
                        : 'bg-slate-50/80 border-slate-200 hover:border-rose-300'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="text-xs font-extrabold text-slate-800">{promo.name}</span>
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          isSelected ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700'
                        }`}
                      >
                        {promo.code}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[11px] text-slate-500">
                        {promo.discount_type === 'fixed_order' && `整單折 $${promo.discount_value}`}
                        {promo.discount_type === 'fixed_per_pax' && `每人折 $${promo.discount_value}`}
                        {promo.discount_type === 'percentage' && `折抵 ${promo.discount_value}%`}
                        {promo.discount_type === 'free_hours' && `贈送 ${promo.discount_value} 小時`}
                      </span>
                      <span className="text-xs font-black text-rose-600">
                        {isSelected ? '✓ 已套用' : '點擊套用'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Promo Code Input & Manual Discount */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="輸入專屬折扣碼 (例: VIP2026)"
                  value={promoInput}
                  onChange={e => setPromoInput(e.target.value.toUpperCase())}
                  className="px-3 py-1.5 text-xs font-bold uppercase border border-[#E8DEC8] rounded-lg flex-1 text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
                <button
                  type="button"
                  onClick={handleApplyPromoInput}
                  className="px-3.5 py-1.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-lg transition shadow-xs"
                >
                  驗證套用
                </button>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#6D5D52] shrink-0">店員手動折讓 ($)：</span>
                <input
                  type="number"
                  min="0"
                  step="10"
                  value={manualDiscount}
                  onChange={e => setManualDiscount(Math.max(0, parseInt(e.target.value, 10) || 0))}
                  className="px-3 py-1.5 text-xs font-bold border border-[#E8DEC8] rounded-lg w-28 text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
                <input
                  type="text"
                  placeholder="結帳備註 (選填，會印在收據上)"
                  value={checkoutNote}
                  onChange={e => setCheckoutNote(e.target.value)}
                  className="px-3 py-1.5 text-xs border border-[#E8DEC8] rounded-lg flex-1 text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
              </div>
            </div>
            {promoError && <p className="text-xs text-rose-600 font-bold mt-1.5">{promoError}</p>}
          </div>

          {/* SECTION 4: 付款方式與會員雙軌統計預覽 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Payment Method */}
            <div className="bg-white rounded-2xl p-4 shadow-sm border border-[#E8DEC8]">
              <h4 className="text-sm font-extrabold text-[#3E332B] mb-2.5">💰 4. 選擇收款方式</h4>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: 'cash', label: '💵 現金付款' },
                  { key: 'line_pay', label: '💚 LINE Pay' },
                  { key: 'transfer', label: '🏦 銀行轉帳' }
                ].map(m => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setPaymentMethod(m.key)}
                    className={`py-2.5 px-3 rounded-xl text-xs font-extrabold border-2 transition ${
                      paymentMethod === m.key
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-800 shadow-sm'
                        : 'bg-[#FAF7F2] border-[#E8DEC8] text-[#6D5D52] hover:bg-[#F2ECE4]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Member Dual-Track Accumulation Preview */}
            <div className="bg-[#FAF7F2] rounded-2xl p-4 border border-[#E8DEC8] flex flex-col justify-between shadow-2xs">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-extrabold text-[#3E332B]">
                  📊 會員雙軌累計預覽（結帳後自動寫入會員檔案）
                </h4>
                <span className="text-[11px] font-bold text-[#8B5B43] bg-white px-2 py-0.5 rounded-full border border-[#E8DEC8]">
                  依拆帳結果精準統計
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2.5 mt-2">
                <div className="bg-white rounded-xl p-2.5 border border-amber-300">
                  <div className="text-[11px] font-bold text-amber-800">✨ 不限時（封頂）累計</div>
                  <div className="text-lg font-black text-amber-700 mt-0.5">
                    +{computed.unlimitedPaxCount} <span className="text-xs font-bold">人次</span>
                  </div>
                </div>
                <div className="bg-white rounded-xl p-2.5 border border-[#E8DEC8]">
                  <div className="text-[11px] font-bold text-[#8B5B43]">⏱️ 一般計時時長累計</div>
                  <div className="text-lg font-black text-[#8B5B43] mt-0.5">
                    +{computed.regularHoursSum} <span className="text-xs font-bold">人時</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile / POS Detailed Breakdown Card inside Scroll Area so Sticky Footer stays ultra-compact */}
          <div className="md:hidden bg-white rounded-2xl p-3.5 border border-[#E8DEC8] shadow-xs text-xs text-[#6D5D52] space-y-1">
            <div className="font-extrabold text-[#3E332B]">📋 整單費用與拆帳明細</div>
            <div>
              座位與加時：<strong className="text-[#3E332B]">${computed.subtotalSeating}</strong> · 設備：
              <strong className="text-[#3E332B]">${computed.subtotalEquipment}</strong> · 加購：
              <strong className="text-[#3E332B]">${computed.subtotalAddons}</strong> · 優惠折抵：
              <strong className="text-rose-600">-${computed.totalDiscount}</strong>
            </div>
            <div>
              各人拆帳合計：
              <strong className="text-[#8B5B43]">
                {computed.people.map((p, i) => `第${i + 1}位$${p.person_total}`).join(' + ')}
              </strong>
            </div>
          </div>
        </div>

        {/* Bottom Sticky Summary & POS Print Bar — Compact on POS/Mobile */}
        <div className="bg-white border-t border-[#E8DEC8] px-3 sm:px-6 py-2 sm:py-3.5 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center justify-between gap-2 sm:gap-4 shrink-0">
          <div className="flex items-center justify-between sm:justify-start sm:items-baseline gap-2 sm:gap-4">
            <div className="flex items-baseline gap-2 sm:block">
              <span className="text-xs font-bold text-[#8C8279] sm:block">整單應收總金額</span>
              <span className="text-xl sm:text-3xl font-black text-[#8B5B43]">
                NT$ {computed.grandTotal.toLocaleString()}
              </span>
            </div>
            {/* Compact 1-line summary on POS/mobile */}
            <div className="md:hidden text-[11px] font-bold text-[#6D5D52] bg-[#FAF7F2] px-2 py-0.5 rounded-lg border border-[#E8DEC8]">
              共 {computed.people.length} 人{computed.totalDiscount > 0 ? ` · 已折 $${computed.totalDiscount}` : ''}
            </div>
            {/* Full breakdown on Tablet/Desktop */}
            <div className="hidden md:block text-xs text-[#8C8279] space-y-0.5 border-l border-[#E8DEC8] pl-3">
              <div>
                座位與加時：<strong className="text-[#3E332B]">${computed.subtotalSeating}</strong> · 設備：
                <strong className="text-[#3E332B]">${computed.subtotalEquipment}</strong> · 加購：
                <strong className="text-[#3E332B]">${computed.subtotalAddons}</strong>
              </div>
              <div>
                優惠折抵：<strong className="text-rose-600">-${computed.totalDiscount}</strong> ·
                各人拆帳合計：
                <strong className="text-[#8B5B43]">
                  {computed.people.map((p, i) => `第${i + 1}位$${p.person_total}`).join(' + ')}
                </strong>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={handlePrintFullReceipt}
              className="px-2 sm:px-3.5 py-2 sm:py-2.5 rounded-xl text-[11px] sm:text-sm font-bold bg-[#FAF7F2] hover:bg-[#F2ECE4] text-[#3E332B] border border-[#E8DEC8] transition shadow-xs text-center truncate"
            >
              🖨️ 預覽/印總單
            </button>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleConfirmCheckout(false)}
              className="px-2 sm:px-4 py-2 sm:py-2.5 rounded-xl text-[11px] sm:text-sm font-bold bg-white hover:bg-[#FAF7F2] text-[#3E332B] border border-[#E8DEC8] shadow-xs transition disabled:opacity-50 text-center truncate"
            >
              ✅ 僅確認結帳
            </button>

            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleConfirmCheckout(true)}
              className="px-2 sm:px-5 py-2 sm:py-2.5 rounded-xl text-[11px] sm:text-sm font-extrabold bg-[#8B5B43] hover:bg-[#7A4F3A] text-white shadow-md transition disabled:opacity-50 flex items-center justify-center gap-1 text-center truncate"
            >
              <span className="truncate">🖨️ 結帳並印單</span>
            </button>
          </div>
        </div>
      </div>

      {/* SUB-MODAL 1: 58mm Thermal Receipt Preview (for non-Sunmi desktop or verification) */}
      {subModal === 'receipt_preview' && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center p-2 sm:p-4 z-[130]">
          <div className="bg-white rounded-2xl max-w-md w-full max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden">
            <div className="bg-slate-900 text-white px-4 py-2.5 flex justify-between items-center shrink-0">
              <h4 className="font-bold text-sm">{previewTitle}</h4>
              <button
                type="button"
                onClick={() => setSubModal('none')}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                ×
              </button>
            </div>

            <div className="p-3 sm:p-4 overflow-y-auto overscroll-contain bg-slate-100 flex-1 min-h-0 flex flex-col items-center">
              {/* 58mm Thermal Paper Simulation */}
              <div
                id="sunmi-thermal-preview"
                className="bg-white w-[300px] p-4 shadow-md border border-slate-200 font-mono text-xs text-slate-900 leading-relaxed"
              >
                {previewCommands.map((cmd, idx) => {
                  if (cmd.type === 'title') {
                    return (
                      <div key={idx} className="text-center font-black text-base mb-1">
                        {cmd.text}
                      </div>
                    );
                  }
                  if (cmd.type === 'columns') {
                    return (
                      <div key={idx} className="flex justify-between items-baseline gap-2 my-0.5">
                        <span className="font-semibold">{cmd.cols?.[0]}</span>
                        <span className="font-bold shrink-0">{cmd.cols?.[1]}</span>
                      </div>
                    );
                  }
                  if (cmd.type === 'lineWrap') {
                    return <div key={idx} className="h-4" />;
                  }
                  const alignClass =
                    cmd.align === 1 ? 'text-center' : cmd.align === 2 ? 'text-right' : 'text-left';
                  return (
                    <div
                      key={idx}
                      className={`${alignClass} ${cmd.bold ? 'font-bold' : ''} whitespace-pre-wrap`}
                    >
                      {cmd.text}
                    </div>
                  );
                })}
              </div>

              {showRawJson && (
                <pre className="mt-3 w-full bg-slate-900 text-emerald-400 p-3 rounded-xl text-[10px] overflow-x-auto">
                  {JSON.stringify(previewCommands, null, 2)}
                </pre>
              )}
            </div>

            <div className="p-3 bg-white border-t border-[#E8DEC8] flex justify-between items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRawJson(!showRawJson)}
                className="px-3 py-1.5 text-xs font-bold text-[#6D5D52] bg-[#FAF7F2] hover:bg-[#F2ECE4] border border-[#E8DEC8] rounded-lg"
              >
                {showRawJson ? '隱藏商米 JSON 指令' : '檢視商米 V2s JSON'}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="px-3.5 py-1.5 text-xs font-bold bg-[#8B5B43] hover:bg-[#7A4F3A] text-white rounded-lg shadow-xs"
                >
                  🖨️ 瀏覽器列印
                </button>
                <button
                  type="button"
                  onClick={() => setSubModal('none')}
                  className="px-3.5 py-1.5 text-xs font-bold bg-[#3E332B] hover:bg-[#2C241E] text-white rounded-lg"
                >
                  關閉
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-MODAL 2: Promo Code & POS Quick Coupon Manager */}
      {subModal === 'promo_manager' && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center p-2 sm:p-4 z-[130]">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden border border-[#E8DEC8]">
            <div className="bg-[#3E332B] text-white px-4 sm:px-5 py-3 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <h4 className="font-bold text-sm sm:text-base">🎟️ 優惠券與櫃檯通用折扣管理</h4>
                <a
                  href="/admin/coupons"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-bold text-[#FAF7F2] bg-white/10 hover:bg-white/20 px-2 py-0.5 rounded border border-white/20 ml-2"
                >
                  開啟完整卡券後台 ↗
                </a>
              </div>
              <button
                type="button"
                onClick={() => setSubModal('none')}
                className="text-white/70 hover:text-white text-xl font-bold"
              >
                ×
              </button>
            </div>

            <div className="p-3.5 sm:p-5 overflow-y-auto overscroll-contain space-y-4 flex-1 min-h-0">
              <form
                onSubmit={handleCreatePromo}
                className="bg-[#FAF7F2] p-4 rounded-xl border border-[#E8DEC8] space-y-3"
              >
                <div className="text-xs font-extrabold text-[#3E332B]">＋ 快速新增折扣碼／櫃檯通用優惠券</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <input
                    type="text"
                    required
                    placeholder="代碼 (例: CHECKIN50)"
                    value={newPromo.code}
                    onChange={e => setNewPromo({ ...newPromo, code: e.target.value.toUpperCase() })}
                    className="px-3 py-1.5 text-xs font-bold uppercase border border-[#E8DEC8] rounded-lg bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                  <input
                    type="text"
                    required
                    placeholder="顯示名稱 (例: IG打卡折$50)"
                    value={newPromo.name}
                    onChange={e => setNewPromo({ ...newPromo, name: e.target.value })}
                    className="px-3 py-1.5 text-xs border border-[#E8DEC8] rounded-lg bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  />
                  <select
                    value={newPromo.discount_type}
                    onChange={e => setNewPromo({ ...newPromo, discount_type: e.target.value })}
                    className="px-3 py-1.5 text-xs font-bold border border-[#E8DEC8] rounded-lg bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                  >
                    <option value="fixed_order">整單折抵固定金額 ($)</option>
                    <option value="fixed_per_pax">依人數每人折抵 ($)</option>
                    <option value="percentage">百分比折抵 (% off)</option>
                    <option value="free_hours">贈送免費時數 (小時)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div>
                    <label className="text-[11px] text-[#6D5D52] font-bold block">折抵數值</label>
                    <input
                      type="number"
                      required
                      value={newPromo.discount_value}
                      onChange={e => setNewPromo({ ...newPromo, discount_value: e.target.value })}
                      className="w-full px-2.5 py-1 text-xs font-bold border border-[#E8DEC8] rounded-lg bg-white text-[#8B5B43] focus:border-[#8B5B43] outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#6D5D52] font-bold block">最低人數門檻</label>
                    <input
                      type="number"
                      min="1"
                      value={newPromo.min_pax}
                      onChange={e => setNewPromo({ ...newPromo, min_pax: e.target.value })}
                      className="w-full px-2.5 py-1 text-xs border border-[#E8DEC8] rounded-lg bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#6D5D52] font-bold block">平假日限制</label>
                    <select
                      value={newPromo.applicable_days}
                      onChange={e => setNewPromo({ ...newPromo, applicable_days: e.target.value })}
                      className="w-full px-2.5 py-1 text-xs border border-[#E8DEC8] rounded-lg bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                    >
                      <option value="all">平假日皆適用</option>
                      <option value="weekday">僅限平日</option>
                      <option value="weekend">僅限假日</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-1.5 text-xs font-bold text-amber-900 cursor-pointer pb-1">
                      <input
                        type="checkbox"
                        checked={newPromo.is_pos_quick_select}
                        onChange={e =>
                          setNewPromo({ ...newPromo, is_pos_quick_select: e.target.checked })
                        }
                        className="rounded border-[#E8DEC8] text-[#8B5B43] focus:ring-[#8B5B43]"
                      />
                      顯示於結帳通用快捷鍵
                    </label>
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-lg shadow-xs"
                  >
                    ＋ 儲存優惠券
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                {promoCodes.map(p => (
                  <div
                    key={p.id}
                    className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl border border-[#E8DEC8] bg-white text-xs"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-[#8B5B43] bg-[#FAF7F2] border border-[#E8DEC8] px-2 py-0.5 rounded">
                          {p.code}
                        </span>
                        <span className="font-bold text-[#3E332B]">{p.name}</span>
                        <span className="text-[#8C8279]">
                          (已使用 {p.used_count} 次{p.max_uses ? ` / 上限 ${p.max_uses}` : ''})
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleTogglePromoField(p, 'is_pos_quick_select')}
                        className={`px-2.5 py-1 rounded font-bold border ${
                          p.is_pos_quick_select
                            ? 'bg-amber-50 text-amber-900 border-amber-300'
                            : 'bg-[#FAF7F2] text-[#8C8279] border-[#E8DEC8]'
                        }`}
                      >
                        {p.is_pos_quick_select ? '⚡ 櫃檯快捷: 開啟' : '櫃檯快捷: 關閉'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleTogglePromoField(p, 'is_active')}
                        className={`px-2.5 py-1 rounded font-bold border ${
                          p.is_active
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                            : 'bg-gray-100 text-gray-600 border-gray-200'
                        }`}
                      >
                        {p.is_active ? '啟用中' : '已停用'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeletePromo(p.id)}
                        className="px-2 py-1 text-rose-600 hover:bg-rose-50 rounded font-bold"
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SUB-MODAL 3: Addon Presets Manager */}
      {subModal === 'addon_manager' && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center p-2 sm:p-4 z-[130]">
          <div className="bg-white rounded-2xl max-w-xl w-full max-h-[92dvh] flex flex-col shadow-2xl overflow-hidden border border-[#E8DEC8]">
            <div className="bg-[#3E332B] text-white px-4 sm:px-5 py-3 flex justify-between items-center shrink-0">
              <h4 className="font-bold text-sm sm:text-base">🛍️ 快速管理常用吊飾／周邊加購品項</h4>
              <button
                type="button"
                onClick={() => setSubModal('none')}
                className="text-white/70 hover:text-white text-xl font-bold"
              >
                ×
              </button>
            </div>

            <div className="p-3.5 sm:p-5 overflow-y-auto overscroll-contain space-y-4 flex-1 min-h-0">
              <form
                onSubmit={handleCreateAddonPreset}
                className="flex flex-wrap items-center gap-2 bg-[#FAF7F2] p-3 rounded-xl border border-[#E8DEC8]"
              >
                <input
                  type="text"
                  required
                  placeholder="品項名稱 (例: 夜光吊飾扣)"
                  value={newAddon.name}
                  onChange={e => setNewAddon({ ...newAddon, name: e.target.value })}
                  className="px-3 py-1.5 text-xs border border-[#E8DEC8] rounded-lg flex-1 bg-white text-[#3E332B] focus:border-[#8B5B43] outline-none"
                />
                <input
                  type="number"
                  required
                  placeholder="單價 ($)"
                  value={newAddon.price}
                  onChange={e => setNewAddon({ ...newAddon, price: e.target.value })}
                  className="px-3 py-1.5 text-xs font-bold border border-[#E8DEC8] rounded-lg w-24 bg-white text-[#8B5B43] focus:border-[#8B5B43] outline-none"
                />
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-[#8B5B43] hover:bg-[#7A4F3A] text-white text-xs font-bold rounded-lg shadow-xs"
                >
                  ＋ 新增品項
                </button>
              </form>

              <div className="space-y-2">
                {addonPresets.map(item => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-xl border border-[#E8DEC8] bg-white text-xs"
                  >
                    <div className="font-bold text-[#3E332B]">
                      {item.name}{' '}
                      <span className="text-[#8B5B43] font-black ml-1">NT$ {item.price}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDeleteAddonPreset(item.id)}
                      className="px-2.5 py-1 text-rose-600 hover:bg-rose-50 rounded font-bold"
                    >
                      刪除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

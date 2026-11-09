import React, { useState, useMemo } from 'react';
import ResponsivePanel from '../ResponsivePanel';
import Button from '../../customer/Button';
import { computeBill } from '@shared/billing.js';

export default function SharedItemsSplitPanel({
  isOpen = false,
  onClose,
  draftState,
  billData,
  onUpdateDraft
}) {
  const bill = billData?.bill || {};
  const orderAddons = draftState?.order_addons || [];
  const persons = bill.persons || [];
  const paidPersons = persons.filter(p => p.paid || p.is_paid || p.is_frozen);
  const firstPaid = paidPersons[0];
  const paidPersonLabel = firstPaid ? `第 ${firstPaid.person_no} 位付款後才加` : '付款後才加';

  // Find post-payment items or treat all addons
  const postPaymentAddons = orderAddons.filter(a => a.added_after_payment);
  const activePostAddon = postPaymentAddons[0] || orderAddons[orderAddons.length - 1] || null;

  // Split mode selection state: 'unpaid_only' | 'include_paid' | 'person'
  const [splitOption, setSplitOption] = useState(() => {
    if (activePostAddon?.split_mode === 'person' || activePostAddon?.split?.mode === 'person') {
      return 'person';
    }
    if (activePostAddon?.include_paid) {
      return 'include_paid';
    }
    return 'unpaid_only';
  });

  const [targetPersonNo, setTargetPersonNo] = useState(() => {
    return activePostAddon?.target_person_no || activePostAddon?.split?.person_no || 1;
  });

  // Calculate baseline bill (without post-payment items)
  const baselineBill = useMemo(() => {
    if (!billData) return null;
    try {
      const nonPostAddons = orderAddons.filter(a => !a.added_after_payment);
      return computeBill({
        pricing: billData.pricing || {},
        rules: billData.rules || { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' },
        discountConfig: billData.discountConfig || billData.discount_config || {},
        booking: billData.booking || {},
        persons: billData.billInput?.persons || billData.persons || [],
        boards: billData.boards || [],
        orderAddons: nonPostAddons,
        orderPromos: draftState?.order_promos || [],
        manualDiscount: draftState?.manual_discount || null,
        totalOverride: draftState?.total_override || null,
        payments: billData.payments || []
      });
    } catch (err) {
      console.error('[SharedItemsSplitPanel] Baseline compute error:', err);
      return null;
    }
  }, [billData, draftState, orderAddons]);

  // Live simulation of bill under current selection
  const simulatedBill = useMemo(() => {
    if (!billData) return null;
    try {
      // Build simulated order addons with currently selected split settings
      const simulatedAddons = orderAddons.map(a => {
        if (!a.added_after_payment) return a;
        if (splitOption === 'include_paid') {
          return {
            ...a,
            include_paid: true,
            split_mode: 'proportional',
            split: { mode: 'proportional' },
            target_person_no: null
          };
        }
        if (splitOption === 'person') {
          return {
            ...a,
            include_paid: false,
            split_mode: 'person',
            split: { mode: 'person', person_no: Number(targetPersonNo) },
            target_person_no: Number(targetPersonNo)
          };
        }
        // unpaid_only (default)
        return {
          ...a,
          include_paid: false,
          split_mode: 'proportional',
          split: { mode: 'proportional' },
          target_person_no: null
        };
      });

      return computeBill({
        pricing: billData.pricing || {},
        rules: billData.rules || { grace: 10, block: 30, early_leave_mode: 'booked', default_split_mode: 'proportional' },
        discountConfig: billData.discountConfig || billData.discount_config || {},
        booking: billData.booking || {},
        persons: billData.billInput?.persons || billData.persons || [],
        boards: billData.boards || [],
        orderAddons: simulatedAddons,
        orderPromos: draftState?.order_promos || [],
        manualDiscount: draftState?.manual_discount || null,
        totalOverride: draftState?.total_override || null,
        payments: billData.payments || []
      });
    } catch (err) {
      console.error('[SharedItemsSplitPanel] Simulation error:', err);
      return null;
    }
  }, [billData, draftState, orderAddons, splitOption, targetPersonNo]);

  // Build the live delta text summary (e.g. "第 1 位要補收 NT$29，第 2 位 +NT$51")
  const personDeltas = useMemo(() => {
    if (!simulatedBill || !persons.length) return [];
    return persons.map(p => {
      const simP = simulatedBill.persons.find(sp => sp.person_no === p.person_no) || p;
      const baseP = baselineBill?.persons?.find(bp => bp.person_no === p.person_no) || p;
      const isPaid = Boolean(p.paid || p.is_paid || p.is_frozen);

      if (isPaid) {
        const pending = simP.pending_supplement || 0;
        return {
          person_no: p.person_no,
          isPaid: true,
          pending,
          text: pending > 0 ? `第 ${p.person_no} 位要補收 NT$${pending}` : `第 ${p.person_no} 位免補收`
        };
      } else {
        const delta = Math.max(0, (simP.total || 0) - (baseP.total || 0));
        return {
          person_no: p.person_no,
          isPaid: false,
          delta,
          text: `第 ${p.person_no} 位 +NT$${delta}`
        };
      }
    });
  }, [simulatedBill, baselineBill, persons]);

  const handleApply = () => {
    if (!onUpdateDraft) return;
    onUpdateDraft(prev => {
      const list = (prev.order_addons || []).map(a => {
        if (!a.added_after_payment) return a;
        if (splitOption === 'include_paid') {
          return {
            ...a,
            include_paid: true,
            split_mode: 'proportional',
            split: { mode: 'proportional' },
            target_person_no: null
          };
        }
        if (splitOption === 'person') {
          return {
            ...a,
            include_paid: false,
            split_mode: 'person',
            split: { mode: 'person', person_no: Number(targetPersonNo) },
            target_person_no: Number(targetPersonNo)
          };
        }
        return {
          ...a,
          include_paid: false,
          split_mode: 'proportional',
          split: { mode: 'proportional' },
          target_person_no: null
        };
      });
      return { ...prev, order_addons: list };
    });
    onClose();
  };

  return (
    <ResponsivePanel
      isOpen={isOpen}
      onClose={onClose}
      title="整單共同項目 · 分攤"
      subtitle={`預約單號 ${billData?.booking?.ref_display || billData?.booking?.booking_ref || ''}`}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            data-testid="apply-shared-split-btn"
            variant="primary"
            size="md"
            onClick={handleApply}
          >
            套用分攤設定
          </Button>
        </div>
      }
    >
      <div className="space-y-5 py-2">
        {/* List of order-level addons */}
        <div>
          <span className="text-[13px] font-bold text-sg-ink block mb-2">整單共同加購清單</span>
          {orderAddons.length === 0 ? (
            <div className="p-4 rounded-2xl bg-sg-paper/50 border border-sg-line text-sg-muted text-[12px] text-center">
              目前無整單共同加購項目
            </div>
          ) : (
            <div className="space-y-2">
              {orderAddons.map(a => (
                <div
                  key={a.key || a.name}
                  className="p-3 rounded-2xl border border-sg-line bg-white flex items-center justify-between"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-bold text-sg-ink">{a.name} ×{a.qty || 1}</span>
                      {a.added_after_payment ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                          {paidPersonLabel}
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] text-sg-muted bg-sg-paper border border-sg-line">
                          付款前已加入
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] font-num text-sg-muted">
                      單價 NT${a.price} · 小計 NT${(Number(a.price) || 0) * (Number(a.qty) || 1)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 3 Split Options (Section 6.20) */}
        <div className="space-y-3 pt-3 border-t border-sg-line">
          <span className="text-[13px] font-bold text-sg-ink block">新加的項目怎麼分</span>

          <div className="space-y-2">
            {/* Option 1: 只算給還沒付的人 (預設) */}
            <label
              data-testid="split-option-unpaid-only"
              className={`p-3 rounded-2xl border flex items-center justify-between cursor-pointer transition select-none ${
                splitOption === 'unpaid_only'
                  ? 'bg-sg-brown-soft border-sg-brown text-sg-brown-dark'
                  : 'bg-white border-sg-line hover:border-sg-muted'
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="splitOption"
                  checked={splitOption === 'unpaid_only'}
                  onChange={() => setSplitOption('unpaid_only')}
                  className="w-4 h-4 text-sg-brown focus:ring-sg-brown"
                />
                <div>
                  <div className="text-[13px] font-bold">只算給還沒付的人（預設）</div>
                  <div className="text-[11px] text-sg-muted mt-0.5">
                    已結算的顧客不需補收，金額全數由未付款的顧客依比例分攤
                  </div>
                </div>
              </div>
            </label>

            {/* Option 2: 也分給已付的人 */}
            <label
              data-testid="split-option-include-paid"
              className={`p-3 rounded-2xl border flex items-center justify-between cursor-pointer transition select-none ${
                splitOption === 'include_paid'
                  ? 'bg-sg-brown-soft border-sg-brown text-sg-brown-dark'
                  : 'bg-white border-sg-line hover:border-sg-muted'
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="splitOption"
                  checked={splitOption === 'include_paid'}
                  onChange={() => setSplitOption('include_paid')}
                  className="w-4 h-4 text-sg-brown focus:ring-sg-brown"
                />
                <div>
                  <div className="text-[13px] font-bold">也分給已付的人</div>
                  <div className="text-[11px] text-sg-muted mt-0.5">
                    整筆共同費用平分/依比例算給所有人，已付者將產生待補收金額
                  </div>
                </div>
              </div>
            </label>

            {/* Option 3: 指定給某一位 */}
            <div
              data-testid="split-option-person"
              className={`p-3 rounded-2xl border transition select-none ${
                splitOption === 'person'
                  ? 'bg-sg-brown-soft border-sg-brown'
                  : 'bg-white border-sg-line'
              }`}
            >
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="splitOption"
                  checked={splitOption === 'person'}
                  onChange={() => setSplitOption('person')}
                  className="w-4 h-4 text-sg-brown focus:ring-sg-brown"
                />
                <div className="text-[13px] font-bold text-sg-ink">指定給某一位</div>
              </label>

              {splitOption === 'person' && (
                <div className="mt-3 pl-7 flex flex-wrap gap-2">
                  {persons.map(p => (
                    <button
                      key={p.person_no}
                      type="button"
                      onClick={() => setTargetPersonNo(p.person_no)}
                      className={`px-3 py-1.5 rounded-xl text-[12px] font-bold border transition ${
                        Number(targetPersonNo) === p.person_no
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-white text-sg-ink border-sg-line hover:bg-sg-paper'
                      }`}
                    >
                      第 {p.person_no} 位 {p.paid || p.is_paid || p.is_frozen ? '(已付)' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Live Delta Display */}
        <div className="p-3.5 rounded-2xl bg-sg-paper/70 border border-sg-line space-y-2">
          <div className="text-[11px] font-bold text-sg-muted uppercase tracking-wider">
            即時試算每位變化
          </div>
          <div
            data-testid="live-split-preview-text"
            className="text-[13px] font-bold text-sg-brown-dark leading-relaxed"
          >
            {personDeltas.map(d => d.text).join('，')}
          </div>
        </div>
      </div>
    </ResponsivePanel>
  );
}

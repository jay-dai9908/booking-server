// frontend/src/components/display/DisplayCheckoutView.jsx
import React from 'react';
import DisplayQrCode from './DisplayQrCode';
import api from '../../api/axios';

function formatMoney(amount) {
  const num = Math.round(Number(amount) || 0);
  return `${num < 0 ? '−' : ''}NT$${Math.abs(num).toLocaleString()}`;
}

function resolveApiImageUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('/brand/')) {
    return url;
  }
  const base = (api.defaults.baseURL || '/api').replace(/\/api\/?$/, '');
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Store display synchronized checkout view (matches store-display-mock.html checkoutHtml).
 * Zero customer PII: only table label, seat codes, person numbers, itemized amounts, and payment panel.
 */
export default function DisplayCheckoutView({
  checkout,
  paymentMethods = [],
  perPerson = true,
  twqr = {}
}) {
  if (!checkout) return null;

  const people = Array.isArray(checkout.persons) ? checkout.persons : [];
  const rawSelectedNos = Array.isArray(checkout.selected_person_nos) && checkout.selected_person_nos.length > 0
    ? checkout.selected_person_nos
    : (Array.isArray(checkout.due_person_nos) && checkout.due_person_nos.length > 0 ? checkout.due_person_nos : []);
  const dueNos = rawSelectedNos.length > 0
    ? rawSelectedNos
    : people.filter(p => !p.paid).map(p => p.person_no);
  const dueAmount = checkout.amount_due
    ?? checkout.due_amount
    ?? people
      .filter(p => dueNos.includes(p.person_no))
      .reduce((s, p) => s + (Number(p.subtotal ?? p.total) || 0), 0);
  const isSplit = Boolean(checkout.is_split) || people.some(p => p.paid) || (dueNos.length > 0 && dueNos.length < people.length);

  // Enabled payment methods strictly from GlobalSetting.payment_methods_json
  const enabledMethods = (Array.isArray(paymentMethods) ? paymentMethods : [])
    .filter(m => m && m.enabled !== false && m.key !== 'pass');

  const rawMethod = checkout.method ? String(checkout.method).trim() : '';
  const matchedMethod = enabledMethods.find(m =>
    m.key === rawMethod ||
    (rawMethod === 'line_pay' && m.key === 'linepay') ||
    (rawMethod === 'linepay' && m.key === 'line_pay')
  ) || null;

  const effectiveMethodKey = matchedMethod ? matchedMethod.key : '';
  const effectiveMethodLabel = matchedMethod?.label || '';
  const cashReceived = Number(checkout.cash_received) || 0;

  // Grid columns: 1..3 columns cleanly, wrapping nicely for 4+ people
  const gridCols = Math.min(3, Math.max(1, people.length));

  const renderPayPanel = () => {
    if (!effectiveMethodKey) {
      return (
        <div className="flex flex-col items-center" style={{ gap: 18 }}>
          <span
            data-testid="display-pay-state"
            className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
            style={{ fontSize: 30, padding: '8px 28px' }}
          >
            店員結帳中
          </span>
          <p className="text-sg-ink m-0" style={{ fontSize: 34, lineHeight: 1.45 }}>
            請稍候，
            <br />
            店員正在確認付款方式
          </p>
          {enabledMethods.length > 0 && (
            <div className="flex flex-wrap justify-center" style={{ gap: 14 }} data-testid="display-pay-methods-list">
              {enabledMethods.map(m => (
                <span
                  key={m.key}
                  className="font-body font-bold text-sg-brown bg-sg-brown-soft"
                  style={{ fontSize: 28, padding: '10px 24px', borderRadius: 14 }}
                >
                  {m.label}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (effectiveMethodKey === 'cash') {
      if (cashReceived > 0) {
        const change = checkout.change != null ? Math.max(0, Number(checkout.change)) : Math.max(0, cashReceived - dueAmount);
        return (
          <div className="flex flex-col items-center w-full" style={{ gap: 18 }}>
            <span
              data-testid="display-pay-state"
              className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
              style={{ fontSize: 30, padding: '8px 28px' }}
            >
              現金付款
            </span>
            <div className="flex flex-col w-full" style={{ gap: 14 }}>
              <div className="flex justify-between items-baseline text-sg-ink" style={{ fontSize: 32 }}>
                <span>收您</span>
                <b className="font-num font-extrabold" style={{ fontSize: 44 }}>
                  {formatMoney(cashReceived)}
                </b>
              </div>
              <div className="flex justify-between items-baseline text-sg-ink" style={{ fontSize: 32 }}>
                <span>應付</span>
                <b className="font-num font-extrabold" style={{ fontSize: 44 }}>
                  {formatMoney(dueAmount)}
                </b>
              </div>
              <div
                data-testid="display-cash-change"
                className="flex justify-between items-baseline bg-sg-honey-soft"
                style={{ borderRadius: 18, padding: '14px 22px', fontSize: 32 }}
              >
                <span>找您</span>
                <b className="font-num font-extrabold text-sg-honey-ink" style={{ fontSize: 64 }}>
                  {formatMoney(change)}
                </b>
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center" style={{ gap: 18 }}>
          <span
            data-testid="display-pay-state"
            className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
            style={{ fontSize: 30, padding: '8px 28px' }}
          >
            {effectiveMethodLabel || '現金付款'}
          </span>
          <p className="text-sg-ink m-0" style={{ fontSize: 34, lineHeight: 1.45 }}>
            請依店員指示
            <br />
            完成現金付款
          </p>
        </div>
      );
    }

    if (effectiveMethodKey === 'transfer') {
      const useRawImage = Boolean(twqr?.use_raw_image && twqr?.raw_image_url);
      const payload = checkout.twqr_payload || twqr?.payload || '';
      const otherMethods = enabledMethods.filter(m => m.key !== 'transfer').map(m => m.label);

      if (!useRawImage && !payload) {
        return (
          <div className="flex flex-col items-center" style={{ gap: 18 }}>
            <span
              data-testid="display-pay-state"
              className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
              style={{ fontSize: 30, padding: '8px 28px' }}
            >
              轉帳付款
            </span>
            <p className="text-sg-danger m-0" style={{ fontSize: 32, lineHeight: 1.5 }}>
              還沒有設定收款條碼，
              {otherMethods.length > 0 ? (
                <>
                  <br />
                  請改用{otherMethods.join('或')}
                </>
              ) : (
                '請洽櫃檯店員'
              )}
            </p>
          </div>
        );
      }

      const logoEnabled = twqr?.logo_enabled !== false;
      const logoSrc = resolveApiImageUrl(twqr?.logo_url) || '/brand/twqr.png';

      return (
        <div className="flex flex-col items-center" style={{ gap: 18 }}>
          <span
            data-testid="display-pay-state"
            className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
            style={{ fontSize: 30, padding: '8px 28px' }}
          >
            轉帳付款
          </span>
          {useRawImage ? (
            <div
              data-testid="display-twqr-box"
              className="bg-white overflow-hidden"
              style={{ width: 330, height: 330, borderRadius: 16 }}
            >
              <img
                src={resolveApiImageUrl(twqr.raw_image_url)}
                alt="收款條碼"
                className="w-full h-full object-contain block"
              />
            </div>
          ) : (
            <DisplayQrCode
              testId="display-twqr-box"
              text={payload}
              ecc="H"
              size={330}
              showLogo={logoEnabled}
              logoSrc={logoSrc}
              className="rounded-2xl"
            />
          )}
          <p className="text-sg-ink m-0" style={{ fontSize: 26, lineHeight: 1.45 }}>
            支援 TWQR 的銀行 App、
            <br />
            電子支付 App 都能掃碼付款
          </p>
        </div>
      );
    }

    if (effectiveMethodKey === 'linepay' || effectiveMethodKey === 'line_pay') {
      return (
        <div className="flex flex-col items-center" style={{ gap: 18 }}>
          <span
            data-testid="display-pay-state"
            className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
            style={{ fontSize: 30, padding: '8px 28px' }}
          >
            {effectiveMethodLabel || 'LINE Pay'}
          </span>
          <p className="text-sg-ink m-0" style={{ fontSize: 34, lineHeight: 1.45 }}>
            請打開 LINE Pay 付款碼，
            <br />
            給店員掃描
          </p>
        </div>
      );
    }

    // Any other enabled custom payment method (e.g. card)
    return (
      <div className="flex flex-col items-center" style={{ gap: 18 }}>
        <span
          data-testid="display-pay-state"
          className="font-body font-bold text-sg-paper bg-sg-brown rounded-full"
          style={{ fontSize: 30, padding: '8px 28px' }}
        >
          {effectiveMethodLabel}
        </span>
        <p className="text-sg-ink m-0" style={{ fontSize: 34, lineHeight: 1.45 }}>
          請依店員指示
          <br />
          完成付款
        </p>
      </div>
    );
  };

  return (
    <div
      data-testid="display-checkout-view"
      className="absolute grid"
      style={{
        left: 64,
        right: 64,
        top: 150,
        bottom: 48,
        gridTemplateColumns: '1fr 520px',
        gap: 30
      }}
    >
      {/* Left: Bill & Per-person cards */}
      <div
        className="bg-sg-paper relative overflow-hidden flex flex-col"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
          padding: '40px 56px 36px',
          gap: 14
        }}
      >
        <div>
          <h2 className="font-display font-bold text-sg-ink m-0" style={{ fontSize: 56, lineHeight: 1.2 }}>
            {checkout.table_label || '座位'} · {checkout.pax || people.length} 位
          </h2>
          <span className="text-sg-muted block mt-1" style={{ fontSize: 28 }}>
            {isSplit
              ? `分開結帳：這次結第 ${dueNos.join('、')} 位`
              : '一起結帳'}
          </span>
        </div>

        <div
          className="grid flex-1 min-h-0"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
            gap: 18
          }}
        >
          {people.map(p => (
            <div
              key={p.person_no}
              data-testid={`display-checkout-person-${p.person_no}`}
              className="bg-sg-bg flex flex-col min-w-0"
              style={{
                borderRadius: 24,
                padding: '22px 22px 18px',
                gap: 10,
                opacity: p.paid ? 0.45 : 1
              }}
            >
              <div
                className="flex items-baseline border-b-2 border-dashed border-sg-line"
                style={{ gap: 12, paddingBottom: 10 }}
              >
                <b className="font-display font-bold text-sg-ink" style={{ fontSize: 36 }}>
                  第 {p.person_no} 位
                </b>
                {p.seat_code && (
                  <span className="font-num font-extrabold text-sg-muted" style={{ fontSize: 24 }}>
                    {p.seat_code}
                  </span>
                )}
                {p.paid && (
                  <em
                    className="not-italic ml-auto font-body font-bold text-sg-sage-ink bg-sg-sage-soft rounded-full"
                    style={{ fontSize: 22, padding: '2px 14px' }}
                  >
                    已付
                  </em>
                )}
              </div>

              {perPerson !== false && Array.isArray(p.lines) && (
                <div className="flex flex-col flex-1 overflow-hidden" style={{ gap: 8 }}>
                  {p.lines.map((line, idx) => (
                    <div
                      key={idx}
                      className="grid items-center"
                      style={{
                        gridTemplateColumns: 'auto 1fr',
                        gap: '2px 12px',
                        fontSize: 21
                      }}
                    >
                      <i
                        className="not-italic font-body font-bold text-sg-brown bg-sg-brown-soft"
                        style={{ fontSize: 19, padding: '1px 10px', borderRadius: 8 }}
                      >
                        {line.kind}
                      </i>
                      <b
                        className="font-num font-extrabold justify-self-end"
                        style={{
                          fontSize: 28,
                          color: (Number(line.amount) || 0) < 0 ? '#5F7A55' : '#3E332B'
                        }}
                      >
                        {formatMoney(line.amount)}
                      </b>
                      {line.desc && (
                        <span
                          className="text-sg-muted min-w-0 truncate"
                          style={{ gridColumn: '1 / -1', gridRow: 2, lineHeight: 1.35 }}
                        >
                          {line.desc}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div
                className="mt-auto flex justify-between items-baseline border-t-2 border-sg-line"
                style={{ paddingTop: 10 }}
              >
                <span className="font-display font-bold text-sg-muted" style={{ fontSize: 26 }}>
                  小計
                </span>
                <b className="font-num font-extrabold text-sg-brown" style={{ fontSize: 44 }}>
                  {formatMoney(p.subtotal ?? p.total)}
                </b>
              </div>
            </div>
          ))}
        </div>

        {checkout.summary_note && (
          <p className="m-0 text-sg-muted" style={{ fontSize: 23 }}>
            {checkout.summary_note}
          </p>
        )}
      </div>

      {/* Right: Amount due + Payment Panel */}
      <div
        className="bg-sg-paper relative overflow-hidden flex flex-col items-center justify-center text-center"
        style={{
          borderRadius: 40,
          boxShadow: '0 10px 30px rgba(139,91,67,0.08)',
          padding: '36px 40px',
          gap: 18
        }}
      >
        <div
          className="w-full flex flex-col items-center border-b-2 border-dashed border-sg-line"
          style={{ gap: 2, paddingBottom: 14 }}
        >
          <span className="text-sg-muted" style={{ fontSize: 25 }}>
            本次結帳{dueNos.length > 0 ? ` · 第 ${dueNos.join('、')} 位` : ''}
          </span>
          <b
            data-testid="display-checkout-due-total"
            className="font-num font-extrabold text-sg-brown"
            style={{ fontSize: 84, lineHeight: 1 }}
          >
            {formatMoney(dueAmount)}
          </b>
        </div>

        {renderPayPanel()}
      </div>
    </div>
  );
}

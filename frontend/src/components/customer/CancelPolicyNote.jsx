import React from 'react';
import { Info } from 'lucide-react';
import { SoftBox } from './Banners';

export const DEFAULT_CANCEL_POLICY =
  '線上預約於開始前皆可免費取消；如已報到、已付款或需於開始後協助調整，請透過官方 LINE 或電話聯絡門市。\n' +
  '自費／半自助預付時段若逾期未完成匯款與回報，系統將自動釋出名額並退回計次卡次數；對帳確認後若需退改，請聯絡店家協助處理。';

export default function CancelPolicyNote({
  globalSettings,
  title = '取消與退款規則',
  showHeading = true,
  className = '',
  'data-testid': testId = 'cancel-policy-note',
}) {
  const policyText = String(globalSettings?.cancel_policy_text || '').trim() || DEFAULT_CANCEL_POLICY;

  return (
    <SoftBox data-testid={testId} className={`text-[12.5px] leading-[1.6] text-sg-ink ${className}`}>
      {showHeading && (
        <div className="flex items-center gap-1.5 font-bold text-sg-ink mb-1">
          <Info className="w-3.5 h-3.5 text-sg-brown shrink-0" />
          <span>{title}</span>
        </div>
      )}
      <div className="whitespace-pre-line text-sg-muted">{policyText}</div>
    </SoftBox>
  );
}

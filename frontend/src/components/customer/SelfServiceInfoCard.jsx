import React from 'react';
import { ironText as buildIronText } from '../../../../shared/selfService.js';

export default function SelfServiceInfoCard({
  title = '這天是半自助時段',
  ironText = null,
  ironMode = 'today',
  ironDate = null,
  date = null,
  earlyMinutes = 30,
  deadlineHour = 12,
  showPaymentLine = true,
  className = '',
}) {
  const resolvedIronText =
    ironText || buildIronText({ iron_mode: ironMode, iron_date: ironDate, date });
  const deadlineStr = `${String(deadlineHour ?? 12).padStart(2, '0')}:00`;

  return (
    <div
      data-testid="self-service-info-card"
      className={`rounded-[16px] border border-sg-honey bg-sg-honey-soft p-3.5 text-sg-ink grid gap-2 ${className}`}
    >
      <div className="text-[15px] font-bold text-sg-ink">{title}</div>
      <ul className="grid gap-1.5 text-[13.5px] leading-[1.5]">
        <li className="grid grid-cols-[3.6em_minmax(0,1fr)] gap-2">
          <b className="text-sg-honey-ink font-bold">對象</b>
          <span className="min-w-0 break-words">僅限已經會玩拼豆的朋友</span>
        </li>
        <li className="grid grid-cols-[3.6em_minmax(0,1fr)] gap-2">
          <b className="text-sg-honey-ink font-bold">教學</b>
          <span className="min-w-0 break-words">當天部分時段沒有店員，無法現場教學</span>
        </li>
        <li className="grid grid-cols-[3.6em_minmax(0,1fr)] gap-2">
          <b className="text-sg-honey-ink font-bold">熨燙</b>
          <span className="min-w-0 break-words">{resolvedIronText}</span>
        </li>
        <li className="grid grid-cols-[3.6em_minmax(0,1fr)] gap-2">
          <b className="text-sg-honey-ink font-bold">進場</b>
          <span className="min-w-0 break-words">
            憑預約條碼或電話在門口報到機報到，最早可提前 {earlyMinutes ?? 30} 分鐘進場
          </span>
        </li>
        {showPaymentLine && (
          <li className="grid grid-cols-[3.6em_minmax(0,1fr)] gap-2">
            <b className="text-sg-honey-ink font-bold">付款</b>
            <span className="min-w-0 break-words">
              需在前一日 {deadlineStr} 前完成付款，可用匯款或計次不限時卡
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

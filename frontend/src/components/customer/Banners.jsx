import React from 'react';
import { Info, Megaphone, AlertCircle, Check } from 'lucide-react';

export function InfoBanner({ children, message, text, icon, className = '' }) {
  const content = children || message || text;
  if (!content) {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      console.warn('InfoBanner: no content provided');
    }
    return null;
  }
  return (
    <div
      className={`flex items-center gap-2 rounded-[14px] bg-sg-peach-soft px-3 py-[10px] text-[13px] text-sg-ink ${className}`}
    >
      <span className="shrink-0 text-sg-peach-ink">
        {icon || <Info className="w-[18px] h-[18px]" strokeWidth={2} />}
      </span>
      <div className="flex-1 leading-snug">{content}</div>
    </div>
  );
}

export function WarnBanner({ children, message, text, icon, className = '' }) {
  const content = children || message || text;
  if (!content) return null;
  return (
    <div
      className={`flex items-center gap-2 rounded-[14px] bg-sg-honey-soft px-3 py-[10px] text-[13px] text-sg-honey-ink ${className}`}
    >
      <span className="shrink-0 text-sg-honey">
        {icon || <AlertCircle className="w-[18px] h-[18px]" strokeWidth={2} />}
      </span>
      <div className="flex-1 leading-snug">{content}</div>
    </div>
  );
}

export function AnnouncementBar({ text, children, className = '' }) {
  const content = text || children;
  if (!content) return null;
  return (
    <div
      className={`flex items-center gap-2 rounded-[14px] bg-sg-peach-soft px-3 py-[10px] text-[13px] text-sg-ink ${className}`}
    >
      <span className="shrink-0 text-sg-peach-ink">
        <Megaphone className="w-[18px] h-[18px]" strokeWidth={2} />
      </span>
      <div className="flex-1 leading-snug">{content}</div>
    </div>
  );
}

export function ErrorBanner({ message, children, className = '' }) {
  const content = message || children;
  if (!content) return null;
  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-[14px] border border-[#EBC9BF] bg-[#FBEDE8] px-3 py-[10px] text-[13px] text-sg-danger whitespace-pre-line ${className}`}
    >
      <span className="shrink-0 pt-0.5">
        <AlertCircle className="w-[18px] h-[18px]" strokeWidth={2} />
      </span>
      <div className="flex-1 leading-snug">{content}</div>
    </div>
  );
}

export function SaveBanner({ children, text, className = '' }) {
  const content = text || children;
  return (
    <div
      className={`flex items-center gap-2 rounded-[12px] bg-sg-sage-soft px-3 py-2 text-[12px] font-bold leading-[1.5] text-sg-sage-ink ${className}`}
    >
      <span className="shrink-0">
        <Check className="w-4 h-4" strokeWidth={2.5} />
      </span>
      <div className="flex-1">{content}</div>
    </div>
  );
}

export function NoticeBox({ children, title, className = '' }) {
  return (
    <div
      className={`rounded-[10px] border border-sg-line bg-sg-paper px-[10px] py-2 text-[12px] text-sg-muted leading-[1.5] ${className}`}
    >
      {title && <span className="font-bold text-sg-ink mr-1">{title}</span>}
      {children}
    </div>
  );
}

export function SoftBox({ children, className = '' }) {
  return (
    <div
      className={`rounded-[10px] bg-sg-bg px-[10px] py-2 text-[12px] text-sg-muted leading-[1.5] ${className}`}
    >
      {children}
    </div>
  );
}

export default InfoBanner;

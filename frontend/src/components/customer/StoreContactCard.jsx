import React from 'react';
import { MessageCircle, Phone } from 'lucide-react';
import { safeHttpUrl } from '@shared/safeUrl.js';
import { useGlobalSettings } from '../../hooks/customer/useGlobalSettings';

export default function StoreContactCard({
  globalSettings: propSettings,
  urgent = false,
  title = '',
  message = '',
  showLine = true,
  showPhone = true,
  lineLabel = '透過 LINE 聯絡我們',
  className = '',
}) {
  const { settings: hookSettings } = useGlobalSettings();
  const settings = propSettings ?? hookSettings;

  const lineUrl = showLine
    ? (safeHttpUrl(settings?.line_button_url) || safeHttpUrl(settings?.official_line_url))
    : null;
  const rawPhone = showPhone && settings?.store_phone ? String(settings.store_phone).trim() : '';
  const telHref = rawPhone ? `tel:${rawPhone.replace(/[\s-]+/g, '')}` : null;

  if (!lineUrl && !telHref) return null;

  return (
    <div
      data-testid={urgent ? 'store-contact-card-urgent' : 'store-contact-card'}
      className={`rounded-[14px] p-3.5 grid gap-2 ${
        urgent
          ? 'border-2 border-sg-danger bg-sg-danger-soft text-sg-ink'
          : 'border border-sg-line bg-sg-paper/90 text-sg-ink'
      } ${className}`}
    >
      {title && (
        <div className={`font-bold leading-snug ${urgent ? 'text-[15.5px] text-sg-danger' : 'text-[14px] text-sg-ink'}`}>
          {title}
        </div>
      )}
      {message && (
        <div className="text-[13px] text-sg-muted leading-relaxed">
          {message}
        </div>
      )}
      <div className="grid gap-2 pt-0.5">
        {lineUrl && (
          <a
            href={lineUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="store-contact-line-btn"
            className={`inline-flex items-center justify-center gap-1.5 rounded-[12px] bg-[#06C755] text-white font-bold transition ${
              urgent ? 'text-[15px] py-3 px-4 shadow-sm' : 'text-[13.5px] py-2.5 px-3.5'
            }`}
          >
            <MessageCircle className="w-4 h-4 shrink-0" />
            {lineLabel}
          </a>
        )}
        {telHref && (
          <a
            href={telHref}
            data-testid="store-contact-phone-btn"
            className={`inline-flex items-center justify-center gap-1.5 rounded-[12px] border font-bold transition ${
              urgent
                ? 'border-sg-danger/50 bg-white text-sg-ink text-[15px] py-3 px-4'
                : 'border-sg-line bg-sg-paper text-sg-ink text-[13.5px] py-2.5 px-3.5'
            }`}
          >
            <Phone className="w-4 h-4 shrink-0 text-sg-brown" />
            打電話給店家（{rawPhone}）
          </a>
        )}
      </div>
    </div>
  );
}

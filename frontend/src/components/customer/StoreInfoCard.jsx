import React from 'react';
import { MapPin, Clock, Phone, ExternalLink } from 'lucide-react';
import { Card } from './Card';
import { safeHttpUrl } from '@shared/safeUrl.js';
import { formatPhone } from '../../utils/customer/format';

export default function StoreInfoCard({
  globalSettings,
  title = '門市資訊',
  className = '',
  'data-testid': testId = 'store-info-card',
}) {
  const address = String(globalSettings?.store_address || '').trim();
  const rawMapUrl = safeHttpUrl(globalSettings?.store_map_url);
  const mapUrl = rawMapUrl && rawMapUrl.startsWith('https://') ? rawMapUrl : null;
  const hoursText = String(globalSettings?.store_hours_text || '').trim();
  const phone = String(globalSettings?.store_phone || '').trim();
  const cleanTel = phone.replace(/[^\d+]/g, '');

  if (!address && !mapUrl && !hoursText && !phone) {
    return null;
  }

  return (
    <Card gap={8} data-testid={testId} className={className}>
      <div className="flex items-center gap-1.5 text-[14px] font-bold text-sg-ink">
        <MapPin className="w-4 h-4 text-sg-brown shrink-0" />
        <span>{title}</span>
      </div>

      <div className="grid gap-2 text-[13px] text-sg-ink">
        {(address || mapUrl) && (
          <div className="flex items-start justify-between gap-2">
            <span className="whitespace-pre-line">{address || '查看門市位置'}</span>
            {mapUrl && (
              <a
                href={mapUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="store-map-link"
                className="text-sg-brown font-bold hover:underline inline-flex items-center gap-1 shrink-0"
              >
                打開地圖
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        )}

        {hoursText && (
          <div className="flex items-start gap-1.5 text-sg-muted">
            <Clock className="w-3.5 h-3.5 text-sg-muted shrink-0 mt-0.5" />
            <span className="whitespace-pre-line">{hoursText}</span>
          </div>
        )}

        {phone && (
          <div className="flex items-center gap-1.5 text-sg-muted">
            <Phone className="w-3.5 h-3.5 text-sg-muted shrink-0" />
            {cleanTel ? (
              <a
                href={`tel:${cleanTel}`}
                className="font-num font-bold text-sg-brown hover:underline"
              >
                {formatPhone(phone)}
              </a>
            ) : (
              <span className="font-num font-bold text-sg-ink">{formatPhone(phone)}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

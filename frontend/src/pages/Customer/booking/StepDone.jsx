import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, QrCode } from 'lucide-react';
import { Card, Divider } from '../../../components/customer/Card';
import Button from '../../../components/customer/Button';
import BarcodeSheet from '../../../components/customer/sheets/BarcodeSheet';
import { useToast } from '../../../components/customer/Toast';
import { formatBookingRef, formatDateShort, weekdayChar, formatYMD } from '../../../utils/customer/format';
import { getGoogleCalendarUrl, downloadIcsFile } from '../../../utils/calendarHelper';

export default function StepDone({ result }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [showBarcode, setShowBarcode] = useState(false);

  const reservation = result?.reservation || result || {};
  const bookingRef = reservation.booking_ref || '';
  const dateStr = reservation.session_date || reservation.session?.session_date || '';
  const pax = reservation.pax || 1;
  const isUnlimited = !!reservation.is_unlimited;

  // Time range calculation
  let startTime = reservation.start_time || reservation.session?.start_time || '';
  let endTime = reservation.end_time || reservation.session?.end_time || '';
  if (Array.isArray(reservation.sessions) && reservation.sessions.length > 0) {
    const sorted = [...reservation.sessions].sort((a, b) => a.start_time.localeCompare(b.start_time));
    startTime = sorted[0].start_time;
    endTime = sorted[sorted.length - 1].end_time;
  }

  // Equipment summary
  const eqSummary = (reservation.equipments || [])
    .filter((e) => e.equipment_id !== 'bring_own')
    .map((e) => `${e.name || '智能板'} ×${e.quantity}`)
    .join('、');

  // Formatted date string
  const cleanDateStr = formatYMD(dateStr);
  const dateParts = cleanDateStr ? cleanDateStr.split('-') : [];
  const monthDay = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : '';
  const weekday = cleanDateStr ? `週${weekdayChar(cleanDateStr)}` : '';

  // Summary line: e.g. "12:00 到 18:00 · 2 位 · 中板 ×1"
  let summaryDetails = isUnlimited
    ? `${startTime} 到 ${endTime} · 不限時 · ${pax} 位`
    : `${startTime} 到 ${endTime} · ${pax} 位`;
  if (eqSummary) {
    summaryDetails += ` · ${eqSummary}`;
  }

  const handleCopyRef = async () => {
    const formatted = formatBookingRef(bookingRef);
    try {
      await navigator.clipboard.writeText(formatted);
      toast.show('已複製預約編號', { type: 'success' });
    } catch (e) {
      toast.show(formatted, { type: 'info' });
    }
  };

  const barcodeSummaryText = `${cleanDateStr ? formatDateShort(cleanDateStr) : ''} ${startTime} 到 ${endTime} · ${pax} 位`;

  return (
    <div className="flex flex-col flex-1">
      {/* 1. Hero checkmark */}
      <div className="flex flex-col items-center justify-center py-4 text-center">
        <div className="h-14 w-14 rounded-full bg-sg-sage text-white grid place-items-center shadow-sg-pop mb-1">
          <Check className="w-[30px] h-[30px]" strokeWidth={2.4} />
        </div>
        <p className="text-[13px] text-sg-muted">
          感謝預約，我們期待您的到來！
        </p>
      </div>

      {/* 2. Content */}
      <div className="grid gap-3 px-4 pt-4 pb-5 flex-1">
        <Card gap={6}>
          {/* Date line */}
          <div className="flex items-baseline">
            <span className="font-num font-extrabold text-[24px] leading-[1.2] text-sg-ink mr-2">
              {monthDay}
            </span>
            <span className="font-body text-[15px] font-bold text-sg-ink">
              {weekday}
            </span>
          </div>

          {/* Time & pax & equipment */}
          <div className="text-[14px] text-sg-ink leading-[1.4]">
            {summaryDetails}
          </div>

          <Divider className="my-[6px]" />

          {/* Booking Ref + Copy */}
          <div className="flex justify-between items-center">
            <div>
              <div className="sg-small">預約編號</div>
              <div className="font-num font-extrabold tracking-[.04em] text-[18px] text-sg-ink">
                {formatBookingRef(bookingRef)}
              </div>
            </div>
            <Button
              variant="text"
              size="sm"
              icon={<Copy className="w-4 h-4" />}
              onClick={handleCopyRef}
              className="text-sg-brown"
            >
              複製
            </Button>
          </div>
        </Card>

        {/* Small Notice */}
        <div className="sg-small px-1">
          到店時出示條碼就能報到。要改時間的話，先取消再重新預約。
        </div>

        {/* Add to Calendar */}
        <div className="flex items-center justify-center gap-1 sg-small text-sg-muted mt-2">
          <span>加入行事曆：</span>
          <a
            href={getGoogleCalendarUrl(reservation)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sg-brown font-bold hover:underline px-1 py-0.5"
          >
            Google
          </a>
          <span>·</span>
          <button
            type="button"
            onClick={() => downloadIcsFile(reservation)}
            className="text-sg-brown font-bold hover:underline px-1 py-0.5"
          >
            Apple
          </button>
        </div>
      </div>

      {/* 3. Fixed Bottom Area */}
      <div className="sticky bottom-0 z-40 bg-sg-paper border-t border-sg-line px-4 pt-3 pb-[max(18px,env(safe-area-inset-bottom))] grid gap-2">
        <Button
          variant="primary"
          size="md"
          icon={<QrCode className="w-5 h-5" />}
          onClick={() => setShowBarcode(true)}
          className="w-full"
        >
          查看到店條碼
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => navigate('/history?tab=bookings')}
          className="w-full"
        >
          回到我的預約
        </Button>
      </div>

      {/* Barcode Sheet */}
      <BarcodeSheet
        isOpen={showBarcode}
        onClose={() => setShowBarcode(false)}
        bookingRef={bookingRef}
        summaryText={barcodeSummaryText}
      />
    </div>
  );
}

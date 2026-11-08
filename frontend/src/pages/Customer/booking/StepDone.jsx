import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Check, Copy, QrCode } from 'lucide-react';
import { Card, Divider } from '../../../components/customer/Card';
import Button from '../../../components/customer/Button';
import BarcodeSheet from '../../../components/customer/sheets/BarcodeSheet';
import { BeadLoader } from '../../../components/customer/Bead';
import { useToast } from '../../../components/customer/Toast';
import { formatBookingRef, formatDateShort, weekdayChar, formatYMD } from '../../../utils/customer/format';
import { shortBoardName } from '../../../utils/customer/pricing';
import { getGoogleCalendarUrl, downloadIcsFile } from '../../../utils/calendarHelper';
import api from '../../../api/axios';

export default function StepDone({ result }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const [showBarcode, setShowBarcode] = useState(false);

  const refParam = searchParams.get('ref') || result?.reservation?.booking_ref || result?.booking_ref || '';
  const initialRes = (result?.reservation && result.reservation.session_date) ? result.reservation : null;

  const [reservation, setReservation] = useState(initialRes);
  const [loading, setLoading] = useState(!initialRes);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let isMounted = true;
    if (!refParam) {
      if (!initialRes) {
        setNotFound(true);
        setLoading(false);
      }
      return;
    }

    setLoading(true);
    api.get('/reservations/my')
      .then((res) => {
        if (!isMounted) return;
        const list = Array.isArray(res.data) ? res.data : (res.data?.reservations || []);
        const found = list.find((r) => r.booking_ref === refParam);
        if (found) {
          setReservation(found);
          setNotFound(false);
        } else if (!initialRes) {
          setNotFound(true);
        }
      })
      .catch((err) => {
        console.error('Failed to load my reservations on done step', err);
        if (!isMounted) return;
        if (!initialRes) {
          setNotFound(true);
        }
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [refParam, initialRes]);

  if (loading) {
    return (
      <div className="flex flex-col flex-1">
        <div className="flex flex-col items-center justify-center py-12 text-center flex-1">
          <BeadLoader />
          <p className="text-[13px] text-sg-muted mt-3">載入預約資訊中...</p>
        </div>
      </div>
    );
  }

  if (notFound || !reservation) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center flex-1">
        <div className="text-[18px] font-bold text-sg-ink mb-2">找不到這筆預約</div>
        <p className="text-[14px] text-sg-muted mb-6">請確認預約編號是否正確，或至「我的預約」查看。</p>
        <Button variant="primary" onClick={() => navigate('/history?tab=bookings')}>
          回到我的預約
        </Button>
      </div>
    );
  }

  const bookingRef = reservation.booking_ref || refParam || '';
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
  const filteredEquipments = (reservation.equipments || []).filter(
    (e) => (e.equipment_id || e.id) !== 'bring_own'
  );
  const eqSummary = filteredEquipments
    .map((e) => {
      const name = shortBoardName(e.equipment_name_snapshot || e.name || '智能板');
      let timeSpan = '';
      let hours = e.rental_hours || 0;
      if (Array.isArray(e.covered_sessions) && e.covered_sessions.length > 0) {
        const first = e.covered_sessions[0];
        const last = e.covered_sessions[e.covered_sessions.length - 1];
        const st = first.includes('-') ? first.split('-')[0] : first;
        const et = last.includes('-') ? last.split('-')[1] : last;
        timeSpan = `${st} 到 ${et}`;
        hours = e.covered_sessions.length;
      } else if (startTime && e.rental_hours) {
        const [sh, sm] = startTime.split(':').map(Number);
        const eh = sh + e.rental_hours;
        timeSpan = `${startTime} 到 ${String(eh).padStart(2, '0')}:${String(sm || 0).padStart(2, '0')}`;
      }
      let discountNote = '';
      if (hours >= 4) {
        const freeH = Math.floor(hours / 4);
        const chargeable = hours - freeH;
        discountNote = `，買三送一，以 ${chargeable} 小時計`;
      }
      const timePart = timeSpan ? ` · ${timeSpan} · ${hours} 小時` : ` · ${hours} 小時`;
      return `${name} ×${e.quantity || 1}${timePart}${discountNote ? `（${discountNote.replace(/^，/, '')}）` : ''}`;
    })
    .join('、');

  // Formatted date string
  const cleanDateStr = formatYMD(dateStr);
  const dateShort = cleanDateStr ? formatDateShort(cleanDateStr) : '';
  const dateParts = cleanDateStr ? cleanDateStr.split('-') : [];
  const monthDay = dateParts.length === 3 ? `${dateParts[1]}/${dateParts[2]}` : '';
  const weekday = cleanDateStr ? `週${weekdayChar(cleanDateStr)}` : '';

  // Summary line: e.g. "11/10 週二 14:00 到 17:00 · 2 位 · 中板 ×1"
  let summaryDetails = `${startTime} 到 ${endTime} · ${isUnlimited ? '不限時 · ' : ''}${pax} 位`;
  if (eqSummary) {
    summaryDetails += ` · ${eqSummary}`;
  }

  const barcodeSummaryText = `${dateShort ? `${dateShort} ` : ''}${summaryDetails}`;

  const handleCopyRef = async () => {
    const formatted = formatBookingRef(bookingRef);
    try {
      await navigator.clipboard.writeText(formatted);
      toast.show('已複製預約編號', { type: 'success' });
    } catch (e) {
      toast.show(formatted, { type: 'info' });
    }
  };

  const calendarRes = {
    ...reservation,
    session_date: cleanDateStr,
    start_time: startTime,
    end_time: endTime,
    pax,
    booking_ref: bookingRef,
  };

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
      <div className="grid gap-2.5 px-4 pt-2 pb-4 flex-1">
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

          {/* Time & pax & equipment with test id */}
          <div className="text-[15px] font-bold text-sg-ink leading-[1.4]" data-testid="booking-summary-text">
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
        <div className="sg-small px-1 text-sg-muted">
          到店時出示條碼就能報到。要改時間的話，先取消再重新預約。
        </div>

        {/* Add to Calendar */}
        <div className="flex items-center justify-center gap-1 sg-small text-sg-muted mt-1">
          <span>加入行事曆：</span>
          <a
            href={getGoogleCalendarUrl(calendarRes)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sg-brown font-bold hover:underline px-1 py-0.5"
          >
            Google
          </a>
          <span>·</span>
          <button
            type="button"
            onClick={() => downloadIcsFile(calendarRes)}
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

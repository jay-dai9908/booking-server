import React, { useEffect } from 'react';
import { Sun, Copy } from 'lucide-react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';
import { useToast } from '../Toast';
import { generateCode128Svg } from '../../../utils/barcodeHelper';
import { formatBookingRef } from '../../../utils/customer/format';

/**
 * BarcodeSheet (Section 6.14)
 * Modal bottom sheet displaying Code128 barcode for in-store check-in or pass redemption.
 */
export default function BarcodeSheet({
  isOpen,
  onClose,
  bookingRef = '',
  summaryText = '',
  isPass = false,
  passCode = '',
  passName = '',
}) {
  const toast = useToast();

  const rawCode = isPass ? passCode : bookingRef;
  const formattedCode = isPass ? passCode : formatBookingRef(bookingRef);
  const title = isPass ? '卡券條碼' : '到店條碼';
  const subtitle = isPass ? passName : summaryText;
  const copyBtnText = isPass ? '複製卡券編號' : '複製預約編號';
  const copySuccessToast = isPass ? '已複製卡券編號' : '已複製預約編號';

  // Request screen wakeLock while barcode is open
  useEffect(() => {
    if (!isOpen) return;
    let wakeLock = null;
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      navigator.wakeLock
        .request('screen')
        .then((w) => {
          wakeLock = w;
        })
        .catch(() => {});
    }
    return () => {
      if (wakeLock) {
        wakeLock.release().catch(() => {});
      }
    };
  }, [isOpen]);

  const handleCopy = async () => {
    if (!formattedCode) return;
    try {
      await navigator.clipboard.writeText(formattedCode);
      toast.show(copySuccessToast, { type: 'success' });
    } catch (e) {
      toast.show(formattedCode, { type: 'info' });
    }
  };

  const barcodeSvgHtml = rawCode ? generateCode128Svg(rawCode, 64) : '';

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title}>
      <div className="grid justify-items-center text-center gap-[14px] pb-[10px] min-w-0 w-full">
        {subtitle && (
          <div className="text-[13px] text-sg-muted -mt-1">
            {subtitle}
          </div>
        )}

        <div className="grid w-full justify-items-center gap-2 rounded-[16px] border border-sg-line bg-white px-[14px] pt-4 pb-[10px]">
          {barcodeSvgHtml ? (
            <div
              className="max-w-full overflow-hidden flex justify-center [&_svg]:max-w-full [&_svg]:h-[64px]"
              dangerouslySetInnerHTML={{ __html: barcodeSvgHtml }}
            />
          ) : (
            <div className="h-[64px] flex items-center justify-center text-sg-muted">
              無條碼
            </div>
          )}
          <div className="font-num font-extrabold text-[18px] tracking-[.08em] text-sg-ink">
            {formattedCode}
          </div>
        </div>

        <div className="flex items-center gap-[6px] text-[13px] text-sg-muted">
          <Sun className="w-4 h-4 text-sg-muted" />
          <span>請把螢幕調亮，讓櫃檯掃描</span>
        </div>

        <Button
          variant="secondary"
          size="sm"
          icon={<Copy className="w-4 h-4" />}
          onClick={handleCopy}
          className="w-full"
        >
          {copyBtnText}
        </Button>
      </div>
    </BottomSheet>
  );
}

import React from 'react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';

/**
 * SplitSeatSheet (Section 6.12)
 * Displayed when backend returns 409 seating split warning.
 */
export default function SplitSeatSheet({
  isOpen,
  onClose,
  onConfirmForceSplit,
  onBackToSelectTime,
  loading = false,
  splitKind = 'split',
  pax = 2,
  isSelfService = false,
}) {
  let title = '同行的人可能要分桌坐';
  let body = '這段時間沒有相鄰的座位，會安排在不同桌，現場人員會再協助調整。';

  if (isSelfService) {
    title = '這段時間座位比較滿';
    body = '當天請自由選擇空位入座。仍要預約嗎？';
  } else if (Number(pax) <= 1 || splitKind === 'no_seat') {
    title = '這段時間座位已排滿';
    body = '線上名額還有，但座位已經排滿，到店後由現場人員安排座位，可能需要稍等。';
  }

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title}>
      <div className="grid gap-3 min-w-0">
        <p className="text-[14px] leading-[1.5] text-sg-ink">
          {body}
        </p>
        {!isSelfService && (
          <p className="sg-small">
            仍要預約嗎？也可以回去換一個時段。
          </p>
        )}

        <div className="grid gap-2 mt-2">
          <Button
            variant="primary"
            size="md"
            loading={loading}
            onClick={onConfirmForceSplit}
            className="w-full"
          >
            仍要預約
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={onBackToSelectTime}
            className="w-full"
          >
            回去換時段
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

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
}) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="同行的人可能會分開坐">
      <div className="grid gap-3">
        <p className="text-[14px] leading-[1.5] text-sg-ink">
          這段時間已經沒有相鄰的座位，同行的人會由現場人員安排分開入座。
        </p>
        <p className="sg-small">
          仍要預約嗎？也可以回去換一個時段。
        </p>

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

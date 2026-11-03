import React from 'react';
import BottomSheet from '../BottomSheet';
import Button from '../Button';

/**
 * ConfirmSheet (Section 6.9)
 * Used for confirming dangerous actions such as reservation cancellation.
 */
export default function ConfirmSheet({
  isOpen,
  onClose,
  onConfirm,
  title = '確定取消這筆預約？',
  summary = '',
  description = '取消後名額會釋出，需要的話請重新預約。',
  confirmText = '確定取消',
  cancelText = '先不要',
  confirmVariant = 'danger',
  loading = false,
}) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={title}>
      <div className="grid gap-3 min-w-0">
        {summary && (
          <div className="text-[14px] font-bold text-sg-ink">
            {summary}
          </div>
        )}
        {description && (
          <div className="sg-small">
            {description}
          </div>
        )}

        <div className="grid gap-2 mt-2">
          <Button
            variant={confirmVariant}
            size="md"
            loading={loading}
            onClick={onConfirm}
            className="w-full"
          >
            {confirmText}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading}
            onClick={onClose}
            className="w-full"
          >
            {cancelText}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

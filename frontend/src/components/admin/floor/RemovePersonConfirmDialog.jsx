import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import Button from '../../customer/Button';

/**
 * 「這位不玩了」確認對話框（Round 23 Item 3）
 */
export default function RemovePersonConfirmDialog({
  isOpen = false,
  onClose,
  elapsedMinutes = 0,
  hasBoard = false,
  onConfirmRemove,
  onSwitchToLeave
}) {
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const mins = Math.max(0, Math.floor(Number(elapsedMinutes) || 0));
  const message = hasBoard
    ? `已計時 ${mins} 分鐘。這位會從訂單移除、不收費，座位空出來，智能板一起歸還。如果客人有玩、只是先走，請改用「離場」，照計時收費。`
    : `已計時 ${mins} 分鐘。這位會從訂單移除、不收費，座位空出來。如果客人有玩、只是先走，請改用「離場」，照計時收費。`;

  const handleConfirm = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      await onConfirmRemove?.();
      onClose?.();
    } finally {
      setSubmitting(false);
    }
  };

  const handleLeave = async () => {
    if (submitting) return;
    try {
      setSubmitting(true);
      await onSwitchToLeave?.();
      onClose?.();
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid="remove-person-confirm-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) {
          onClose?.();
        }
      }}
    >
      <div className="w-full max-w-[350px] bg-white rounded-2xl shadow-2xl border border-sg-line p-5 space-y-4">
        <div className="space-y-2">
          <h4 className="text-[16px] font-bold text-sg-ink">確定移除這位？</h4>
          <p className="text-[13px] leading-relaxed text-sg-ink/90" data-testid="remove-person-confirm-message">
            {message}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Button
            variant="danger"
            size="md"
            className="w-full font-bold"
            disabled={submitting}
            data-testid="remove-person-confirm-btn"
            onClick={handleConfirm}
          >
            {submitting ? '處理中…' : '確定移除這位'}
          </Button>
          <Button
            variant="secondary"
            size="md"
            className="w-full font-bold"
            disabled={submitting}
            data-testid="remove-person-leave-btn"
            onClick={handleLeave}
          >
            改成離場（照計時收）
          </Button>
          <Button
            variant="text"
            size="md"
            className="w-full font-bold text-sg-muted"
            disabled={submitting}
            data-testid="remove-person-cancel-btn"
            onClick={() => !submitting && onClose?.()}
          >
            先不要
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

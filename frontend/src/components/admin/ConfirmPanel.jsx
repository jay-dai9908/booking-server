import React from 'react';
import { createPortal } from 'react-dom';
import Button from '../customer/Button';

export default function ConfirmPanel({
  isOpen = false,
  onClose,
  onConfirm,
  title = '確認操作',
  message = '',
  confirmText = '確認',
  cancelText = '取消',
  danger = false,
  loading = false,
  children
}) {
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/45 backdrop-blur-[2px] animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-sm bg-white rounded-2xl p-5 shadow-2xl border border-sg-line animate-in zoom-in-95 duration-150">
        <h4 className="text-[17px] font-bold text-sg-ink">{title}</h4>
        {message && <p className="text-[13px] text-sg-muted mt-2 leading-relaxed">{message}</p>}
        {children && <div className="mt-3">{children}</div>}

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            {cancelText}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            onClick={onConfirm}
            loading={loading}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

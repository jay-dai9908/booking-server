import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function BottomSheet({
  isOpen = false,
  onClose,
  title = '',
  subtitle = '',
  children,
  size = 'normal', // 'normal' | 'tall'
  dismissible = true,
  className = '',
  headerRight,
  footer,
  gap = 3,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    // Body scroll lock
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // History state for back button closing
    const stateKey = `sheet_${Date.now()}`;
    window.history.pushState({ [stateKey]: true }, '');

    const handlePopState = () => {
      if (dismissible && onClose) {
        onClose();
      }
    };
    window.addEventListener('popstate', handlePopState);

    // Esc key handling
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && dismissible && onClose) {
        window.history.back();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = origOverflow;
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, dismissible, onClose]);

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget && dismissible && onClose) {
      window.history.back();
    }
  };

  const handleCloseBtn = () => {
    if (dismissible && onClose) {
      window.history.back();
    }
  };

  const isTall = size === 'tall';

  const modalContent = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 bg-[rgba(42,35,30,0.45)] animate-fade-in flex flex-col justify-end"
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className={`fixed inset-x-0 bottom-0 z-[51] mx-auto w-full max-w-[480px] rounded-t-[22px] bg-sg-paper shadow-2xl animate-sheet-up flex flex-col ${
          isTall
            ? 'top-14 h-[calc(100dvh-56px)]'
            : 'max-h-[88dvh]'
        } ${className}`}
      >
        {/* Handle */}
        <div className="pt-[10px] pb-1 flex justify-center shrink-0">
          <div className="h-1 w-10 rounded-[2px] bg-sg-line" aria-hidden="true" />
        </div>

        {/* Title Bar */}
        <div className="flex items-center justify-between px-4 pb-2 pt-1 border-b border-sg-line shrink-0">
          <div className="min-w-0 pr-2">
            <h2 className="text-[17px] font-bold text-sg-ink truncate">
              {title}
            </h2>
            {subtitle && (
              <p className="text-[12px] text-sg-muted truncate mt-0.5">
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {headerRight}
            {dismissible && (
              <button
                type="button"
                onClick={handleCloseBtn}
                aria-label="關閉"
                className="-mr-2 h-11 w-11 grid place-items-center rounded-full text-sg-muted hover:text-sg-ink hover:bg-sg-brown-soft/40 transition active:scale-[0.98]"
              >
                <X className="w-[18px] h-[18px]" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div
          className={`flex-1 overflow-y-auto overscroll-contain px-4 py-3 grid ${
            gap === 2 ? 'gap-2' : gap === 3 ? 'gap-3' : 'gap-[10px]'
          }`}
        >
          {children}
        </div>

        {/* Footer (if provided, sticky to panel bottom) */}
        {footer && (
          <div className="p-4 pt-2 pb-[max(18px,env(safe-area-inset-bottom))] border-t border-sg-line bg-sg-paper shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

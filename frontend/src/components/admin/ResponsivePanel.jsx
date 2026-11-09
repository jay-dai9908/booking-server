import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import ErrorBoundary from '../common/ErrorBoundary';

export default function ResponsivePanel({
  isOpen = false,
  onClose,
  title = '',
  subtitle = '',
  children,
  width = 440, // desktop slide-over width in px
  dismissible = true,
  className = '',
  headerRight = null,
  footer = null
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;

    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && dismissible && onClose) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = origOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, dismissible, onClose]);

  if (!isOpen) return null;

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget && dismissible && onClose) {
      onClose();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end md:items-stretch md:justify-end bg-black/40 transition-opacity"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
    >
      {/* Panel container */}
      <style>{`
        @media (min-width: 768px) {
          .responsive-panel-w-${width} {
            width: ${typeof width === 'number' ? `${width}px` : width} !important;
          }
        }
      `}</style>
      <div
        ref={panelRef}
        style={{ maxWidth: '100%' }}
        className={`w-full md:w-[${width}px] responsive-panel-w-${width} bg-white rounded-t-[20px] md:rounded-none md:rounded-l-[20px] shadow-2xl flex flex-col max-h-[92vh] md:max-h-full overflow-hidden animate-in slide-in-from-bottom md:slide-in-from-right duration-200 ${className}`}
      >
        {/* Mobile drag handle bar */}
        <div className="md:hidden flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 bg-sg-line rounded-full" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-sg-line flex-shrink-0">
          <div>
            <h3 className="text-[17px] font-bold text-sg-ink leading-tight">{title}</h3>
            {subtitle && <p className="text-[12px] text-sg-muted mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            {headerRight}
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                className="w-9 h-9 flex items-center justify-center rounded-full text-sg-muted hover:text-sg-ink hover:bg-sg-paper transition active:scale-95"
                aria-label="關閉"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 min-h-0">
          <ErrorBoundary>
            {children}
          </ErrorBoundary>
        </div>

        {/* Footer */}
        {footer && (
          <div className="p-4 border-t border-sg-line bg-sg-paper/40 flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

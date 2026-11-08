import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo.jsx';

export default function AppBar({
  variant = 'brandTwoLine',
  subtitle = '',
  right,
  onBack,
  className = '',
}) {
  const navigate = useNavigate();

  if (!subtitle && typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    console.warn('AppBar: missing subtitle prop');
  }

  const isBack = variant === 'back' || variant === 'backTwoLine';

  const handleBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate(-1);
    }
  };

  return (
    <header
      className={`sticky top-0 z-30 flex items-center gap-2 bg-sg-paper border-b border-sg-line px-4 pb-[10px] pt-[max(14px,env(safe-area-inset-top))] ${className}`}
    >
      {isBack ? (
        <button
          type="button"
          onClick={handleBack}
          aria-label="返回"
          className="-ml-2 h-11 w-11 grid place-items-center rounded-full text-sg-ink hover:bg-sg-brown-soft/40 transition active:scale-[0.98]"
        >
          <ChevronLeft className="w-[22px] h-[22px]" strokeWidth={1.75} />
        </button>
      ) : (
        <BrandLogo size="mark" className="shrink-0" />
      )}

      <div className="grid leading-tight min-w-0">
        <span className="font-display text-[18px] leading-[1.25] font-bold text-sg-ink truncate">
          拾光製所
        </span>
        <span className="text-[12px] font-medium text-sg-muted leading-[1.25] truncate">
          {subtitle}
        </span>
      </div>

      <div className="flex-1" />

      {right && <div className="shrink-0 flex items-center">{right}</div>}
    </header>
  );
}

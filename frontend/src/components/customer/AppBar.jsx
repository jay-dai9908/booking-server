import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import BrandLogo from './BrandLogo.jsx';

export default function AppBar({
  variant = 'brand',
  title = '',
  subtitle = '',
  right,
  onBack,
  className = '',
}) {
  const navigate = useNavigate();

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
      {variant === 'back' ? (
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

      {variant === 'brandTwoLine' ? (
        <div className="grid leading-tight min-w-0">
          <span className="font-display text-[18px] leading-[1.25] font-bold text-sg-ink truncate">
            拾光製所
          </span>
          <span className="text-[12px] font-medium text-sg-muted leading-[1.25] truncate">
            {subtitle || '拼豆時段預覽'}
          </span>
        </div>
      ) : (
        <h1 className="text-[16px] font-bold leading-[1.4] text-sg-ink truncate min-w-0">
          {title}
        </h1>
      )}

      <div className="flex-1" />

      {right && <div className="shrink-0 flex items-center">{right}</div>}
    </header>
  );
}

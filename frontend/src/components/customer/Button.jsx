import React from 'react';
import LineIcon from './LineIcon.jsx';
import { BeadLoader } from './Bead.jsx';

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  className = '',
  type = 'button',
  onClick,
  ...props
}) {
  const isDisabled = disabled || loading;

  let variantClasses = '';
  switch (variant) {
    case 'primary':
      variantClasses = isDisabled
        ? 'bg-sg-full text-white cursor-not-allowed'
        : 'bg-sg-brown text-white hover:bg-sg-brown-hover active:bg-sg-brown-hover';
      break;
    case 'secondary':
      variantClasses = isDisabled
        ? 'bg-sg-paper text-sg-full border-[1.5px] border-sg-line cursor-not-allowed'
        : 'bg-sg-paper text-sg-brown border-[1.5px] border-sg-line hover:bg-sg-brown-soft active:bg-sg-brown-soft';
      break;
    case 'line':
      variantClasses = isDisabled
        ? 'bg-sg-line-green/60 text-white cursor-not-allowed'
        : 'bg-sg-line-green text-white font-bold hover:brightness-95 active:brightness-90';
      break;
    case 'text':
      variantClasses = isDisabled
        ? 'bg-transparent text-sg-full cursor-not-allowed min-h-[44px] px-2 -mx-2'
        : 'bg-transparent text-sg-brown font-bold text-[13px] hover:text-sg-brown-hover active:text-sg-brown-hover min-h-[44px] px-2 -mx-2';
      break;
    case 'dangerText':
      variantClasses = isDisabled
        ? 'bg-transparent text-sg-full cursor-not-allowed min-h-[44px] px-2 -mx-2'
        : 'bg-transparent text-sg-danger font-bold text-[14px] hover:opacity-80 active:opacity-75 min-h-[44px] px-2 -mx-2';
      break;
    case 'danger':
      variantClasses = isDisabled
        ? 'bg-sg-full text-white cursor-not-allowed'
        : 'bg-sg-danger text-white hover:brightness-95 active:brightness-90';
      break;
    default:
      variantClasses = 'bg-sg-brown text-white';
  }

  const isTextLike = variant === 'text' || variant === 'dangerText';
  const sizeClasses = isTextLike
    ? ''
    : size === 'sm'
    ? 'min-h-[44px] px-4 text-[14px]'
    : 'min-h-[48px] px-5 text-[16px]';

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading ? 'true' : undefined}
      onClick={isDisabled ? undefined : onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-full font-bold font-body select-none transition ${
        isDisabled ? '' : 'active:scale-[0.98]'
      } focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sg-brown ${sizeClasses} ${variantClasses} ${className}`}
      {...props}
    >
      {loading ? (
        <span className="flex items-center justify-center min-w-[72px]">
          <BeadLoader size="sm" />
        </span>
      ) : (
        <>
          {variant === 'line' && !icon && <LineIcon className="w-5 h-5 shrink-0" />}
          {icon && <span className="shrink-0">{icon}</span>}
          <span>{children}</span>
        </>
      )}
    </button>
  );
}

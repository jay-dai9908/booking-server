import React from 'react';
import Button from './Button';
import { initiateLineOAuth } from '../../utils/lineAuth';

export default function GuestLineLoginButton({
  globalSettings,
  className = '',
  buttonClassName = '',
  hintClassName = '',
  size = 'md',
  label = '加入官方 LINE 預約',
  showHint = true,
  returnPath = '/booking',
  onClick,
  ...props
}) {
  const officialLineUrl = globalSettings?.official_line_url;
  const hintText =
    globalSettings?.guest_line_hint_text ||
    '會打開拾光製所的官方 LINE，從選單點『預約』就能登入';

  const handleClick = (e) => {
    if (onClick) onClick(e);
    if (!officialLineUrl) {
      console.warn('official_line_url is not configured, falling back to LINE Login');
      initiateLineOAuth({ returnPath });
    }
  };

  return (
    <div className={`w-full flex flex-col items-center ${className}`}>
      <Button
        variant="line"
        size={size}
        href={officialLineUrl || undefined}
        target={officialLineUrl ? '_blank' : undefined}
        rel={officialLineUrl ? 'noopener noreferrer' : undefined}
        onClick={handleClick}
        className={`w-full ${buttonClassName}`}
        data-testid="guest-line-login-button"
        {...props}
      >
        {label}
      </Button>
      {showHint && hintText && (
        <div
          data-testid="guest-line-hint-text"
          className={`sg-small text-center text-sg-muted mt-1.5 px-2 ${hintClassName}`}
        >
          {hintText}
        </div>
      )}
    </div>
  );
}

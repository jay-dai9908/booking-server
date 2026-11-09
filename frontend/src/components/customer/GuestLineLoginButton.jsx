import React from 'react';
import Button from './Button';
import { initiateLineOAuth, getGuestLineAction } from '../../utils/lineAuth';

export default function GuestLineLoginButton({
  globalSettings,
  page = 'home',
  action: propAction,
  className = '',
  buttonClassName = '',
  hintClassName = '',
  size = 'md',
  label,
  showHint,
  returnPath = '/booking',
  onClick,
  ...props
}) {
  const action = propAction || getGuestLineAction(page);
  const isLoginAction = action === 'login';

  const officialLineUrl = globalSettings?.official_line_url;
  const hintText =
    globalSettings?.guest_line_hint_text ||
    '會打開拾光製所的官方 LINE，從選單點『預約』就能登入';

  const buttonText = label || (isLoginAction ? '使用 LINE 登入預約' : '加入官方 LINE 預約');
  const shouldShowHint = showHint !== undefined ? showHint : !isLoginAction;

  const handleClick = (e) => {
    if (onClick) onClick(e);
    if (isLoginAction) {
      initiateLineOAuth({ returnPath });
    } else {
      if (!officialLineUrl) {
        console.warn('official_line_url is not configured, falling back to LINE Login');
        initiateLineOAuth({ returnPath });
      }
    }
  };

  return (
    <div className={`w-full flex flex-col items-center ${className}`}>
      <Button
        variant="line"
        size={size}
        href={!isLoginAction ? (officialLineUrl || undefined) : undefined}
        target={!isLoginAction && officialLineUrl ? '_blank' : undefined}
        rel={!isLoginAction && officialLineUrl ? 'noopener noreferrer' : undefined}
        onClick={handleClick}
        className={`w-full ${buttonClassName}`}
        data-testid="guest-line-login-button"
        {...props}
      >
        {buttonText}
      </Button>
      {shouldShowHint && hintText && (
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

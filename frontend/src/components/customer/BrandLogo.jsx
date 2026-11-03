import React from 'react';

export default function BrandLogo({ size = 'mark', className = '' }) {
  if (size === 'mark') {
    return (
      <img
        src="/logo.png"
        alt=""
        className={`h-7 w-7 rounded-full object-cover shadow-[0_0_0_1px_#E6DDD2] ${className}`}
      />
    );
  }

  let sizeClasses = 'h-16 w-16'; // sm: 64px
  if (size === 'lg' || size === 132) sizeClasses = 'h-[132px] w-[132px]';
  else if (size === 'md' || size === 112) sizeClasses = 'h-[112px] w-[112px]';
  else if (size === 'sm' || size === 64) sizeClasses = 'h-16 w-16';

  return (
    <img
      src="/logo.png"
      alt="拾光製所 Gathering Light 品牌標誌"
      className={`rounded-full object-cover shadow-[0_0_0_4px_#FFFDF9,0_2px_10px_rgba(62,51,43,0.12)] ${sizeClasses} ${className}`}
    />
  );
}

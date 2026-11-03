import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Calendar, ShoppingBag, User } from 'lucide-react';

export default function BottomTabBar({
  shopEnabled = true,
  className = '',
}) {
  const location = useLocation();
  const pathname = location.pathname;

  const isBookingActive = pathname.startsWith('/booking');
  const isShopActive = pathname.startsWith('/shop') || pathname.startsWith('/preorder');
  const isHistoryActive = pathname.startsWith('/history');

  const colsClass = shopEnabled ? 'grid-cols-3' : 'grid-cols-2';

  return (
    <nav
      aria-label="底部分頁導覽"
      className={`grid ${colsClass} bg-sg-paper border-t border-sg-line pt-2 pb-[max(10px,env(safe-area-inset-bottom))] w-full select-none ${className}`}
    >
      <NavLink
        to="/booking"
        aria-current={isBookingActive ? 'page' : undefined}
        className={`grid justify-items-center gap-[2px] min-h-[48px] content-center transition ${
          isBookingActive ? 'text-sg-brown font-bold' : 'text-sg-muted'
        }`}
      >
        <Calendar className="w-5 h-5" strokeWidth={1.75} />
        <span className="text-[12px] leading-[1.3]">預約</span>
      </NavLink>

      {shopEnabled && (
        <NavLink
          to="/shop"
          aria-current={isShopActive ? 'page' : undefined}
          className={`grid justify-items-center gap-[2px] min-h-[48px] content-center transition ${
            isShopActive ? 'text-sg-brown font-bold' : 'text-sg-muted'
          }`}
        >
          <ShoppingBag className="w-5 h-5" strokeWidth={1.75} />
          <span className="text-[12px] leading-[1.3]">商城</span>
        </NavLink>
      )}

      <NavLink
        to="/history"
        aria-current={isHistoryActive ? 'page' : undefined}
        className={`grid justify-items-center gap-[2px] min-h-[48px] content-center transition ${
          isHistoryActive ? 'text-sg-brown font-bold' : 'text-sg-muted'
        }`}
      >
        <User className="w-5 h-5" strokeWidth={1.75} />
        <span className="text-[12px] leading-[1.3]">我的</span>
      </NavLink>
    </nav>
  );
}

import React from 'react';
import { NavLink } from 'react-router-dom';
import { Grid, Users, ShoppingBag, Menu } from 'lucide-react';

export default function AdminTabBar({
  onMoreClick,
  badges = {},
  className = ''
}) {
  const tabs = [
    {
      to: '/admin/seating',
      label: '帶位',
      icon: Grid,
      badge: badges.today_pending_checkin > 0 ? badges.today_pending_checkin : null
    },
    {
      to: '/admin/reservations',
      label: '訂單',
      icon: Users,
      badge: badges.today_unpaid > 0 ? badges.today_unpaid : null
    },
    {
      to: '/admin/shop',
      label: '預購',
      icon: ShoppingBag,
      badge: badges.shop_pending_verify > 0 ? badges.shop_pending_verify : null
    }
  ];

  return (
    <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-sg-line pb-[env(safe-area-inset-bottom)] ${className}`}>
      <div className="h-[56px] grid grid-cols-4 items-center">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center h-full select-none transition ${
                  isActive ? 'text-sg-brown' : 'text-sg-muted hover:text-sg-ink'
                }`
              }
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {tab.badge && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-sg-peach text-white text-[10px] font-bold flex items-center justify-center leading-none">
                    {tab.badge}
                  </span>
                )}
              </div>
              <span className="text-[11px] font-medium mt-1">{tab.label}</span>
            </NavLink>
          );
        })}

        <button
          type="button"
          onClick={onMoreClick}
          className="flex flex-col items-center justify-center h-full select-none text-sg-muted hover:text-sg-ink transition active:scale-95"
        >
          <Menu className="w-5 h-5" />
          <span className="text-[11px] font-medium mt-1">更多</span>
        </button>
      </div>
    </nav>
  );
}

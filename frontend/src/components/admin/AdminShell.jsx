import React, { useState, useEffect, Suspense, lazy } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Grid,
  Layers,
  Users,
  ShoppingBag,
  Printer,
  UserCog,
  Ticket,
  CalendarRange,
  Cpu,
  CalendarDays,
  Banknote,
  Settings,
  ShieldCheck,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Smartphone
} from 'lucide-react';
import api from '../../api/axios';
import AdminAppBar from './AdminAppBar';
import AdminTabBar from './AdminTabBar';
import ResponsivePanel from './ResponsivePanel';

const QuickPosLookupModal = lazy(() => import('../QuickPosLookupModal'));

export default function AdminShell({ children, title = '拾光製所', subtitle = null, actions = null, adminInfo: initialAdminInfo = null }) {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    return localStorage.getItem('sg-sidebar-collapsed') === '1';
  });
  const [showMoreSheet, setShowMoreSheet] = useState(false);
  const [showQuickLookup, setShowQuickLookup] = useState(false);
  const [showDeviceNameModal, setShowDeviceNameModal] = useState(false);
  const [deviceLabel, setDeviceLabel] = useState(() => localStorage.getItem('sg-device-label') || '');
  const [adminInfo, setAdminInfo] = useState(initialAdminInfo);
  const [navBadges, setNavBadges] = useState({
    today_total_groups: 0,
    today_pending_checkin: 0,
    today_unpaid: 0,
    shop_pending_verify: 0,
    shop_arrived_unpicked: 0
  });

  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (initialAdminInfo) {
      setAdminInfo(initialAdminInfo);
    } else {
      fetchAdminInfo();
    }
    fetchNavBadges();
    const handleDataUpdated = () => fetchNavBadges();
    window.addEventListener('admin-data-updated', handleDataUpdated);
    return () => window.removeEventListener('admin-data-updated', handleDataUpdated);
  }, [initialAdminInfo]);

  useEffect(() => {
    fetchNavBadges();
  }, [location.pathname]);

  const fetchAdminInfo = async () => {
    try {
      const res = await api.get('/auth/me');
      setAdminInfo(res.data);
    } catch (e) {}
  };

  const fetchNavBadges = async () => {
    try {
      const res = await api.get('/reservations/admin/nav-badges');
      if (res.data) setNavBadges(res.data);
    } catch (e) {}
  };

  const toggleSidebar = () => {
    const next = !isCollapsed;
    setIsCollapsed(next);
    localStorage.setItem('sg-sidebar-collapsed', next ? '1' : '0');
  };

  const handleLogout = async () => {
    try {
      sessionStorage.removeItem('shiguang_auth_token');
      await api.post('/auth/logout');
      window.location.href = '/admin/login';
    } catch (e) {
      window.location.href = '/admin/login';
    }
  };

  const handleSaveDeviceLabel = (e) => {
    e.preventDefault();
    const clean = deviceLabel.trim().slice(0, 20);
    setDeviceLabel(clean);
    if (clean) {
      localStorage.setItem('sg-device-label', clean);
    } else {
      localStorage.removeItem('sg-device-label');
    }
    setShowDeviceNameModal(false);
  };

  const allNavLinks = [
    { to: '/admin/seating', perm: 'seating', group: '現場櫃檯營運', icon: Grid, label: '今日帶位', badge: navBadges.today_pending_checkin },
    { to: '/admin/seat-layout', perm: 'seating', group: '現場櫃檯營運', icon: Layers, label: '座位設定' },
    { to: '/admin/reservations', perm: 'reservations', group: '現場櫃檯營運', icon: Users, label: '預約訂單總覽', badge: navBadges.today_unpaid },
    { to: '/admin/shop', perm: 'shop', fallbackPerm: 'reservations', group: '現場櫃檯營運', icon: ShoppingBag, label: '商品預購與對帳', badge: navBadges.shop_pending_verify },
    { to: '/admin/print-station', perm: 'reservations', fallbackPerm: 'settings', group: '現場櫃檯營運', icon: Printer, label: '商米出單機' },

    { to: '/admin/members', perm: 'members', group: '顧客與行銷', icon: UserCog, label: '會員管理' },
    { to: '/admin/coupons', perm: 'coupons', fallbackPerm: 'accounting', group: '顧客與行銷', icon: Ticket, label: '卡券與優惠管理' },

    { to: '/admin/sessions', perm: 'sessions', group: '排班與設備', icon: CalendarRange, label: '營業時段設定' },
    { to: '/admin/equipment', perm: 'equipment', fallbackPerm: 'sessions', group: '排班與設備', icon: Cpu, label: '智能板庫存管理' },
    { to: '/admin/weekly', perm: 'weekly', group: '排班與設備', icon: CalendarDays, label: '周營業狀況' },

    { to: '/admin/accounting', perm: 'accounting', group: '帳務與系統', icon: Banknote, label: '帳務管理' },
    { to: '/admin/settings', perm: 'settings', fallbackPerm: 'sessions', group: '帳務與系統', icon: Settings, label: '系統全域設定' },
    { to: '/admin/staff', perm: 'staff', superAdminOnly: true, group: '帳務與系統', icon: ShieldCheck, label: '人員權限管理' }
  ];

  const userPerms = adminInfo?.permissions || [];
  const isSuper = adminInfo?.isSuperAdmin || userPerms.includes('all');

  const visibleLinks = allNavLinks.filter((item) => {
    if (isSuper) return true;
    if (item.superAdminOnly) return false;
    return userPerms.includes(item.perm) || (item.fallbackPerm && userPerms.includes(item.fallbackPerm));
  });

  const groupedLinks = visibleLinks.reduce((acc, item) => {
    if (!acc[item.group]) acc[item.group] = [];
    acc[item.group].push(item);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-sg-bg text-sg-ink flex flex-col md:flex-row font-sans">
      {/* Tablet & Desktop Left Rail Sidebar */}
      <aside
        className={`hidden md:flex flex-col bg-white border-r border-sg-line transition-all duration-200 z-30 select-none flex-shrink-0 ${
          isCollapsed ? 'w-16' : 'w-56'
        }`}
      >
        {/* Brand Header */}
        <div className="h-[56px] px-4 border-b border-sg-line flex items-center justify-between">
          {!isCollapsed && (
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-sg-brown" />
              <span className="font-bold text-[15px] tracking-tight text-sg-ink">拾光製所 後台</span>
            </div>
          )}
          {isCollapsed && (
            <div className="mx-auto">
              <span className="w-3 h-3 rounded-full bg-sg-brown block" />
            </div>
          )}
        </div>

        {/* Navigation list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {Object.entries(groupedLinks).map(([groupName, items]) => (
            <div key={groupName} className="space-y-1">
              {!isCollapsed && (
                <div className="px-2.5 py-1 text-[11px] font-bold text-sg-muted uppercase tracking-wider">
                  {groupName}
                </div>
              )}
              {items.map((item) => {
                const Icon = item.icon;
                const isActive = location.pathname.startsWith(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={isCollapsed ? item.label : undefined}
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-bold transition ${
                      isActive
                        ? 'bg-sg-brown-soft text-sg-brown'
                        : 'text-sg-ink/75 hover:bg-sg-paper hover:text-sg-ink'
                    } ${isCollapsed ? 'justify-center px-0' : ''}`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    {!isCollapsed && <span className="truncate flex-1">{item.label}</span>}
                    {!isCollapsed && item.badge ? (
                      <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-sg-peach text-white leading-none">
                        {item.badge}
                      </span>
                    ) : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </div>

        {/* Sidebar Footer: Collapse Toggle & Staff Info */}
        <div className="p-2 border-t border-sg-line space-y-1">
          <button
            type="button"
            onClick={toggleSidebar}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[12px] text-sg-muted hover:text-sg-ink hover:bg-sg-paper transition ${
              isCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {!isCollapsed && <span>收合選單</span>}
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-[12px] text-sg-danger hover:bg-sg-danger-soft transition ${
              isCollapsed ? 'justify-center px-0' : ''
            }`}
          >
            <LogOut className="w-4 h-4" />
            {!isCollapsed && <span>登出 ({adminInfo?.name || '管理員'})</span>}
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 pb-[70px] md:pb-0">
        <AdminAppBar
          title={title !== '拾光製所' ? title : (allNavLinks.find(l => location.pathname.startsWith(l.to))?.label || '拾光製所')}
          subtitle={subtitle}
          onSearchClick={() => setShowQuickLookup(true)}
          actions={actions}
        />

        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      {/* Mobile Bottom TabBar (<768px) */}
      <AdminTabBar
        badges={navBadges}
        onMoreClick={() => setShowMoreSheet(true)}
      />

      {/* Mobile "More" Responsive Panel */}
      <ResponsivePanel
        isOpen={showMoreSheet}
        onClose={() => setShowMoreSheet(false)}
        title="更多選單"
        subtitle={adminInfo?.name ? `登入為：${adminInfo.name}` : null}
      >
        <div className="space-y-4 py-2">
          {Object.entries(groupedLinks).map(([groupName, items]) => (
            <div key={groupName} className="space-y-1">
              <div className="px-2 text-[12px] font-bold text-sg-muted">{groupName}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname.startsWith(item.to);
                  return (
                    <button
                      key={item.to}
                      type="button"
                      onClick={() => {
                        setShowMoreSheet(false);
                        navigate(item.to);
                      }}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border text-[13px] font-bold transition text-left ${
                        isActive
                          ? 'bg-sg-brown text-white border-sg-brown'
                          : 'bg-sg-paper text-sg-ink border-sg-line'
                      }`}
                    >
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="pt-3 border-t border-sg-line space-y-2">
            <button
              type="button"
              onClick={() => {
                setShowMoreSheet(false);
                setShowDeviceNameModal(true);
              }}
              className="w-full flex items-center justify-between p-3 rounded-xl bg-sg-paper border border-sg-line text-[13px] font-bold text-sg-ink"
            >
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-sg-muted" />
                <span>這台裝置的名稱</span>
              </div>
              <span className="text-[12px] text-sg-muted font-normal">
                {deviceLabel || '未設定（依型號識別）'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 p-3 rounded-xl bg-sg-danger-soft border border-sg-danger/20 text-[13px] font-bold text-sg-danger"
            >
              <LogOut className="w-4 h-4" />
              <span>登出</span>
            </button>
          </div>
        </div>
      </ResponsivePanel>

      {/* Device Name Setting Modal */}
      <ResponsivePanel
        isOpen={showDeviceNameModal}
        onClose={() => setShowDeviceNameModal(false)}
        title="這台裝置的名稱"
        subtitle="設定後將會記錄在收款、異動與列印單中（如「小安的手機」）"
      >
        <form onSubmit={handleSaveDeviceLabel} className="space-y-4 py-2">
          <div>
            <label className="block text-[13px] font-bold text-sg-ink mb-1.5">裝置名稱（最多 20 字）</label>
            <input
              type="text"
              value={deviceLabel}
              onChange={(e) => setDeviceLabel(e.target.value.slice(0, 20))}
              placeholder="例如：小安的手機、櫃檯平板"
              className="w-full px-3 py-2 rounded-xl border border-sg-line text-[14px] text-sg-ink bg-white focus:outline-none focus:border-sg-brown focus:ring-1 focus:ring-sg-brown"
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowDeviceNameModal(false)}
              className="px-4 py-2 rounded-xl text-[13px] font-bold text-sg-muted hover:bg-sg-paper"
            >
              取消
            </button>
            <button
              type="submit"
              className="px-5 py-2 rounded-xl text-[13px] font-bold bg-sg-brown text-white hover:bg-sg-brown-hover"
            >
              儲存
            </button>
          </div>
        </form>
      </ResponsivePanel>

      {/* Quick Lookup Modal */}
      {showQuickLookup && (
        <Suspense fallback={null}>
          <QuickPosLookupModal
            isOpen={showQuickLookup}
            onClose={() => setShowQuickLookup(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

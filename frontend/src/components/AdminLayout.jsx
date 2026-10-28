import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { 
  Users, 
  CalendarRange, 
  Menu, 
  X, 
  LogOut, 
  UserCog, 
  CalendarDays, 
  Grid, 
  Banknote,
  ShieldCheck,
  User,
  Cpu,
  Ticket,
  Settings,
  ShoppingBag
} from 'lucide-react';
import api from '../api/axios';

export default function AdminLayout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [adminInfo, setAdminInfo] = useState(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    fetchAdminInfo();
  }, []);

  const fetchAdminInfo = async () => {
    try {
      const res = await api.get('/auth/me');
      setAdminInfo(res.data);
    } catch (err) {
      console.error('Failed to get admin info:', err);
    } finally {
      setIsLoadingInfo(false);
    }
  };

  const handleLogout = async () => {
    try {
      try {
        sessionStorage.removeItem('shiguang_auth_token');
      } catch (e) {}
      await api.post('/auth/logout');
      window.location.href = '/admin/login';
    } catch (err) {
      console.error(err);
    }
  };

  const allNavLinks = [
    { to: '/admin/sessions', perm: 'sessions', icon: <CalendarRange className="w-5 h-5" />, label: '營業時段設定' },
    { to: '/admin/reservations', perm: 'reservations', icon: <Users className="w-5 h-5" />, label: '預約訂單總覽' },
    { to: '/admin/shop', perm: 'shop', fallbackPerm: 'reservations', icon: <ShoppingBag className="w-5 h-5" />, label: '商品預購與對帳' },
    { to: '/admin/equipment', perm: 'equipment', fallbackPerm: 'sessions', icon: <Cpu className="w-5 h-5" />, label: '智能板庫存管理' },
    { to: '/admin/coupons', perm: 'coupons', fallbackPerm: 'accounting', icon: <Ticket className="w-5 h-5" />, label: '卡券與優惠管理' },
    { to: '/admin/members', perm: 'members', icon: <UserCog className="w-5 h-5" />, label: '會員管理' },
    { to: '/admin/weekly', perm: 'weekly', icon: <CalendarDays className="w-5 h-5" />, label: '周營業狀況' },
    { to: '/admin/seating', perm: 'seating', icon: <Grid className="w-5 h-5" />, label: '帶位圖管理' },
    { to: '/admin/accounting', perm: 'accounting', icon: <Banknote className="w-5 h-5" />, label: '帳務管理' },
    { to: '/admin/settings', perm: 'settings', fallbackPerm: 'sessions', icon: <Settings className="w-5 h-5" />, label: '系統全域設定' },
    { to: '/admin/staff', perm: 'staff', superAdminOnly: true, icon: <ShieldCheck className="w-5 h-5" />, label: '人員權限管理' },
  ];

  // Filter allowed navigation links
  const allowedLinks = allNavLinks.filter(link => {
    if (!adminInfo) return false;
    if (adminInfo.isSuperAdmin) return true;
    if (link.superAdminOnly) return false;
    return Array.isArray(adminInfo.permissions) && (
      adminInfo.permissions.includes(link.perm) || 
      (link.fallbackPerm && adminInfo.permissions.includes(link.fallbackPerm))
    );
  });

  // Guard: if current path is forbidden or root /admin, redirect to first allowed route
  useEffect(() => {
    if (!isLoadingInfo && adminInfo && allowedLinks.length > 0) {
      const currentPath = location.pathname;
      const isAllowed = allowedLinks.some(link => link.to === currentPath);
      if (!isAllowed) {
        navigate(allowedLinks[0].to, { replace: true });
      }
    }
  }, [isLoadingInfo, adminInfo, location.pathname, allowedLinks]);

  const SidebarContent = () => (
    <>
      {/* Brand & User Header */}
      <div className="p-6 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center shrink-0">
            <img src="/logo.png" alt="Logo" className="w-6 h-6 object-contain" />
          </div>
          <div className="min-w-0">
            <span className="text-lg font-bold text-[#3E332B] tracking-tight block truncate">
              拾光製所
            </span>
            <span className="text-xs text-gray-400 block">系統管理中心</span>
          </div>
        </div>

        {/* Current Staff Badge */}
        {adminInfo && (
          <div className="mt-4 p-3 bg-amber-50/40 border border-[#E8DEC8]/60 rounded-xl flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-[#8B5B43] text-white flex items-center justify-center font-bold text-xs shrink-0">
                {adminInfo.name?.charAt(0) || <User className="w-3.5 h-3.5" />}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-bold text-gray-800 truncate">
                  {adminInfo.name || '管理員'}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  {adminInfo.isSuperAdmin ? '最高管理員' : '工作人員'}
                </div>
              </div>
            </div>
            {adminInfo.isSuperAdmin && (
              <span className="text-[10px] bg-[#8B5B43]/10 text-[#8B5B43] px-1.5 py-0.5 rounded font-semibold shrink-0">
                全權限
              </span>
            )}
          </div>
        )}
      </div>

      {/* Navigation List */}
      <nav className="flex-1 px-4 py-3 space-y-1.5 overflow-y-auto">
        {allowedLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={() => setIsSidebarOpen(false)}
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 text-sm ${
                isActive
                  ? 'bg-[#FAF7F2] text-[#8B5B43] font-bold border border-[#E8DEC8] shadow-sm'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`
            }
          >
            {link.icon}
            {link.label}
          </NavLink>
        ))}
      </nav>

      {/* Footer / Logout */}
      <div className="p-4 border-t border-gray-100">
        <button 
          onClick={handleLogout} 
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm text-gray-500 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
        >
          <LogOut className="w-4 h-4" />
          登出系統
        </button>
      </div>
    </>
  );

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex font-sans selection:bg-[#8B5B43]/20">
      {/* Mobile Sidebar Overlay */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-gray-900/20 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-gray-200 flex flex-col transition-transform duration-300 md:relative md:translate-x-0 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Mobile Header */}
        <header className="md:hidden bg-white border-b border-gray-200 px-4 py-3.5 flex items-center justify-between z-30 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#FAF7F2] border border-[#E8DEC8] flex items-center justify-center shrink-0">
              <img src="/logo.png" alt="Logo" className="w-5 h-5 object-contain" />
            </div>
            <div>
              <span className="font-bold text-gray-900 text-sm">拾光製所 後台</span>
              {adminInfo && (
                <span className="text-[11px] text-gray-500 block">
                  {adminInfo.name} ({adminInfo.isSuperAdmin ? '最高管理員' : '工作人員'})
                </span>
              )}
            </div>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
          >
            {isSidebarOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </header>

        {/* Dynamic Page Content */}
        <div className="flex-1 overflow-y-auto">
          <Outlet context={{ adminInfo }} />
        </div>
      </div>
    </div>
  );
}

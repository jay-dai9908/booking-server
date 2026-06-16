import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, CalendarRange, Menu, X, LogOut, UserCog, CalendarDays, Grid } from 'lucide-react';
import api from '../api/axios';

export default function AdminLayout() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await api.post('/auth/logout');
      window.location.href = '/admin/login';
    } catch (err) {
      console.error(err);
    }
  };

  const navLinks = [
    { to: '/admin/sessions', icon: <CalendarRange className="w-5 h-5" />, label: '營業時段設定' },
    { to: '/admin/reservations', icon: <Users className="w-5 h-5" />, label: '預約訂單總覽' },
    { to: '/admin/members', icon: <UserCog className="w-5 h-5" />, label: '會員管理' },
    { to: '/admin/weekly', icon: <CalendarDays className="w-5 h-5" />, label: '周營業狀況' },
    { to: '/admin/seating', icon: <Grid className="w-5 h-5" />, label: '帶位圖管理' },
  ];

  const SidebarContent = () => (
    <>
      <div className="p-6">
        <div className="flex items-center gap-3">
          <div className="bg-gray-100 p-2 rounded-xl">
            <LayoutDashboard className="w-6 h-6 text-gray-800" />
          </div>
          <span className="text-xl font-bold text-gray-900 tracking-tight">後台管理</span>
        </div>
      </div>
      <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
        {navLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            onClick={() => setIsSidebarOpen(false)}
            className={({ isActive }) =>
              `w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                isActive
                  ? 'bg-gray-100 text-gray-900 font-semibold'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
              }`
            }
          >
            {link.icon}
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="p-4 border-t border-gray-100">
        <button 
          onClick={handleLogout} 
          className="w-full flex items-center justify-center gap-2 px-4 py-3 text-gray-500 hover:text-gray-900 hover:bg-gray-50 rounded-xl transition-all"
        >
          <LogOut className="w-5 h-5" />
          登出系統
        </button>
      </div>
    </>
  );

  return (
    <div className="h-screen overflow-hidden bg-gray-50 flex font-sans selection:bg-gray-200">
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
        <header className="md:hidden bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between z-30 shrink-0">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="w-5 h-5 text-gray-800" />
            <span className="font-bold text-gray-900">管理後台</span>
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
          <Outlet />
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import api from '../api/axios';
import AdminShell from './admin/AdminShell';
import { setPrintGloballyEnabled } from '../utils/sunmiPrinter';

export default function AdminLayout({ initialAdminInfo = null }) {
  const [adminInfo, setAdminInfo] = useState(initialAdminInfo);
  const [isLoadingInfo, setIsLoadingInfo] = useState(!initialAdminInfo);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!initialAdminInfo) {
      fetchAdminInfo();
    }
    // Sync print enabled master switch
    api.get('/daily-settings/global').then(res => {
      if (res.data) {
        setPrintGloballyEnabled(res.data.print_enabled !== false);
      }
    }).catch(err => console.warn('Failed to fetch print global setting in AdminLayout:', err));
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

  const allNavLinks = [
    { to: '/admin/seating', perm: 'seating' },
    { to: '/admin/seat-layout', perm: 'seating' },
    { to: '/admin/reservations', perm: 'reservations' },
    { to: '/admin/shop', perm: 'shop', fallbackPerm: 'reservations' },
    { to: '/admin/members', perm: 'members' },
    { to: '/admin/coupons', perm: 'coupons', fallbackPerm: 'accounting' },
    { to: '/admin/sessions', perm: 'sessions' },
    { to: '/admin/equipment', perm: 'equipment', fallbackPerm: 'sessions' },
    { to: '/admin/weekly', perm: 'weekly' },
    { to: '/admin/accounting', perm: 'accounting' },
    { to: '/admin/print-station', perm: 'settings', fallbackPerm: 'accounting' },
    { to: '/admin/settings', perm: 'settings', fallbackPerm: 'sessions' },
    { to: '/admin/staff', perm: 'staff', superAdminOnly: true },
  ];

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

  return (
    <AdminShell adminInfo={adminInfo}>
      <Outlet context={{ adminInfo }} />
    </AdminShell>
  );
}

import React, { useEffect, useState, Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import api from './api/axios';
import { getBrowserClientInfoAsync } from './utils/clientInfo';

// Customer Pages (Eagerly loaded for instant LINE WebView startup)
import Home from './pages/Customer/Home';
import Register from './pages/Customer/Register';
import Booking from './pages/Customer/Booking';
import Preview from './pages/Customer/Preview';
import HistoryPage from './pages/Customer/HistoryPage';

// Admin Pages (Lazy-loaded via Code Splitting to reduce customer bundle size by >40%)
const AdminLogin = lazy(() => import('./pages/Admin/Login'));
const AdminLayout = lazy(() => import('./components/AdminLayout'));
const SessionsPage = lazy(() => import('./pages/Admin/SessionsPage'));
const ReservationsPage = lazy(() => import('./pages/Admin/ReservationsPage'));
const MembersPage = lazy(() => import('./pages/Admin/MembersPage'));
const WeeklyPage = lazy(() => import('./pages/Admin/WeeklyPage'));
const SeatingPage = lazy(() => import('./pages/Admin/SeatingPage'));
const AccountingPage = lazy(() => import('./pages/Admin/AccountingPage'));
const StaffPage = lazy(() => import('./pages/Admin/StaffPage'));
const EquipmentPage = lazy(() => import('./pages/Admin/EquipmentPage'));
const CouponsPage = lazy(() => import('./pages/Admin/CouponsPage'));
const SettingsPage = lazy(() => import('./pages/Admin/SettingsPage'));

function App() {
  const [userRole, setUserRole] = useState(null); // 'customer', 'temp_customer', 'admin', or null
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const info = await getBrowserClientInfoAsync();
        const searchParams = new URLSearchParams(window.location.search);
        const hasOAuthCode = searchParams.has('code');
        const isEntryHome = window.location.pathname === '/' && !hasOAuthCode;

        let freshSession = '0';
        try {
          if (isEntryHome) {
            // Opening entry `/` without an OAuth callback code is a new visit entry
            sessionStorage.removeItem('shiguang_line_fresh_login');
          } else {
            freshSession = sessionStorage.getItem('shiguang_line_fresh_login') === '1' ? '1' : '0';
          }
        } catch (e) {}

        const response = await api.get('/auth/me', {
          params: {
            sw: info.screenWidth,
            sh: info.screenHeight,
            dpr: info.pixelRatio,
            lang: info.language,
            net: info.networkType,
            ip: info.publicIp,
            entry_home: isEntryHome ? '1' : '0',
            fresh_session: freshSession
          }
        });
        setUserRole(response.data.role);
      } catch (error) {
        try {
          sessionStorage.removeItem('shiguang_line_fresh_login');
          sessionStorage.removeItem('shiguang_auth_token');
        } catch (e) {}
        setUserRole(null);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  if (loading) {
    return <div className="flex h-screen items-center justify-center">載入中...</div>;
  }

  return (
    <BrowserRouter>
      <Suspense fallback={<div className="flex h-screen items-center justify-center text-gray-500">載入頁面中...</div>}>
        <Routes>
        {/* Customer Routes */}
        <Route path="/" element={<Home userRole={userRole} />} />
        <Route path="/preview" element={<Preview />} />
        <Route 
          path="/register" 
          element={userRole === 'temp_customer' ? <Register setUserRole={setUserRole} /> : <Navigate to="/" />} 
        />
        <Route 
          path="/booking" 
          element={userRole === 'customer' ? <Booking /> : <Navigate to="/" />} 
        />
        <Route 
          path="/history" 
          element={userRole === 'customer' ? <HistoryPage /> : <Navigate to="/" />} 
        />

        {/* Admin Login */}
        <Route 
          path="/admin/login" 
          element={userRole === 'admin' ? <Navigate to="/admin/sessions" /> : <AdminLogin setUserRole={setUserRole} />} 
        />

        {/* Admin Nested Routes */}
        <Route 
          path="/admin" 
          element={userRole === 'admin' ? <AdminLayout /> : <Navigate to="/admin/login" />}
        >
          <Route index element={<Navigate to="sessions" replace />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="reservations" element={<ReservationsPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="weekly" element={<WeeklyPage />} />
          <Route path="seating" element={<SeatingPage />} />
          <Route path="equipment" element={<EquipmentPage />} />
          <Route path="coupons" element={<CouponsPage />} />
          <Route path="accounting" element={<AccountingPage />} />
          <Route path="staff" element={<StaffPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>

        {/* Catch old dashboard link */}
        <Route path="/admin/dashboard" element={<Navigate to="/admin/sessions" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;

import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import api from './api/axios';

// Customer Pages
import Home from './pages/Customer/Home';
import Register from './pages/Customer/Register';
import Booking from './pages/Customer/Booking';

// Admin Pages
import AdminLogin from './pages/Admin/Login';
import AdminLayout from './components/AdminLayout';
import SessionsPage from './pages/Admin/SessionsPage';
import ReservationsPage from './pages/Admin/ReservationsPage';
import MembersPage from './pages/Admin/MembersPage';
import WeeklyPage from './pages/Admin/WeeklyPage';
import SeatingPage from './pages/Admin/SeatingPage';

import AccountingPage from './pages/Admin/AccountingPage';

function App() {
  const [userRole, setUserRole] = useState(null); // 'customer', 'temp_customer', 'admin', or null
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await api.get('/auth/me');
        setUserRole(response.data.role);
      } catch (error) {
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
      <Routes>
        {/* Customer Routes */}
        <Route path="/" element={<Home userRole={userRole} />} />
        <Route 
          path="/register" 
          element={userRole === 'temp_customer' ? <Register setUserRole={setUserRole} /> : <Navigate to="/" />} 
        />
        <Route 
          path="/booking" 
          element={userRole === 'customer' ? <Booking /> : <Navigate to="/" />} 
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

          <Route path="accounting" element={<AccountingPage />} />
        </Route>

        {/* Catch old dashboard link */}
        <Route path="/admin/dashboard" element={<Navigate to="/admin/sessions" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

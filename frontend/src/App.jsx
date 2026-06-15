import React, { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import api from './api/axios';

// Customer Pages
import Home from './pages/Customer/Home';
import Register from './pages/Customer/Register';
import Booking from './pages/Customer/Booking';

// Admin Pages
import AdminLogin from './pages/Admin/Login';
import AdminDashboard from './pages/Admin/Dashboard';

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

        {/* Admin Routes */}
        <Route 
          path="/admin" 
          element={userRole === 'admin' ? <Navigate to="/admin/dashboard" /> : <AdminLogin setUserRole={setUserRole} />} 
        />
        <Route 
          path="/admin/dashboard" 
          element={userRole === 'admin' ? <AdminDashboard /> : <Navigate to="/admin" />} 
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;

import React, { useState } from 'react';
import { Lock, ShieldCheck, ArrowRight } from 'lucide-react';
import api from '../../api/axios';

function AdminLogin({ setUserRole }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    try {
      await api.post('/auth/admin/login', { password });
      setUserRole('admin');
      window.location.href = '/admin/dashboard';
    } catch (err) {
      setError(err.response?.data?.error || '密碼錯誤，請重新輸入');
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      {/* Minimalist Card */}
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-sm w-full transition-all duration-300 hover:shadow-2xl">
        <div className="flex justify-center mb-6">
          <div className="bg-gray-100 p-4 rounded-full">
            <ShieldCheck className="w-8 h-8 text-gray-800" />
          </div>
        </div>
        
        <h2 className="text-2xl font-bold text-gray-800 mb-2 text-center">系統管理中心</h2>
        <p className="text-gray-500 mb-8 text-center text-sm">請輸入專屬管理員密碼</p>
        
        {error && (
          <div className="bg-red-50 text-red-500 p-3 rounded-xl mb-6 text-sm flex items-center justify-center">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Lock className="h-5 w-5 text-gray-400 group-focus-within:text-gray-800 transition-colors" />
            </div>
            <input 
              type="password" 
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-white border border-gray-300 rounded-xl text-gray-900 placeholder-gray-400 focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none transition-all"
              placeholder="請輸入密碼"
            />
          </div>
          <button 
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 bg-gray-900 hover:bg-gray-800 text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 disabled:opacity-70"
          >
            {isLoading ? '驗證中...' : '安全登入'}
            {!isLoading && <ArrowRight className="w-5 h-5" />}
          </button>
        </form>
      </div>
    </div>
  );
}

export default AdminLogin;

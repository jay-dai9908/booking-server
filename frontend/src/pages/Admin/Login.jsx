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
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#F7F4F0] p-4">
      {/* Minimalist Card */}
      <div className="bg-white p-8 rounded-[24px] shadow-[0_12px_32px_rgba(139,91,67,0.08)] max-w-sm w-full transition-all duration-300">
        <div className="flex justify-center mb-6">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-20 h-20 object-cover rounded-full shadow-sm ring-4 ring-[#F9F7F3]" />
        </div>
        
        <h2 className="text-2xl font-bold text-[#3E332B] mb-2 text-center">拾光製所 系統管理中心</h2>
        <p className="text-[#8C8279] mb-8 text-center text-sm">請輸入員工密碼</p>
        
        {error && (
          <div className="bg-red-50 text-red-500 p-3 rounded-xl mb-6 text-sm flex items-center justify-center">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Lock className="h-5 w-5 text-[#A8A19A] group-focus-within:text-[#8B5B43] transition-colors" />
            </div>
            <input 
              type="password" 
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-11 pr-4 py-3 bg-white border border-[#D5CFC9] rounded-xl text-[#3E332B] placeholder-[#A8A19A] focus:border-[#8B5B43] focus:ring-1 focus:ring-[#8B5B43] outline-none transition-all"
              placeholder="請輸入密碼"
            />
          </div>
          <button 
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 bg-[#8B5B43] hover:bg-[#A67C52] text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 disabled:opacity-70"
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

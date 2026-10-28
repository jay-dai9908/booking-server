import React, { useState } from 'react';
import { Lock, ArrowRight, Eye, EyeOff } from 'lucide-react';
import api from '../../api/axios';

function AdminLogin({ setUserRole }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    const cleanPass = password.trim();
    if (!cleanPass) {
      setError('請輸入管理員或員工密碼');
      setIsLoading(false);
      return;
    }

    try {
      const res = await api.post('/auth/admin/login', { password: cleanPass });
      if (res.data?.token) {
        try {
          sessionStorage.setItem('shiguang_auth_token', res.data.token);
        } catch (e) {}
      }
      setUserRole('admin');
      window.location.href = '/admin/sessions';
    } catch (err) {
      const status = err.response?.status;
      const serverMsg = err.response?.data?.error;
      if (serverMsg) {
        setError(serverMsg);
      } else if (!err.response || status >= 500) {
        setError(`伺服器連線異常或後端啟動中 (HTTP ${status || '斷線'})，請確認後端 PM2 狀態`);
      } else {
        setError('密碼錯誤，請重新輸入');
      }
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
        <p className="text-[#8C8279] mb-8 text-center text-sm">請輸入最高管理員或員工密碼</p>
        
        {error && (
          <div className="bg-[#FDF3F1] border border-[#F2D6D3] text-[#B24F45] p-3 rounded-xl mb-6 text-sm flex items-center justify-center font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <Lock className="h-5 w-5 text-[#A8A19A] group-focus-within:text-[#8B5B43] transition-colors" />
            </div>
            <input 
              type={showPassword ? 'text' : 'password'} 
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-11 pr-11 py-3 bg-white border border-[#D5CFC9] rounded-xl text-[#3E332B] placeholder-[#A8A19A] focus:border-[#8B5B43] focus:ring-1 focus:ring-[#8B5B43] outline-none transition-all font-mono"
              placeholder="請輸入密碼"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-[#A8A19A] hover:text-[#3E332B] transition-colors"
              title={showPassword ? '隱藏密碼' : '顯示密碼'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
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

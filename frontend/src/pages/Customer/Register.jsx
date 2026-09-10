import React, { useState } from 'react';
import api from '../../api/axios';

function Register({ setUserRole }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/auth/register', { name, phone });
      setUserRole('customer');
      window.location.href = '/booking';
    } catch (err) {
      setError(err.response?.data?.error || '註冊失敗');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-wood-bg p-4 transition-colors duration-300">
      <div className="bg-wood-card p-10 sm:p-12 rounded-[24px] shadow-warm max-w-md w-full relative overflow-hidden">
        <div className="mb-8 text-center">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-16 h-16 object-cover rounded-full mx-auto mb-4 shadow-sm ring-4 ring-wood-bg" />
          <h2 className="text-2xl font-bold text-wood-textMain mb-2">會員資料綁定</h2>
          <p className="text-wood-textMuted text-sm font-medium">歡迎新朋友！請填寫以下資訊完成綁定。</p>
        </div>
        
        {error && <div className="bg-red-50 text-red-500 p-3 rounded-lg mb-4 text-sm font-medium">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-wood-textMuted font-medium mb-2 text-sm">真實姓名</label>
            <input 
              type="text" 
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 border border-wood-border rounded-xl focus:ring-2 focus:ring-wood-primary/50 outline-none bg-wood-bg/50 text-wood-textMain font-medium transition-colors"
              placeholder="請輸入真實姓名"
            />
          </div>
          <div>
            <label className="block text-wood-textMuted font-medium mb-2 text-sm">手機號碼</label>
            <input 
              type="tel" 
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-3 border border-wood-border rounded-xl focus:ring-2 focus:ring-wood-primary/50 outline-none bg-wood-bg/50 text-wood-textMain font-medium transition-colors"
              placeholder="0912345678"
            />
          </div>
          <button 
            type="submit"
            className="w-full bg-wood-primary hover:bg-wood-primaryHover text-white font-bold py-4 px-4 rounded-xl transition-all duration-300 mt-6 shadow-warm transform hover:-translate-y-1"
          >
            完成註冊並前往預約
          </button>
        </form>
      </div>
    </div>
  );
}

export default Register;

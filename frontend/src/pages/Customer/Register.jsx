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
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full">
        <h2 className="text-2xl font-bold text-gray-800 mb-6 text-center">補全資料</h2>
        <p className="text-gray-600 mb-6 text-center text-sm">歡迎新朋友！請填寫以下資訊完成會員綁定。</p>
        
        {error && <div className="bg-red-50 text-red-500 p-3 rounded-lg mb-4 text-sm">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-gray-700 font-medium mb-1">姓名</label>
            <input 
              type="text" 
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              placeholder="請輸入真實姓名"
            />
          </div>
          <div>
            <label className="block text-gray-700 font-medium mb-1">手機號碼</label>
            <input 
              type="tel" 
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-xl focus:ring-2 focus:ring-brand-500 focus:border-brand-500 outline-none"
              placeholder="0912345678"
            />
          </div>
          <button 
            type="submit"
            className="w-full bg-gray-900 hover:bg-gray-800 text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 mt-6"
          >
            完成註冊並前往預約
          </button>
        </form>
      </div>
    </div>
  );
}

export default Register;

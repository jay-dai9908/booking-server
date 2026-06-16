import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../api/axios';

function Home({ userRole }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (userRole === 'customer') {
      navigate('/booking');
    } else if (userRole === 'temp_customer') {
      navigate('/register');
    }
  }, [userRole, navigate]);

  const isProcessing = React.useRef(false);

  // Handle LINE OAuth Callback
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const code = queryParams.get('code');

    if (code && !isProcessing.current) {
      isProcessing.current = true;
      
      // 立即清除 URL 上的 code 避免 React StrictMode 觸發兩次
      window.history.replaceState({}, document.title, window.location.pathname);
      api.post('/auth/line/callback', { code })
        .then(res => {
          if (res.data.isNewUser) {
            window.location.href = '/register'; // Full reload to update App state
          } else {
            window.location.href = '/booking';
          }
        })
        .catch(err => {
          console.error(err);
          // 優先顯示 backend 傳來的 details (即 LINE API 原始錯誤)，若無再顯示 error
          const details = err.response?.data?.details;
          let errorMsg = err.response?.data?.error || err.message;
          if (details && details.error_description) {
            errorMsg = details.error_description;
          } else if (details && details.message) {
            errorMsg = details.message;
          } else if (typeof details === 'string') {
            errorMsg = details;
          } else if (details) {
            errorMsg = JSON.stringify(details);
          }
          alert(`登入失敗，請重試。\n錯誤原因: ${errorMsg}`);
          isProcessing.current = false;
        });
    }
  }, [location]);

  const initiateLineLogin = () => {
    const channelId = import.meta.env.VITE_LINE_CHANNEL_ID;
    const redirectUri = import.meta.env.VITE_LINE_CALLBACK_URL;
    
    if (!channelId || !redirectUri || channelId === 'your_channel_id_here') {
      alert('請先在 frontend/.env 設定 VITE_LINE_CHANNEL_ID 與 VITE_LINE_CALLBACK_URL');
      return;
    }

    const state = Math.random().toString(36).substring(7);
    const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${channelId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=profile%20openid`;
    window.location.href = lineLoginUrl;
  };

  const isHandlingCallback = new URLSearchParams(location.search).has('code');
  const showLoading = isHandlingCallback || isProcessing.current;

  if (showLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#06C755] mx-auto mb-4"></div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">正在處理登入資訊...</h2>
          <p className="text-gray-500 text-sm">請稍候，即將為您跳轉</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50">
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full text-center">
        <h1 className="text-3xl font-bold text-gray-800 mb-6">藝術家的貓 拼豆時段預約系統</h1>
        <p className="text-gray-600 mb-8">請登入您的 LINE 帳號以進行預約</p>
        
        <button 
          onClick={initiateLineLogin}
          className="w-full flex items-center justify-center gap-2 bg-[#06C755] hover:bg-[#05b34c] text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
             <path d="M23.928 10.38c0-4.323-4.288-7.85-9.56-7.85-5.275 0-9.562 3.527-9.562 7.85 0 3.864 3.398 7.155 8.1 7.766.316.04.757.124.863.432.096.277.062.705.03 1.002-.032.316-.202 1.258-.246 1.48-.052.264-.246.43-.166.496.082.066.623-.332.964-.53 1.205-.705 4.502-2.82 6.136-4.505 1.57-1.63 2.44-3.415 2.44-5.14z"/>
          </svg>
          使用 LINE 登入
        </button>
      </div>
    </div>
  );
}

export default Home;

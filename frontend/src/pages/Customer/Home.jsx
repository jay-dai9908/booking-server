import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../api/axios';
import { getBrowserClientInfoAsync } from '../../utils/clientInfo';
import { initiateLineOAuth, verifyAndConsumeLineOAuthState } from '../../utils/lineAuth';

function Home({ userRole }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [authErrorMsg, setAuthErrorMsg] = useState('');

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    if (queryParams.has('code')) return; // Let OAuth callback effect handle redirect

    if (userRole === 'customer') {
      let target = '/booking';
      try {
        const savedRedirect =
          sessionStorage.getItem('shiguang_post_login_redirect') ||
          localStorage.getItem('shiguang_post_login_redirect');
        if (savedRedirect) {
          sessionStorage.removeItem('shiguang_post_login_redirect');
          localStorage.removeItem('shiguang_post_login_redirect');
          target = savedRedirect;
        }
      } catch (e) {}
      navigate(target);
    } else if (userRole === 'temp_customer') {
      navigate('/register');
    }
  }, [userRole, navigate, location.search]);

  const isProcessing = React.useRef(false);

  // Handle LINE OAuth Callback
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const code = queryParams.get('code');
    const oauthState = queryParams.get('state') || '';

    if (code && !isProcessing.current) {
      isProcessing.current = true;

      // 嚴格校驗 state 是否與本地發起時一致且未逾期
      const verifyResult = verifyAndConsumeLineOAuthState(oauthState);
      if (!verifyResult.valid) {
        window.history.replaceState({}, document.title, window.location.pathname);
        setAuthErrorMsg(verifyResult.error || '登入狀態驗證失效，請重新嘗試登入。');
        isProcessing.current = false;
        return;
      }

      const isPreorderLogin = oauthState.startsWith('preorder_') || verifyResult.returnPath === '/preorder';
      if (isPreorderLogin) {
        try {
          sessionStorage.setItem('shiguang_post_login_redirect', '/preorder');
          localStorage.setItem('shiguang_post_login_redirect', '/preorder');
        } catch (e) {}
      }
      
      // 立即清除 URL 上的 code 避免 React StrictMode 觸發兩次
      window.history.replaceState({}, document.title, window.location.pathname);
      getBrowserClientInfoAsync()
        .then(clientInfo => api.post('/auth/line/callback', { code, clientInfo }))
        .then(res => {
          try {
            sessionStorage.setItem('shiguang_line_fresh_login', '1');
            if (res.data?.token) {
              sessionStorage.setItem('shiguang_auth_token', res.data.token);
            }
          } catch (e) {}
          if (res.data.isNewUser) {
            window.location.href = '/register'; // Full reload to update App state
          } else {
            let target = verifyResult.returnPath || (isPreorderLogin ? '/preorder' : '/booking');
            try {
              const savedRedirect =
                sessionStorage.getItem('shiguang_post_login_redirect') ||
                localStorage.getItem('shiguang_post_login_redirect');
              if (savedRedirect) {
                sessionStorage.removeItem('shiguang_post_login_redirect');
                localStorage.removeItem('shiguang_post_login_redirect');
                target = savedRedirect;
              }
            } catch (e) {}
            window.location.href = target;
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
          setAuthErrorMsg(`登入失敗，請重試。\n錯誤原因: ${errorMsg}`);
          isProcessing.current = false;
        });
    }
  }, [location]);

  const initiateLineLogin = () => {
    setAuthErrorMsg('');
    initiateLineOAuth({ returnPath: '/booking' });
  };

  const isHandlingCallback = new URLSearchParams(location.search).has('code');
  const showLoading = isHandlingCallback || isProcessing.current;

  if (showLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-wood-bg px-4 transition-colors duration-300">
        <div className="bg-wood-card p-10 sm:p-12 rounded-[24px] shadow-warm max-w-md w-full text-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#06C755] mx-auto mb-6"></div>
          <h2 className="text-xl font-bold text-wood-textMain mb-2">正在處理登入資訊...</h2>
          <p className="text-wood-textMuted text-sm font-medium">請稍候，即將為您跳轉</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-wood-bg px-4 transition-colors duration-300">
      <div className="bg-wood-card p-10 sm:p-12 rounded-[24px] shadow-warm max-w-md w-full text-center relative overflow-hidden">
        {/* Logo and Titles */}
        <div className="mb-10">
          <img src="/logo.png" alt="拾光製所 Logo" className="w-16 h-16 object-cover rounded-full mx-auto mb-6 shadow-sm ring-4 ring-wood-bg" />
          <h1 className="text-2xl sm:text-3xl font-bold text-wood-textMain mb-4">拾光製所<br/>拼豆時段預約系統</h1>
          <p className="text-wood-textMuted font-medium">請登入您的 LINE 帳號以進行預約</p>
        </div>

        {authErrorMsg && (
          <div className="mb-6 p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold leading-relaxed whitespace-pre-line text-left">
            ⚠️ {authErrorMsg}
          </div>
        )}
        
        {/* LINE Button */}
        <button 
          onClick={initiateLineLogin}
          className="w-full flex items-center justify-center gap-3 bg-[#06C755] hover:bg-[#05b34c] hover:shadow-[0_8px_20px_rgba(6,199,85,0.25)] text-white font-bold py-4 px-6 rounded-full transition-all duration-300 transform hover:-translate-y-1"
        >
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
             <path d="M23.928 10.38c0-4.323-4.288-7.85-9.56-7.85-5.275 0-9.562 3.527-9.562 7.85 0 3.864 3.398 7.155 8.1 7.766.316.04.757.124.863.432.096.277.062.705.03 1.002-.032.316-.202 1.258-.246 1.48-.052.264-.246.43-.166.496.082.066.623-.332.964-.53 1.205-.705 4.502-2.82 6.136-4.505 1.57-1.63 2.44-3.415 2.44-5.14z"/>
          </svg>
          <span className="text-lg tracking-wide">使用 LINE 登入</span>
        </button>
      </div>
    </div>
  );
}

export default Home;

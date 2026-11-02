import React, { useEffect, useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import api from '../../api/axios';
import { getBrowserClientInfoAsync } from '../../utils/clientInfo';
import { initiateLineOAuth, verifyAndConsumeLineOAuthState } from '../../utils/lineAuth';

function Home({ userRole }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [authErrorMsg, setAuthErrorMsg] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const hasProcessedRef = useRef(false);

  // 1. 一般常規訪問（無 OAuth code）：已登入顧客自動導向目標頁面
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    if (queryParams.has('code')) return; // 由 OAuth 回調專用 Effect 處理

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
      navigate(target, { replace: true });
    } else if (userRole === 'temp_customer') {
      navigate('/register', { replace: true });
    }
  }, [userRole, navigate, location.search]);

  // 2. 處理 LINE OAuth Callback (/?code=...&state=...)
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const code = queryParams.get('code');
    const oauthState = queryParams.get('state') || '';

    if (!code) {
      return;
    }

    // 若使用者已確定為登入狀態 (customer)，直接導向目標頁面，不重複呼叫 callback API
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
      navigate(target, { replace: true });
      return;
    }

    if (userRole === 'temp_customer') {
      navigate('/register', { replace: true });
      return;
    }

    // 防止 React StrictMode 在開發環境下觸發兩次
    if (hasProcessedRef.current) return;
    hasProcessedRef.current = true;
    setIsProcessing(true);
    setAuthErrorMsg('');

    // 15 秒處理逾時保護計時器
    const timeoutTimer = setTimeout(() => {
      console.warn('[Home] LINE login handling timed out after 15s');
      navigate(location.pathname, { replace: true });
      setIsProcessing(false);
      setAuthErrorMsg('登入處理逾時，請重新登入。');
    }, 15000);

    const cleanupAndStopProcessing = (errorMsg) => {
      clearTimeout(timeoutTimer);
      // 清除網址上的 code 與 state
      navigate(location.pathname, { replace: true });
      setIsProcessing(false);
      if (errorMsg) {
        setAuthErrorMsg(errorMsg);
      }
    };

    // 校驗 state
    const verifyResult = verifyAndConsumeLineOAuthState(oauthState);
    if (verifyResult.status === 'mismatch') {
      cleanupAndStopProcessing('登入驗證失敗，請重新登入。');
      return;
    }

    const isPreorderLogin = oauthState.startsWith('preorder_') || verifyResult.returnPath === '/preorder';
    if (isPreorderLogin) {
      try {
        sessionStorage.setItem('shiguang_post_login_redirect', '/preorder');
        localStorage.setItem('shiguang_post_login_redirect', '/preorder');
      } catch (e) {}
    }

    // 發送授權碼至後端進行憑證交換
    getBrowserClientInfoAsync()
      .then(clientInfo => api.post('/auth/line/callback', { code, clientInfo }))
      .then(res => {
        clearTimeout(timeoutTimer);
        try {
          sessionStorage.setItem('shiguang_line_fresh_login', '1');
          if (res.data?.token) {
            sessionStorage.setItem('shiguang_auth_token', res.data.token);
          }
        } catch (e) {}

        if (res.data?.isNewUser) {
          window.location.href = '/register';
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
      .catch(async (err) => {
        console.error('[Home] LINE callback error, checking /auth/me insurance...', err);

        // 保險機制：若 callback 失敗（例如授權碼已使用但本地已有有效 token），先呼叫一次 /auth/me 確認是否已登入
        try {
          const freshSession = sessionStorage.getItem('shiguang_line_fresh_login') === '1' ? '1' : '0';
          const meRes = await api.get('/auth/me', {
            params: { fresh_session: freshSession }
          });
          if (meRes.data?.role === 'customer') {
            clearTimeout(timeoutTimer);
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
            return;
          } else if (meRes.data?.role === 'temp_customer') {
            clearTimeout(timeoutTimer);
            window.location.href = '/register';
            return;
          }
        } catch (meErr) {
          // 未登入或 /auth/me 失敗
        }

        const details = err.response?.data?.details;
        let errorMsg = err.response?.data?.error || err.message || '登入失敗，請重試。';
        if (details && details.error_description) {
          errorMsg = details.error_description;
        } else if (details && details.message) {
          errorMsg = details.message;
        } else if (typeof details === 'string') {
          errorMsg = details;
        }
        cleanupAndStopProcessing(`登入失敗，請重試。\n錯誤原因: ${errorMsg}`);
      });

    return () => {
      clearTimeout(timeoutTimer);
    };
  }, [userRole, location.search, location.pathname, navigate]);

  const initiateLineLogin = () => {
    hasProcessedRef.current = false;
    setAuthErrorMsg('');
    initiateLineOAuth({ returnPath: '/booking' });
  };

  const hasCodeInUrl = new URLSearchParams(location.search).has('code');
  const showLoading = isProcessing || (hasCodeInUrl && !authErrorMsg && userRole !== 'customer');

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

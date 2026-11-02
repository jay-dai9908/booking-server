/**
 * LINE OAuth 登入前端共用輔助工具
 * 使用 window.crypto.getRandomValues 產生高強度加密亂數 state，並存於 localStorage 中
 * 防止 CSRF 攻擊，且提供 10 分鐘有效期限校驗
 */

const OAUTH_STATE_KEY = 'shiguang_line_oauth_state';

export const generateSecureRandomHex = (bytesCount = 16) => {
  const bytes = new Uint8Array(bytesCount);
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytesCount; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * 發起 LINE OAuth 登入跳轉
 * @param {Object} options
 * @param {string} [options.prefix] 例如 'preorder_'
 * @param {string} [options.returnPath] 登入後欲導回的路徑 (例如 '/preorder' 或 '/booking')
 */
export const initiateLineOAuth = ({ prefix = '', returnPath = '/booking' } = {}) => {
  const channelId = import.meta.env.VITE_LINE_CHANNEL_ID;
  const redirectUri = import.meta.env.VITE_LINE_CALLBACK_URL;

  if (!channelId || !redirectUri || channelId === 'your_channel_id_here') {
    alert('系統尚未設定 LINE 登入參數 (VITE_LINE_CHANNEL_ID / VITE_LINE_CALLBACK_URL)');
    return;
  }

  const rawRandom = generateSecureRandomHex(16);
  const state = prefix ? `${prefix}${rawRandom}` : rawRandom;

  const statePayload = {
    state,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 分鐘效期
    returnPath
  };

  try {
    localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(statePayload));
    if (returnPath) {
      sessionStorage.setItem('shiguang_post_login_redirect', returnPath);
      localStorage.setItem('shiguang_post_login_redirect', returnPath);
    }
  } catch (e) {
    console.warn('Failed to save oauth state to storage:', e);
  }

  const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${channelId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=profile%20openid&bot_prompt=normal`;
  window.location.href = lineLoginUrl;
};

/**
 * 校驗 LINE 回傳的 state
 * @param {string} returnedState
 * @returns {{ valid: boolean, error?: string, returnPath?: string }}
 */
export const verifyAndConsumeLineOAuthState = (returnedState) => {
  if (!returnedState) {
    return { valid: false, error: '未接收到 LINE 登入授權狀態參數 (state missing)' };
  }

  try {
    const raw = localStorage.getItem(OAUTH_STATE_KEY);
    localStorage.removeItem(OAUTH_STATE_KEY); // 一次性使用即焚

    if (!raw) {
      return { valid: false, error: '登入驗證逾時或登入狀態遺失，請重新點擊按鈕登入。' };
    }

    const saved = JSON.parse(raw);
    if (!saved || !saved.state || !saved.expiresAt) {
      return { valid: false, error: '登入驗證資料無效，請重新登入。' };
    }

    if (Date.now() > saved.expiresAt) {
      return { valid: false, error: '登入驗證已超過 10 分鐘有效期限，請重新登入。' };
    }

    if (saved.state !== returnedState) {
      return { valid: false, error: '登入驗證狀態比對不符合，可能為過期的連線，請重新登入。' };
    }

    return {
      valid: true,
      returnPath: saved.returnPath || (returnedState.startsWith('preorder_') ? '/preorder' : '/booking')
    };
  } catch (err) {
    console.error('verifyAndConsumeLineOAuthState error:', err);
    return { valid: false, error: '登入驗證發生例外錯誤，請重試。' };
  }
};

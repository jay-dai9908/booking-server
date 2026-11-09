/**
 * LINE OAuth 登入前端共用輔助工具
 * 使用 window.crypto.getRandomValues 產生高強度加密亂數 state，並存於 localStorage 中
 * 保存最近最多 5 筆 state，提供 30 分鐘有效期限校驗，兼顧資安防護與顧客在多裝置/多頁面切換時的登入彈性
 */

/**
 * 依訪客環境 (User Agent) 與所在頁面判斷 LINE 按鈕動作
 * @param {'home' | 'preview' | string} [page='home']
 * @param {string} [customUa] 選填，供單元測試或特定環境注入 UA
 * @returns {'login' | 'oa'}
 */
export function getGuestLineAction(page = 'home', customUa) {
  const ua = typeof customUa === 'string'
    ? customUa
    : (typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '');

  // 1. 在 LINE 裡打開（UA 含 Line/）：一律 'login'（避免在 LINE 內繞圈回官方帳號）
  if (/Line\//i.test(ua)) {
    return 'login';
  }

  // 2. 在 Instagram、Facebook、Threads、Messenger 裡打開：一律 'oa'
  // (UA 含 Instagram、FBAN、FBAV、Barcelona、MessengerForiOS、FB_IAB)
  if (/(Instagram|FBAN|FBAV|Barcelona|MessengerForiOS|FB_IAB)/i.test(ua)) {
    return 'oa';
  }

  // 3. 其他一般瀏覽器：首頁回 'login'，預覽頁回 'oa'
  const isPreview = page === 'preview' || page === '/preview';
  return isPreview ? 'oa' : 'login';
}

const OAUTH_STATE_KEY = 'shiguang_line_oauth_state';
const MAX_SAVED_STATES = 5;
const STATE_EXPIRES_MS = 30 * 60 * 1000; // 放寬至 30 分鐘效期

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
  const channelId = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LINE_CHANNEL_ID) || (typeof process !== 'undefined' && process.env?.VITE_LINE_CHANNEL_ID);
  const redirectUri = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LINE_CALLBACK_URL) || (typeof process !== 'undefined' && process.env?.VITE_LINE_CALLBACK_URL);

  if (!channelId || !redirectUri || channelId === 'your_channel_id_here') {
    alert('系統尚未設定 LINE 登入參數 (VITE_LINE_CHANNEL_ID / VITE_LINE_CALLBACK_URL)');
    return;
  }

  const rawRandom = generateSecureRandomHex(16);
  const state = prefix ? `${prefix}${rawRandom}` : rawRandom;

  const statePayload = {
    state,
    expiresAt: Date.now() + STATE_EXPIRES_MS,
    returnPath
  };

  try {
    let list = [];
    const raw = localStorage.getItem(OAUTH_STATE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // 過濾掉已逾期的舊 state
          const now = Date.now();
          list = parsed.filter(item => item && item.state && item.expiresAt > now);
        } else if (parsed && parsed.state) {
          // 相容舊版單一物件格式
          if (parsed.expiresAt > Date.now()) {
            list = [parsed];
          }
        }
      } catch (parseErr) {
        list = [];
      }
    }

    // 新 state 置於最前，最多保留最近 5 筆
    list.unshift(statePayload);
    if (list.length > MAX_SAVED_STATES) {
      list = list.slice(0, MAX_SAVED_STATES);
    }
    localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(list));

    if (returnPath) {
      sessionStorage.setItem('shiguang_post_login_redirect', returnPath);
      localStorage.setItem('shiguang_post_login_redirect', returnPath);
    }
  } catch (e) {
    console.warn('[LINE OAuth] Failed to save oauth state to storage:', e);
  }

  const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${channelId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=profile%20openid&bot_prompt=normal`;
  window.location.href = lineLoginUrl;
};

/**
 * 校驗 LINE 回傳的 state
 * @param {string} returnedState
 * @returns {{ status: 'valid' | 'missing' | 'expired' | 'mismatch', returnPath: string }}
 */
export const verifyAndConsumeLineOAuthState = (returnedState) => {
  const fallbackReturnPath = (returnedState && String(returnedState).startsWith('preorder_'))
    ? '/preorder'
    : '/booking';

  try {
    let list = [];
    let hasSavedEntries = false;
    const raw = localStorage.getItem(OAUTH_STATE_KEY);

    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          list = parsed.filter(item => item && typeof item === 'object');
          hasSavedEntries = list.length > 0;
        } else if (parsed && typeof parsed === 'object' && parsed.state) {
          // 相容舊版單一物件格式
          list = [parsed];
          hasSavedEntries = true;
        }
      } catch (parseErr) {
        hasSavedEntries = false;
      }
    }

    // 1. missing：localStorage 裡完全沒有存好的 state（例如跨 App、換無痕模式等）
    if (!hasSavedEntries || list.length === 0) {
      console.warn('[LINE OAuth] No saved OAuth state in storage. Continuing login as missing.');
      return { status: 'missing', returnPath: fallbackReturnPath };
    }

    // 尋找匹配的 state
    const matchedIndex = list.findIndex(item => item.state === returnedState);

    // 2. mismatch：有存好的 state，但內容不同（可能是惡意竄改或完全不相關的請求）
    if (matchedIndex === -1) {
      console.warn('[LINE OAuth] State mismatch with stored records. Rejecting login.');
      return { status: 'mismatch', returnPath: fallbackReturnPath };
    }

    // 比對成功，消費並移除該筆 state
    const matchedItem = list[matchedIndex];
    list.splice(matchedIndex, 1);
    if (list.length > 0) {
      localStorage.setItem(OAUTH_STATE_KEY, JSON.stringify(list));
    } else {
      localStorage.removeItem(OAUTH_STATE_KEY);
    }

    const returnPath = matchedItem.returnPath || fallbackReturnPath;

    // 3. expired：內容相符但已超過期限
    if (Date.now() > matchedItem.expiresAt) {
      console.warn('[LINE OAuth] State matched but expired. Continuing login as expired.');
      return { status: 'expired', returnPath };
    }

    // 4. valid：有存好的 state、內容相符、未逾期
    return { status: 'valid', returnPath };
  } catch (err) {
    console.error('[LINE OAuth] verifyAndConsumeLineOAuthState error:', err);
    return { status: 'missing', returnPath: fallbackReturnPath };
  }
};

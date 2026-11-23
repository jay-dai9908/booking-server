import { API_BASE_URL } from '../api/axios.js';

/**
 * LINE OAuth 登入前端共用輔助工具
 * OAuth state 由後端產生並以簽章 HttpOnly cookie 綁定，前端只負責導向後端啟動端點。
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

/**
 * 發起 LINE OAuth 登入跳轉（導向後端 /api/auth/line/start）
 * @param {Object} options
 * @param {string} [options.prefix] 例如 'preorder' 或 'preorder_'
 * @param {string} [options.returnPath] 登入後欲導回的路徑 (例如 '/preorder' 或 '/booking')
 */
export const initiateLineOAuth = ({ prefix = '', returnPath = '/booking' } = {}) => {
  const cleanPrefix = String(prefix || '').replace(/_+$/, '');
  const params = new URLSearchParams();
  if (returnPath) {
    params.set('return', returnPath);
  }
  if (cleanPrefix) {
    params.set('prefix', cleanPrefix);
  }

  try {
    if (returnPath) {
      sessionStorage.setItem('shiguang_post_login_redirect', returnPath);
      localStorage.setItem('shiguang_post_login_redirect', returnPath);
    }
  } catch (e) {}

  const qs = params.toString();
  const base = API_BASE_URL.replace(/\/+$/, '');
  window.location.href = `${base}/auth/line/start${qs ? `?${qs}` : ''}`;
};

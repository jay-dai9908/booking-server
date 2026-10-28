import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.PROD ? '/api' : 'http://localhost:3001/api',
  withCredentials: true, // IMPORTANT: Allows sending cookies for HttpOnly JWT
});

// Dual-channel Auth: Also attach Bearer token from sessionStorage if present
// (prevents iOS Safari / LINE WebView ITP from dropping cookies on IP-based hosts)
api.interceptors.request.use((config) => {
  try {
    const token = sessionStorage.getItem('shiguang_auth_token');
    if (token && !config.headers?.Authorization) {
      config.headers = config.headers || {};
      config.headers.Authorization = `Bearer ${token}`;
    }
    const freshLogin = sessionStorage.getItem('shiguang_line_fresh_login');
    if (freshLogin === '1' && config.url && config.url.includes('/auth/me')) {
      config.params = config.params || {};
      config.params.fresh_session = '1';
    }
  } catch (e) {}
  return config;
});

export default api;

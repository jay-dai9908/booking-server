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

    // Attach Admin device headers (spec 5.0 item 2)
    let deviceId = localStorage.getItem('sg-device-id');
    if (!deviceId) {
      deviceId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'dev-' + Math.random().toString(36).slice(2) + Date.now();
      localStorage.setItem('sg-device-id', deviceId);
    }
    config.headers['X-Device-Id'] = deviceId;

    const deviceLabel = localStorage.getItem('sg-device-label');
    if (deviceLabel) {
      config.headers['X-Device-Label'] = encodeURIComponent(deviceLabel);
    }
  } catch (e) {}
  return config;
});

export default api;

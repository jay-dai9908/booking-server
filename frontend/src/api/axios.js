import axios from 'axios';

const api = axios.create({
  // 優先使用 VITE_API_URL 環境變數，如果沒有才使用預設邏輯
  baseURL: import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:3001/api'),
  withCredentials: true, // IMPORTANT: Allows sending cookies for HttpOnly JWT
});

export default api;

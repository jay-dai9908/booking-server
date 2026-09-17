import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.PROD ? '/api' : 'http://localhost:3001/api',
  withCredentials: true, // IMPORTANT: Allows sending cookies for HttpOnly JWT
});

export default api;

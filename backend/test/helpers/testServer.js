import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import authRoutes from '../../src/routes/auth.js';
import kioskRoutes from '../../src/routes/kiosk.js';
import { applyBodyParsers } from '../../src/middlewares/bodyParsers.js';

export function createTestApp() {
  const app = express();
  applyBodyParsers(app);
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/kiosk', kioskRoutes);
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: '資料太大' });
    }
    res.status(500).json({ error: err?.message || 'Internal error' });
  });
  return app;
}

export function startTestServer() {
  const app = createTestApp();
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

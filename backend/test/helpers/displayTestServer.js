import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import authRoutes from '../../src/routes/auth.js';
import reservationRoutes from '../../src/routes/reservations.js';
import floorRoutes from '../../src/routes/floor.js';
import billingRoutes from '../../src/routes/billing.js';
import displayRoutes from '../../src/routes/display.js';
import dailySettingsRoutes from '../../src/routes/dailySettings.js';
import { getGlobalSetting } from '../../src/controllers/dailySettingController.js';

export function createDisplayTestApp() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/reservations', reservationRoutes);
  app.use('/api/floor', floorRoutes);
  app.use('/api/billing', billingRoutes);
  app.use('/api/daily-settings', dailySettingsRoutes);
  app.use('/api/display', displayRoutes);
  app.get('/api/global-settings', getGlobalSetting);
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    res.status(500).json({ error: err?.message || 'Internal error' });
  });
  return app;
}

export function startDisplayTestServer() {
  const app = createDisplayTestApp();
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => {
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

import express from 'express';

export const LARGE_UPLOAD_PATHS = [
  '/api/shop/admin/products',
  '/api/seat-layouts',
  '/api/kiosk/admin/slides',
  '/api/kiosk/admin/firmware'
];

/**
 * Apply route-scoped JSON body size limits, global 1MB parser, and 413 error handler.
 * Shared by server.js and backend/test/helpers/testServer.js so tests mirror production limits.
 */
export function applyBodyParsers(app) {
  const json15mb = express.json({ limit: '15mb' });
  const json5mb = express.json({ limit: '5mb' });
  const json2mb = express.json({ limit: '2mb' });

  app.use('/api/kiosk/v1', express.json({ limit: '16kb' }));

  app.use('/api/kiosk/admin/slides', (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PATCH') {
      return json2mb(req, res, next);
    }
    return next();
  });

  app.use('/api/kiosk/admin/firmware', (req, res, next) => {
    if (req.method === 'POST') {
      return json5mb(req, res, next);
    }
    return next();
  });

  app.use(['/api/shop/admin/products', '/api/seat-layouts'], (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
      return json15mb(req, res, next);
    }
    return next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ limit: '1mb', extended: true }));

  app.use((err, _req, res, next) => {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: '資料太大' });
    }
    return next(err);
  });
}

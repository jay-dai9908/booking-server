// In-memory rate limiters (no database writes, no IP bans, no lockdown mode)

export const checkBannedIP = (req, res, next) => next();

/**
 * 通用記憶體計數限流器工廠
 */
export const createMemoryLimiter = ({ windowMs, max, message }) => {
  const store = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(key);
      }
    }
  }, 60000);
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const key = `${req.baseUrl || ''}${req.path || ''}-${ip}`;
    const now = Date.now();

    let record = store.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      store.set(key, record);
    } else {
      record.count += 1;
    }

    if (record.count > max) {
      return res.status(429).json({ error: message || '請求過於頻繁，請稍後再試' });
    }

    next();
  };
};

/**
 * 1. 後台登入失敗限流：15 分鐘內最多 10 次失敗（只計 401，不計成功），超過回傳 429
 */
export const adminLoginLimiter = (() => {
  const store = new Map();
  const windowMs = 15 * 60 * 1000;
  const maxFailures = 10;

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(ip);
      }
    }
  }, 60000);
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const record = store.get(ip);

    if (record && now <= record.resetTime && record.failures >= maxFailures) {
      return res.status(429).json({ error: '登入嘗試失敗次數過多，請於 15 分鐘後再試' });
    }

    res.on('finish', () => {
      if (res.statusCode === 401) {
        const cur = store.get(ip);
        if (!cur || Date.now() > cur.resetTime) {
          store.set(ip, { failures: 1, resetTime: Date.now() + windowMs });
        } else {
          cur.failures += 1;
        }
      } else if (res.statusCode === 200) {
        store.delete(ip);
      }
    });

    next();
  };
})();

/**
 * 2. LINE callback：10 分鐘內最多 20 次，超過回傳 429
 */
export const lineCallbackLimiter = createMemoryLimiter({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'LINE 登入嘗試過於頻繁，請於 10 分鐘後再試'
});

/**
 * 3. 建立預購單：10 分鐘內最多 10 次，超過回傳 429
 */
export const shopOrderLimiter = createMemoryLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: '下單頻率過高，請於 10 分鐘後再試'
});

/**
 * 4. 驗證折扣碼：10 分鐘內最多 30 次，超過回傳 429
 */
export const promoValidateLimiter = createMemoryLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: '折扣碼驗證次數過多，請於 10 分鐘後再試'
});

// 舊相容相容函式
export const rateLimiter = (options) => createMemoryLimiter(options);

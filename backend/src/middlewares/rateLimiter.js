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

/**
 * 5. 半自助預約試算：同一會員每分鐘最多 30 次
 */
export const prepayQuoteLimiter = (() => {
  const store = new Map();
  const windowMs = 60 * 1000;
  const max = 30;

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
    const actorKey = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
    const key = `prepay-quote-${actorKey}`;
    const now = Date.now();
    let record = store.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      store.set(key, record);
    } else {
      record.count += 1;
    }
    if (record.count > max) {
      return res.status(429).json({ error: '試算次數過於頻繁，請稍候 1 分鐘再試', code: 'RATE_LIMITED' });
    }
    next();
  };
})();

/**
 * 6. 半自助進場條碼查詢：同一會員每分鐘最多 60 次
 */
export const entryPassLimiter = (() => {
  const store = new Map();
  const windowMs = 60 * 1000;
  const max = 60;

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
    const actorKey = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
    const key = `entry-pass-${actorKey}`;
    const now = Date.now();
    let record = store.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      store.set(key, record);
    } else {
      record.count += 1;
    }
    if (record.count > max) {
      return res.status(429).json({ error: '查詢進場條碼過於頻繁，請稍候再試', code: 'RATE_LIMITED' });
    }
    next();
  };
})();

/**
 * 7. 註冊限流：同一 IP 10 分鐘內最多 10 次；同一 line_user_id 10 分鐘內最多 5 次
 */
export const registerLimiter = (() => {
  const ipStore = new Map();
  const userStore = new Map();
  const windowMs = 10 * 60 * 1000;
  const maxPerIp = 10;
  const maxPerUser = 5;

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of ipStore.entries()) {
      if (now > record.resetTime) {
        ipStore.delete(key);
      }
    }
    for (const [key, record] of userStore.entries()) {
      if (now > record.resetTime) {
        userStore.delete(key);
      }
    }
  }, 60000);
  if (cleanup.unref) cleanup.unref();

  const bumpAndCheck = (store, key, max, now) => {
    let record = store.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      store.set(key, record);
    } else {
      record.count += 1;
    }
    return record.count > max;
  };

  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (bumpAndCheck(ipStore, ip, maxPerIp, now)) {
      return res.status(429).json({ error: '註冊嘗試過於頻繁，請於 10 分鐘後再試', code: 'RATE_LIMITED' });
    }

    const lineUserId = req.user?.line_user_id;
    if (typeof lineUserId === 'string' && lineUserId) {
      if (bumpAndCheck(userStore, lineUserId, maxPerUser, now)) {
        return res.status(429).json({ error: '註冊嘗試過於頻繁，請於 10 分鐘後再試', code: 'RATE_LIMITED' });
      }
    }

    next();
  };
})();

/**
 * 8. 建立預約限流：同一會員 10 分鐘內最多 10 次（無會員 id 時用 IP），超過回 429
 */
const reservationCreateLimiterStore = new Map();

export const resetReservationCreateLimiter = () => {
  reservationCreateLimiterStore.clear();
};

export const reservationCreateLimiter = (() => {
  const windowMs = 10 * 60 * 1000;
  const max = 10;

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of reservationCreateLimiterStore.entries()) {
      if (now > record.resetTime) {
        reservationCreateLimiterStore.delete(key);
      }
    }
  }, 60000);
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    const actorKey = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip || req.connection?.remoteAddress || 'unknown'}`;
    const key = `res-create-${actorKey}`;
    const now = Date.now();
    let record = reservationCreateLimiterStore.get(key);
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + windowMs };
      reservationCreateLimiterStore.set(key, record);
    } else {
      record.count += 1;
    }
    if (record.count > max) {
      return res.status(429).json({ error: '預約送出太頻繁，請 10 分鐘後再試', code: 'RATE_LIMITED' });
    }
    next();
  };
})();

// 舊相容相容函式
export const rateLimiter = (options) => createMemoryLimiter(options);

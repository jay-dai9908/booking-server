import prisma from '../prismaClient.js';

// Cache banned IPs in memory
const bannedIPCache = new Set();

const loadBannedIPs = async () => {
  try {
    const bans = await prisma.bannedIP.findMany({ select: { ip: true } });
    bans.forEach(b => bannedIPCache.add(b.ip));
    console.log(`Loaded ${bans.length} banned IPs into cache.`);
  } catch (error) {
    console.error('Failed to load banned IPs', error);
  }
};
// Load on module initialization
loadBannedIPs();

export const checkBannedIP = async (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  if (bannedIPCache.has(ip)) {
    return res.status(403).json({ error: 'Your IP has been banned due to suspicious activity.' });
  }
  next();
};

// In-memory store for rate limiting
const rateLimits = new Map();

// Helper to cleanup old records periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimits.entries()) {
    if (now > record.resetTime) {
      rateLimits.delete(key);
    }
  }
}, 60000);

export const rateLimiter = ({ windowMs, max, reason }) => {
  return async (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    
    if (bannedIPCache.has(ip)) {
       return res.status(403).json({ error: 'Your IP has been banned due to suspicious activity.' });
    }

    // Key is endpoint path + IP
    const key = `${req.route ? req.route.path : req.originalUrl}-${ip}`;
    const now = Date.now();
    
    let record = rateLimits.get(key);
    
    if (!record || now > record.resetTime) {
      record = {
        count: 1,
        resetTime: now + windowMs
      };
      rateLimits.set(key, record);
    } else {
      record.count += 1;
    }

    if (record.count > max) {
      // Exceeded limit, permanently ban IP
      try {
        await prisma.bannedIP.upsert({
          where: { ip },
          update: { reason, banned_at: new Date() },
          create: { ip, reason }
        });
        bannedIPCache.add(ip);
        console.warn(`[SECURITY] Banned IP ${ip}. Reason: ${reason}`);

        // Check for lockdown trigger
        if (bannedIPCache.size >= 3) {
          await prisma.globalSetting.upsert({
            where: { id: 1 },
            update: { is_lockdown_mode: true },
            create: { id: 1, is_lockdown_mode: true }
          });
          console.error('[SECURITY] SYSTEM LOCKDOWN INITIATED DUE TO MULTIPLE BANNED IPs');
        }

      } catch (err) {
        console.error('Failed to ban IP', err);
      }
      return res.status(403).json({ error: 'Too many requests. Your IP has been banned.' });
    }

    next();
  };
};

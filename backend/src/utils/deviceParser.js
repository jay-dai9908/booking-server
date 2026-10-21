import prisma from '../prismaClient.js';

const normalizeIp = (raw) => {
  if (!raw || typeof raw !== 'string') return '';
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip === '::1') {
    ip = '127.0.0.1';
  }
  return ip;
};

const isLoopbackIp = (ip) => {
  if (!ip) return true;
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip.startsWith('127.');
};

/**
 * Extract clean client IP address from Express request (with client-reported public IP fallback when behind unconfigured local Nginx proxy)
 */
export const getClientIp = (req, clientInfo = {}) => {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    req.headers['x-real-ip'],
    req.headers['x-client-ip'],
    req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : '',
    clientInfo?.publicIp,
    req.query?.ip,
    req.ip,
    req.socket?.remoteAddress
  ];

  // First prefer any non-loopback IP (real public/WAN IP)
  for (const c of candidates) {
    const cleaned = normalizeIp(c);
    if (cleaned && !isLoopbackIp(cleaned)) {
      return cleaned;
    }
  }

  // Fallback to whatever loopback IP was present if running on localhost without internet
  for (const c of candidates) {
    const cleaned = normalizeIp(c);
    if (cleaned) return cleaned;
  }

  return '未知 IP';
};

/**
 * Parse User-Agent and optional clientInfo payload into structured device details
 */
export const parseDeviceDetails = (req, clientInfo = {}) => {
  const ua = req.headers['user-agent'] || '';
  const ip_address = getClientIp(req, clientInfo);

  // 1. Parse OS
  let os = '未知系統';
  const iosMatch = ua.match(/CPU (?:iPhone )?OS (\d+[_\d]*)/i);
  const androidMatch = ua.match(/Android (\d+(?:\.\d+)*)/i);
  const macMatch = ua.match(/Mac OS X (\d+[_\d.]*)/i);
  const winMatch = ua.match(/Windows NT (\d+\.\d+)/i);

  if (iosMatch) {
    os = `iOS ${iosMatch[1].replace(/_/g, '.')}`;
  } else if (androidMatch) {
    os = `Android ${androidMatch[1]}`;
  } else if (winMatch) {
    const ver = winMatch[1];
    os = ver === '10.0' ? 'Windows 10/11' : `Windows (${ver})`;
  } else if (macMatch) {
    os = `macOS ${macMatch[1].replace(/_/g, '.')}`;
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  // 2. Parse LINE Version & Browser container
  let line_version = null;
  const lineMatch = ua.match(/Line\/([\d.]+)/i);
  if (lineMatch) {
    line_version = lineMatch[1];
  }

  let browser = '一般瀏覽器';
  if (line_version) {
    browser = `LINE 內建瀏覽器 (v${line_version})`;
  } else if (/Instagram/i.test(ua)) {
    browser = 'Instagram 內建瀏覽器';
  } else if (/FBAN|FBAV/i.test(ua)) {
    browser = 'Facebook 內建瀏覽器';
  } else if (/EdgA?\/([\d.]+)/i.test(ua)) {
    browser = 'Microsoft Edge';
  } else if (/CriOS\/([\d.]+)/i.test(ua) || (/Chrome\/([\d.]+)/i.test(ua) && !/wv\)/i.test(ua))) {
    const m = ua.match(/(?:CriOS|Chrome)\/(\d+)/i);
    browser = m ? `Chrome (v${m[1]})` : 'Chrome';
  } else if (/Safari\//i.test(ua) && /Version\/([\d.]+)/i.test(ua)) {
    const m = ua.match(/Version\/([\d.]+)/i);
    browser = m ? `Safari (v${m[1]})` : 'Safari';
  } else if (/wv\)/i.test(ua)) {
    browser = 'Android WebView';
  }

  // 3. Parse Device Model
  let device_model = '未知裝置';
  const sw = Number(clientInfo?.screenWidth) || 0;
  const sh = Number(clientInfo?.screenHeight) || 0;
  const dpr = Number(clientInfo?.pixelRatio) || 0;
  const minDim = Math.min(sw, sh);
  const maxDim = Math.max(sw, sh);

  if (/iPhone/i.test(ua)) {
    if (minDim === 440 && maxDim === 956) {
      device_model = 'iPhone (16 Pro Max)';
    } else if (minDim === 402 && maxDim === 874) {
      device_model = 'iPhone (16 Pro)';
    } else if (minDim === 430 && maxDim === 932) {
      device_model = 'iPhone (14/15/16 Plus 或 Pro Max)';
    } else if (minDim === 393 && maxDim === 852) {
      device_model = 'iPhone (14 Pro / 15 / 16)';
    } else if (minDim === 428 && maxDim === 926) {
      device_model = 'iPhone (12/13 Pro Max 或 14 Plus)';
    } else if (minDim === 390 && maxDim === 844) {
      device_model = 'iPhone (12 / 13 / 14)';
    } else if (minDim === 375 && maxDim === 812) {
      device_model = 'iPhone (X / XS / 11 Pro / mini)';
    } else if (minDim === 414 && maxDim === 896) {
      device_model = dpr >= 3 ? 'iPhone (XS Max / 11 Pro Max)' : 'iPhone (XR / 11)';
    } else if (minDim === 375 && maxDim === 667) {
      device_model = 'iPhone (SE / 8 / 7)';
    } else {
      device_model = 'Apple iPhone';
    }
  } else if (/iPad/i.test(ua)) {
    device_model = 'Apple iPad';
  } else if (/Android/i.test(ua)) {
    // Extract model from "Linux; Android XX; <MODEL> Build/..." or "Linux; Android XX; <MODEL>; wv)"
    const modelMatch = ua.match(/Android [\d.]+;\s*(?:[a-z]{2}-[a-z]{2};\s*)?([^;)]+?)(?:\s+Build\/|;\s*wv\)|\))/i);
    if (modelMatch && modelMatch[1]) {
      const rawModel = modelMatch[1].trim();
      if (/^SM-/i.test(rawModel)) {
        device_model = `Samsung (${rawModel})`;
      } else if (/Pixel/i.test(rawModel)) {
        device_model = `Google ${rawModel}`;
      } else if (/^CPH/i.test(rawModel)) {
        device_model = `OPPO (${rawModel})`;
      } else if (/^V2/i.test(rawModel)) {
        device_model = `vivo (${rawModel})`;
      } else if (/ASUS/i.test(rawModel)) {
        device_model = `ASUS (${rawModel})`;
      } else if (/^XQ-/i.test(rawModel)) {
        device_model = `Sony (${rawModel})`;
      } else if (rawModel === 'K') {
        device_model = 'Android 手機 (Chrome 隱私型號 K)';
      } else {
        device_model = `Android (${rawModel})`;
      }
    } else {
      device_model = 'Android 行動裝置';
    }
  } else if (/Macintosh/i.test(ua)) {
    device_model = 'Mac 電腦';
  } else if (/Windows/i.test(ua)) {
    device_model = 'Windows 電腦';
  }

  // 4. Screen & Language
  let screen_info = null;
  if (sw && sh) {
    screen_info = `${sw}×${sh}${dpr ? ` @${dpr}x` : ''}`;
    if (clientInfo?.networkType) {
      screen_info += ` (${String(clientInfo.networkType).toUpperCase()})`;
    }
  }

  const language = clientInfo?.language || (req.headers['accept-language'] ? req.headers['accept-language'].split(',')[0] : null);

  return {
    ip_address,
    os,
    device_model,
    browser,
    line_version,
    screen_info,
    language,
    user_agent: ua.slice(0, 500)
  };
};

/**
 * Record user login/visit log and clean up records older than 60 days (2 months)
 */
export const recordUserLoginLog = async (userId, req, clientInfo = {}, options = { throttleMinutes: 0 }) => {
  try {
    if (!userId) return;
    const details = parseDeviceDetails(req, clientInfo);
    const now = new Date();

    // Update user's last_login_at
    await prisma.user.update({
      where: { id: userId },
      data: { last_login_at: now }
    });

    // If throttleMinutes > 0 (e.g. for /auth/me session resumes), avoid duplicate logs within short intervals
    if (options.throttleMinutes > 0) {
      const cutoff = new Date(now.getTime() - options.throttleMinutes * 60 * 1000);
      const recentLog = await prisma.userLoginLog.findFirst({
        where: {
          user_id: userId,
          created_at: { gte: cutoff }
        },
        orderBy: { created_at: 'desc' }
      });

      if (recentLog) {
        const needsScreenUpdate = !recentLog.screen_info && details.screen_info;
        const needsIpUpdate = isLoopbackIp(recentLog.ip_address) && !isLoopbackIp(details.ip_address);
        if (needsScreenUpdate || needsIpUpdate) {
          await prisma.userLoginLog.update({
            where: { id: recentLog.id },
            data: {
              ip_address: needsIpUpdate ? details.ip_address : recentLog.ip_address,
              screen_info: details.screen_info || recentLog.screen_info,
              device_model: details.device_model !== '未知裝置' ? details.device_model : recentLog.device_model,
              language: details.language || recentLog.language
            }
          });
        }
        return;
      }
    }

    await prisma.userLoginLog.create({
      data: {
        user_id: userId,
        ...details
      }
    });

    // Proactively purge logs older than 60 days (2 months)
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    await prisma.userLoginLog.deleteMany({
      where: {
        created_at: { lt: sixtyDaysAgo }
      }
    });
  } catch (err) {
    console.error('[recordUserLoginLog] Error:', err.message);
  }
};

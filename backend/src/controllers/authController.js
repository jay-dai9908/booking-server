import axios from 'axios';
import prisma from '../prismaClient.js';
import { generateToken, getSuperAdminFingerprint, syncAndVerifyAdminUser } from '../middlewares/authMiddleware.js';
import { recordUserLoginLog } from '../utils/deviceParser.js';
import { isPlainString, normalizeTwMobile } from '../utils/phone.js';
import { activeUserWhere } from '../utils/userQuery.js';

export const lineCallback = async (req, res) => {
  const { code, clientInfo } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  try {
    const channelId = process.env.LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const redirectUri = process.env.LINE_CALLBACK_URL;

    if (!channelId || !channelSecret || !redirectUri) {
      console.error('LINE configuration is missing in .env');
      return res.status(500).json({ error: 'Server misconfiguration: LINE setup incomplete' });
    }

    // 1. Exchange code for access token
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'authorization_code');
    tokenParams.append('code', code);
    tokenParams.append('redirect_uri', redirectUri);
    tokenParams.append('client_id', channelId);
    tokenParams.append('client_secret', channelSecret);

    const tokenResponse = await axios.post('https://api.line.me/oauth2/v2.1/token', tokenParams.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const accessToken = tokenResponse.data.access_token;

    // 2. Get user profile
    const profileResponse = await axios.get('https://api.line.me/v2/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const lineUserId = profileResponse.data.userId;
    const displayName = profileResponse.data.displayName || null;
    const pictureUrl = profileResponse.data.pictureUrl || null;
    const statusMessage = profileResponse.data.statusMessage || null;
    
    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { line_user_id: lineUserId },
    });

    if (user) {
      // Update LINE Profile info & last_login_at
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          line_display_name: displayName,
          line_picture_url: pictureUrl,
          line_status_msg: statusMessage,
          last_login_at: new Date()
        }
      });

      // Record login log (retained for 2 months)
      await recordUserLoginLog(user.id, req, clientInfo, { throttleMinutes: 0 });

      const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } }).catch(() => null);
      const requireEveryTime = !!globalSetting?.require_line_login_every_time;

      // Existing User -> Issue formal JWT
      const token = generateToken({ id: user.id, role: 'customer', typ: 'customer' });
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: requireEveryTime ? 4 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
      });
      return res.json({ 
        message: 'Login successful',
        token,
        user: { name: user.name, phone: user.phone, line_display_name: user.line_display_name, line_picture_url: user.line_picture_url },
        isNewUser: false,
        requireLineLoginEveryTime: requireEveryTime
      });
    } else {
      // New User -> Issue temporary JWT, include LINE profile info
      const tempToken = generateToken({
        line_user_id: lineUserId,
        line_display_name: displayName,
        line_picture_url: pictureUrl,
        line_status_msg: statusMessage,
        isTemp: true,
        typ: 'line_temp'
      }, { expiresIn: '30m' });
      res.cookie('token', tempToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 60 * 1000 }); // 30 mins
      return res.json({ 
        message: 'Registration required',
        token: tempToken,
        isNewUser: true,
        suggestedName: displayName
      });
    }
  } catch (error) {
    console.error('Line login error:', error.response?.data || error.message);
    const isLineClientError = error.response?.status === 400 || error.response?.data?.error === 'invalid_grant';
    const statusCode = isLineClientError ? 400 : 500;
    res.status(statusCode).json({ 
      error: 'LINE 登入驗證失敗，請重新嘗試'
    });
  }
};

export const register = async (req, res) => {
  const { name, phone, clientInfo } = req.body || {};
  const userPayload = req.user; // from verifyToken middleware
  
  if (!userPayload || userPayload.typ !== 'line_temp' || userPayload.isTemp !== true || !userPayload.line_user_id) {
    return res.status(401).json({ error: 'Invalid temporary session. Please login with LINE again.' });
  }

  if (!isPlainString(name)) {
    return res.status(400).json({ error: '姓名必須為文字' });
  }
  const cleanName = name.trim();
  if (cleanName.length < 1 || cleanName.length > 30) {
    return res.status(400).json({ error: '姓名長度須為 1～30 字' });
  }

  const normalizedPhone = normalizeTwMobile(phone);
  if (!normalizedPhone) {
    return res.status(400).json({
      code: 'INVALID_PHONE',
      error: '手機號碼格式不正確（09 開頭 10 碼）'
    });
  }

  try {
    const activeSamePhoneUsers = await prisma.user.findMany({
      where: activeUserWhere({ phone: normalizedPhone }),
      orderBy: { id: 'asc' }
    });

    const realLineUsers = activeSamePhoneUsers.filter(
      (u) => u.line_user_id && !u.line_user_id.startsWith('manual_')
    );
    const sameLineUser = realLineUsers.find((u) => u.line_user_id === userPayload.line_user_id);

    let finalUser;

    if (sameLineUser) {
      // 同一 LINE 帳號更新基本資料
      finalUser = await prisma.user.update({
        where: { id: sameLineUser.id },
        data: {
          name: cleanName,
          line_display_name: userPayload.line_display_name || null,
          line_picture_url: userPayload.line_picture_url || null,
          line_status_msg: userPayload.line_status_msg || null,
          last_login_at: new Date()
        }
      });
    } else if (realLineUsers.length > 0) {
      // 此手機號碼已被其他真實 LINE 帳號註冊綁定
      return res.status(409).json({
        error: '此手機號碼已被其他 LINE 帳號綁定。如需變更綁定，請直接聯繫門市人員。',
        code: 'PHONE_ALREADY_BOUND'
      });
    } else {
      // 原則：註冊時永遠不自動合併；同手機若有代建會員，建立 pending 綁定申請
      const manualUsers = activeSamePhoneUsers.filter(
        (u) => u.line_user_id && u.line_user_id.startsWith('manual_')
      );
      const now = new Date();

      finalUser = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            line_user_id: userPayload.line_user_id,
            name: cleanName,
            phone: normalizedPhone,
            line_display_name: userPayload.line_display_name || null,
            line_picture_url: userPayload.line_picture_url || null,
            line_status_msg: userPayload.line_status_msg || null,
            last_login_at: now
          }
        });

        for (const manualUser of manualUsers) {
          const activePasses = await tx.userPass.findMany({
            where: {
              user_id: manualUser.id,
              status: 'ACTIVE',
              payment_status: 'active',
              AND: [
                { OR: [{ expires_at: null }, { expires_at: { gt: now } }] },
                { OR: [{ remaining_quota: null }, { remaining_quota: { gt: 0 } }] }
              ]
            },
            orderBy: { id: 'asc' }
          });

          const passSummary = activePasses.map((p) => ({
            user_pass_id: p.id,
            plan_name: p.plan_name_snapshot,
            remaining: p.remaining_quota,
            expires_at: p.expires_at ? p.expires_at.toISOString() : null
          }));

          await tx.memberBindRequest.create({
            data: {
              new_user_id: createdUser.id,
              manual_user_id: manualUser.id,
              phone: normalizedPhone,
              status: 'pending',
              pass_summary: passSummary
            }
          });
        }

        return createdUser;
      });
    }

    // Record initial login log
    await recordUserLoginLog(finalUser.id, req, clientInfo, { throttleMinutes: 0 });

    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } }).catch(() => null);
    const requireEveryTime = !!globalSetting?.require_line_login_every_time;

    // Registration complete -> Issue formal JWT
    const token = generateToken({ id: finalUser.id, role: 'customer', typ: 'customer' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: requireEveryTime ? 4 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
    });
    
    res.json({
      message: 'Registration successful',
      token,
      user: { name: finalUser.name, phone: finalUser.phone },
      requireLineLoginEveryTime: requireEveryTime
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user.' });
  }
};

export const adminLogin = async (req, res) => {
  const rawPassword = req.body?.password;
  const inputPass = rawPassword ? String(rawPassword).trim() : '';

  const envAdminPassword = process.env.ADMIN_PASSWORD
    ? String(process.env.ADMIN_PASSWORD).trim().replace(/^["']|["']$/g, '').replace(/[\r\n]/g, '')
    : '';

  // 嚴格大小寫比對環境變數中的 ADMIN_PASSWORD，不再保留任何寫死預設值
  const isSuperAdminMatch = Boolean(envAdminPassword && inputPass === envAdminPassword);
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';

  if (isSuperAdminMatch) {
    const pwdHash = getSuperAdminFingerprint();
    const token = generateToken({
      role: 'admin',
      isSuperAdmin: true,
      name: '最高管理員',
      pwd_hash: pwdHash,
      permissions: ['all']
    }, { expiresIn: '12h' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000 // 後台 token 效期縮短至 12 小時 (約一個班次)
    });
    return res.json({
      message: 'Admin login successful',
      token,
      admin: { name: '最高管理員', isSuperAdmin: true, permissions: ['all'] }
    });
  }

  try {
    const activeStaffs = await prisma.adminUser.findMany({
      where: { is_active: true }
    });

    // 員工密碼比對維持精確字串比對
    const staff = activeStaffs.find(s => s.password === inputPass);

    if (staff) {
      const isSuperAdmin = staff.role === 'super_admin';
      const token = generateToken({
        id: staff.id,
        role: 'admin',
        isSuperAdmin,
        name: staff.name,
        token_version: staff.token_version,
        permissions: isSuperAdmin ? ['all'] : staff.permissions
      }, { expiresIn: '12h' });

      res.cookie('token', token, {
        httpOnly: true,
        secure: isHttps,
        sameSite: 'lax',
        maxAge: 12 * 60 * 60 * 1000 // 後台 token 效期縮短至 12 小時
      });
      return res.json({
        message: 'Staff login successful',
        token,
        admin: {
          name: staff.name,
          isSuperAdmin,
          permissions: isSuperAdmin ? ['all'] : staff.permissions
        }
      });
    }

    return res.status(401).json({ error: '密碼錯誤，請重新輸入' });
  } catch (error) {
    console.error('Staff login error:', error);
    return res.status(500).json({ error: '登入驗證時伺服器發生錯誤' });
  }
};

export const logout = (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
};

export const me = async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const verifiedAdmin = await syncAndVerifyAdminUser(req.user);
      if (!verifiedAdmin) {
        res.clearCookie('token');
        return res.status(401).json({ error: '後台登入憑證已失效或已變更，請重新登入' });
      }
      return res.json({
        role: 'admin',
        isSuperAdmin: verifiedAdmin.isSuperAdmin,
        name: verifiedAdmin.name || '最高管理員',
        permissions: verifiedAdmin.permissions || []
      });
    }

    if (req.user.role === 'customer' && req.user.typ !== 'customer') {
      res.clearCookie('token');
      return res.status(401).json({ error: '登入憑證已過期，請重新登入' });
    }

    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } }).catch(() => null);
    const requireEveryTime = !!globalSetting?.require_line_login_every_time;

    // If admin enabled "顧客每次使用皆須從 LINE 登入", only allow when current browser session has fresh login
    if (requireEveryTime && !req.user.isTemp) {
      if (req.query.fresh_session !== '1') {
        res.clearCookie('token');
        return res.status(401).json({
          error: 'Require fresh LINE login on every visit',
          requireLineLoginEveryTime: true
        });
      }
    }
    
    if (req.user.isTemp) {
      return res.json({ role: 'temp_customer', requireLineLoginEveryTime: requireEveryTime });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        phone: true,
        line_display_name: true,
        line_picture_url: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Record visit/login activity (throttled to 1 log per 30 mins to avoid spam on page reloads)
    const clientInfo = {
      screenWidth: req.query.sw,
      screenHeight: req.query.sh,
      pixelRatio: req.query.dpr,
      language: req.query.lang,
      networkType: req.query.net,
      publicIp: req.query.ip
    };
    recordUserLoginLog(user.id, req, clientInfo, { throttleMinutes: 30 }).catch(() => {});

    res.json({ role: 'customer', user, requireLineLoginEveryTime: requireEveryTime });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

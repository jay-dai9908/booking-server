import axios from 'axios';
import prisma from '../prismaClient.js';
import { generateToken } from '../middlewares/authMiddleware.js';
import { recordUserLoginLog } from '../utils/deviceParser.js';

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
      const token = generateToken({ id: user.id, role: 'customer' });
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
        isTemp: true
      });
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
    res.status(500).json({ 
      error: 'Internal server error during Line login', 
      details: error.response?.data 
    });
  }
};

export const register = async (req, res) => {
  const { name, phone, clientInfo } = req.body;
  const userPayload = req.user; // from verifyToken middleware
  
  if (!userPayload || !userPayload.isTemp || !userPayload.line_user_id) {
    return res.status(400).json({ error: 'Invalid temporary session. Please login with LINE again.' });
  }

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required.' });
  }

  try {
    const existingUser = await prisma.user.findFirst({
      where: { phone }
    });

    let finalUser;

    if (existingUser) {
      if (existingUser.line_user_id.startsWith('manual_')) {
        finalUser = await prisma.user.update({
          where: { id: existingUser.id },
          data: { 
            line_user_id: userPayload.line_user_id,
            name, // 依據顧客自己填寫的名稱更新
            line_display_name: userPayload.line_display_name || null,
            line_picture_url: userPayload.line_picture_url || null,
            line_status_msg: userPayload.line_status_msg || null,
            last_login_at: new Date()
          }
        });
      } else if (existingUser.line_user_id === userPayload.line_user_id) {
        // 同一 LINE 帳號更新基本資料
        finalUser = await prisma.user.update({
          where: { id: existingUser.id },
          data: {
            name,
            line_display_name: userPayload.line_display_name || null,
            line_picture_url: userPayload.line_picture_url || null,
            line_status_msg: userPayload.line_status_msg || null,
            last_login_at: new Date()
          }
        });
      } else {
        // 此手機號碼已被其他真實 LINE 帳號註冊綁定
        return res.status(409).json({ 
          error: '此手機號碼已被其他 LINE 帳號綁定。如需變更綁定，請直接聯繫門市人員。',
          code: 'PHONE_ALREADY_BOUND'
        });
      }
    } else {
      finalUser = await prisma.user.create({
        data: {
          line_user_id: userPayload.line_user_id,
          name,
          phone,
          line_display_name: userPayload.line_display_name || null,
          line_picture_url: userPayload.line_picture_url || null,
          line_status_msg: userPayload.line_status_msg || null,
          last_login_at: new Date()
        },
      });
    }

    // Record initial login log
    await recordUserLoginLog(finalUser.id, req, clientInfo, { throttleMinutes: 0 });

    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } }).catch(() => null);
    const requireEveryTime = !!globalSetting?.require_line_login_every_time;

    // Registration complete -> Issue formal JWT
    const token = generateToken({ id: finalUser.id, role: 'customer' });
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
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'gathering.light2609';

  if (password === adminPassword) {
    const token = generateToken({
      role: 'admin',
      isSuperAdmin: true,
      name: '最高管理員',
      permissions: ['all']
    });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    return res.json({
      message: 'Admin login successful',
      admin: { name: '最高管理員', isSuperAdmin: true, permissions: ['all'] }
    });
  }

  try {
    const staff = await prisma.adminUser.findUnique({
      where: { password }
    });

    if (staff) {
      if (!staff.is_active) {
        return res.status(403).json({ error: '此人員帳號已被停用，請聯繫店長' });
      }

      const isSuperAdmin = staff.role === 'super_admin';
      const token = generateToken({
        id: staff.id,
        role: 'admin',
        isSuperAdmin,
        name: staff.name,
        permissions: isSuperAdmin ? ['all'] : staff.permissions
      });
      res.cookie('token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
      return res.json({
        message: 'Staff login successful',
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
      const isSuper = !!(req.user.isSuperAdmin || (!req.user.id && req.user.isSuperAdmin === undefined && !req.user.permissions));
      return res.json({
        role: 'admin',
        isSuperAdmin: isSuper,
        name: req.user.name || '最高管理員',
        permissions: isSuper ? ['all'] : (req.user.permissions || [])
      });
    }

    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } }).catch(() => null);
    const requireEveryTime = !!globalSetting?.require_line_login_every_time;

    // If admin enabled "顧客每次使用皆須從 LINE 登入", only clear old cookie when customer enters at `/` (entry_home === '1')
    // Never clear the cookie when already inside `/booking` or `/history`!
    if (requireEveryTime && !req.user.isTemp) {
      if (req.query.entry_home === '1') {
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

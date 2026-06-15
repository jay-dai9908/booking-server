import axios from 'axios';
import prisma from '../prismaClient.js';
import { generateToken } from '../middlewares/authMiddleware.js';

export const lineCallback = async (req, res) => {
  const { code } = req.body;
  
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
    const displayName = profileResponse.data.displayName; // (We can use this later or store it, but for now we follow the MVP flow)
    
    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { line_user_id: lineUserId },
    });

    if (user) {
      // Existing User -> Issue formal JWT
      const token = generateToken({ id: user.id, role: 'customer' });
      res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
      return res.json({ 
        message: 'Login successful', 
        user: { name: user.name, phone: user.phone },
        isNewUser: false 
      });
    } else {
      // New User -> Issue temporary JWT, pass displayName as suggested name if wanted
      const tempToken = generateToken({ line_user_id: lineUserId, isTemp: true });
      res.cookie('token', tempToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 15 * 60 * 1000 }); // 15 mins
      return res.json({ 
        message: 'Registration required', 
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
  const { name, phone } = req.body;
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

    if (existingUser && existingUser.line_user_id.startsWith('manual_')) {
      finalUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: { 
          line_user_id: userPayload.line_user_id,
          name // 依據顧客自己填寫的名稱更新
        }
      });
    } else {
      finalUser = await prisma.user.create({
        data: {
          line_user_id: userPayload.line_user_id,
          name,
          phone,
        },
      });
    }

    // Registration complete -> Issue formal JWT
    const token = generateToken({ id: finalUser.id, role: 'customer' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    
    res.json({ message: 'Registration successful', user: { name: finalUser.name, phone: finalUser.phone } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to register user.' });
  }
};

export const adminLogin = async (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

  if (password === adminPassword) {
    const token = generateToken({ role: 'admin' });
    res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ message: 'Admin login successful' });
  } else {
    res.status(401).json({ error: 'Invalid admin credentials' });
  }
};

export const logout = (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out successfully' });
};

export const me = async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ role: 'admin' });
    }
    
    if (req.user.isTemp) {
      return res.json({ role: 'temp_customer' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { name: true, phone: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ role: 'customer', user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

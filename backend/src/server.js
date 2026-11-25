import './loadEnv.js';
process.env.TZ = 'Asia/Taipei';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import prisma from './prismaClient.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import reservationRoutes from './routes/reservations.js';
import { checkBannedIP } from './middlewares/rateLimiter.js';
import userRoutes from './routes/users.js';
import dailySettingsRoutes from './routes/dailySettings.js';
import { getGlobalSetting } from './controllers/dailySettingController.js';
import accountingRoutes from './routes/accounting.js';
import staffRoutes from './routes/staff.js';
import equipmentRoutes from './routes/equipment.js';
import checkoutRoutes from './routes/checkout.js';
import shopRoutes from './routes/shop.js';
import passRoutes from './routes/passes.js';
import seatLayoutRoutes from './routes/seatLayouts.js';
import floorRoutes from './routes/floor.js';
import billingRoutes from './routes/billing.js';
import printRoutes from './routes/print.js';
import kioskRoutes from './routes/kiosk.js';
import displayRoutes from './routes/display.js';
import { ensureDefaultEquipmentConfigs } from './controllers/equipmentController.js';
import { ensureDefaultCheckoutConfigs } from './controllers/checkoutController.js';
import { ensureDefaultPaymentMethods, ensureDefaultProducts, ensureDefaultPassPlans } from './utils/shopDefaults.js';
import { resolveTrustProxy } from './utils/trustProxy.js';
import { applyBodyParsers } from './middlewares/bodyParsers.js';
import { startCronJobs } from './cronJobs.js';
import { solidifyDailyPrices } from './services/pricing/solidify.js';
import { runCronOnce } from './services/cron/cronLock.js';
import { toTaipeiDateString } from '../../shared/time.js';
import { ensureDatabaseSchema } from './db/ensureSchema.js';
import { isAccountingGuardInstalled, setStartupAccountingGuardMissing } from './db/accountingGuard.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const trustProxyVal = resolveTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', trustProxyVal);
console.log(`[trust proxy] ${trustProxyVal}`);
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies to be sent
}));
app.use(checkBannedIP);
applyBodyParsers(app);
app.use(cookieParser());

// Routes
app.get('/', (req, res) => {
  res.send('預約系統後端伺服器運行中！請前往前端網址 (通常為 http://localhost:5173) 操作系統。');
});
app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/users', userRoutes);
app.use('/api/daily-settings', dailySettingsRoutes);
app.get('/api/global-settings', getGlobalSetting);
app.use('/api/accounting', accountingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/passes', passRoutes);
app.use('/api/seat-layouts', seatLayoutRoutes);
app.use('/api/floor', floorRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/print', printRoutes);
app.use('/api/kiosk', kioskRoutes);
app.use('/api/display', displayRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({ error: '資料太大' });
  }
  if (err instanceof SyntaxError && err?.status === 400 && 'body' in err) {
    if (req.originalUrl?.startsWith('/api/kiosk/v1')) {
      return res.status(401).json({ error: 'KIOSK_AUTH' });
    }
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

// Initialize database schema BEFORE listening so no request hits Prisma before columns exist
(async () => {
  try {
    await ensureDatabaseSchema();
  } catch (err) {
    console.error('[Startup] ensureDatabaseSchema notice:', err?.message || err);
  }

  try {
    const guardOk = await isAccountingGuardInstalled(prisma);
    setStartupAccountingGuardMissing(!guardOk);
    if (guardOk) {
      console.log('[Schema Check] AccountingEvent guard installed');
    } else {
      console.error('[Schema Check] AccountingEvent guard NOT installed — check DB trigger permissions');
    }
  } catch (err) {
    setStartupAccountingGuardMissing(true);
    console.error('[Schema Check] AccountingEvent guard check failed:', err?.message || err);
  }

  try {
    const todayStr = toTaipeiDateString(new Date());
    const yesterdayMid = new Date(new Date(`${todayStr}T00:00:00.000Z`).getTime() - 86400000);
    await runCronOnce('solidify_prices', `startup-${todayStr}`, () =>
      solidifyDailyPrices({ through: yesterdayMid })
    );
  } catch (err) {
    console.error('[Startup] solidifyDailyPrices notice:', err?.message || err);
  }

  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });

  try {
    await ensureDefaultEquipmentConfigs();
  } catch (err) {
    console.error('[Startup] ensureDefaultEquipmentConfigs notice:', err?.message || err);
  }
  try {
    await ensureDefaultCheckoutConfigs();
  } catch (err) {
    console.error('[Startup] ensureDefaultCheckoutConfigs notice:', err?.message || err);
  }
  try {
    if (prisma?.paymentMethodConfig) {
      await ensureDefaultPaymentMethods();
    }
  } catch (err) {
    console.error('[Startup] ensureDefaultPaymentMethods notice:', err?.message || err);
  }
  try {
    if (prisma?.product) {
      await ensureDefaultProducts();
    }
  } catch (err) {
    console.error('[Startup] ensureDefaultProducts notice:', err?.message || err);
  }
  try {
    if (prisma?.passPlan) {
      await ensureDefaultPassPlans();
    }
  } catch (err) {
    console.error('[Startup] ensureDefaultPassPlans notice:', err?.message || err);
  }
  try {
    startCronJobs();
  } catch (err) {
    console.error('[Startup] startCronJobs notice:', err?.message || err);
  }
})();

process.env.TZ = 'Asia/Taipei';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import prisma from './prismaClient.js';
import authRoutes from './routes/auth.js';
import sessionRoutes from './routes/sessions.js';
import reservationRoutes from './routes/reservations.js';
import { checkBannedIP } from './middlewares/rateLimiter.js';
import userRoutes from './routes/users.js';
import dailySettingsRoutes from './routes/dailySettings.js';
import accountingRoutes from './routes/accounting.js';
import staffRoutes from './routes/staff.js';
import equipmentRoutes from './routes/equipment.js';
import checkoutRoutes from './routes/checkout.js';
import { ensureDefaultEquipmentConfigs } from './controllers/equipmentController.js';
import { ensureDefaultCheckoutConfigs } from './controllers/checkoutController.js';
import { startCronJobs } from './cronJobs.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-ensure schema columns & tables exist so deployments without manual `prisma db push` never fail
const ensureDatabaseSchema = async () => {
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_display_name" TEXT;
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_picture_url" TEXT;
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_status_msg" TEXT;
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);

      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "payment_method" TEXT;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_unlimited_pax" INTEGER;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_regular_hours" DOUBLE PRECISION;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_details" JSONB;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "promo_code" TEXT;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "discount_amount" INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "addons_amount" INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "allow_equipment_exceed_pax" BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_equipment_live_stock" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_enabled" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_buy_hours" INTEGER NOT NULL DEFAULT 3;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_free_hours" INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_stackable" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_enabled" BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_buy_hours" INTEGER NOT NULL DEFAULT 8;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_free_hours" INTEGER NOT NULL DEFAULT 4;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_price_cards" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "price_notice_text" TEXT DEFAULT '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品';
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_announcement" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "announcement_text" TEXT DEFAULT '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠';
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_line_button" BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "line_button_url" TEXT DEFAULT 'https://lin.ee/vsZhRW5';

      CREATE TABLE IF NOT EXISTS "UserLoginLog" (
        "id" SERIAL NOT NULL,
        "user_id" INTEGER NOT NULL,
        "ip_address" TEXT,
        "os" TEXT,
        "device_model" TEXT,
        "browser" TEXT,
        "line_version" TEXT,
        "screen_info" TEXT,
        "language" TEXT,
        "user_agent" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "UserLoginLog_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "UserLoginLog_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "os" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "device_model" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "browser" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "line_version" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "screen_info" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "language" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "ip_address" TEXT;
      ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "user_agent" TEXT;
      CREATE INDEX IF NOT EXISTS "UserLoginLog_user_id_created_at_idx" ON "UserLoginLog"("user_id", "created_at");
      CREATE INDEX IF NOT EXISTS "UserLoginLog_created_at_idx" ON "UserLoginLog"("created_at");

      CREATE TABLE IF NOT EXISTS "PromoCode" (
        "id" SERIAL NOT NULL,
        "code" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "discount_type" TEXT NOT NULL DEFAULT 'fixed_order',
        "discount_value" INTEGER NOT NULL DEFAULT 0,
        "max_discount_amount" INTEGER,
        "target_scope" TEXT NOT NULL DEFAULT 'all',
        "day_type_limit" TEXT NOT NULL DEFAULT 'all',
        "mode_limit" TEXT NOT NULL DEFAULT 'all',
        "channel" TEXT NOT NULL DEFAULT 'all',
        "min_pax" INTEGER NOT NULL DEFAULT 1,
        "min_hours" INTEGER NOT NULL DEFAULT 1,
        "min_amount" INTEGER NOT NULL DEFAULT 0,
        "max_uses" INTEGER,
        "used_count" INTEGER NOT NULL DEFAULT 0,
        "max_uses_per_user" INTEGER,
        "start_date" DATE,
        "end_date" DATE,
        "is_pos_quick_select" BOOLEAN NOT NULL DEFAULT false,
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
      );
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "max_discount_amount" INTEGER;
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "target_scope" TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "day_type_limit" TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "mode_limit" TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "start_date" DATE;
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "end_date" DATE;
      ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
      CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode"("code");

      CREATE TABLE IF NOT EXISTS "AddonItem" (
        "id" SERIAL NOT NULL,
        "name" TEXT NOT NULL,
        "price" INTEGER NOT NULL,
        "category" TEXT NOT NULL DEFAULT 'charm',
        "is_active" BOOLEAN NOT NULL DEFAULT true,
        "sort_order" INTEGER NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AddonItem_pkey" PRIMARY KEY ("id")
      );
    `);
  } catch (err) {
    console.error('[Schema Check] Warning during ensureDatabaseSchema:', err.message);
  }
};

// Initialize database schema, default configs, and cron jobs
(async () => {
  await ensureDatabaseSchema();
  await ensureDefaultEquipmentConfigs();
  await ensureDefaultCheckoutConfigs();
  startCronJobs();
})();

app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies to be sent
}));
app.use(checkBannedIP);
app.use(express.json());
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
app.use('/api/accounting', accountingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/checkout', checkoutRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

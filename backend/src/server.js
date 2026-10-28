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
import { getGlobalSetting } from './controllers/dailySettingController.js';
import accountingRoutes from './routes/accounting.js';
import staffRoutes from './routes/staff.js';
import equipmentRoutes from './routes/equipment.js';
import checkoutRoutes from './routes/checkout.js';
import shopRoutes from './routes/shop.js';
import passRoutes from './routes/passes.js';
import { ensureDefaultEquipmentConfigs } from './controllers/equipmentController.js';
import { ensureDefaultCheckoutConfigs } from './controllers/checkoutController.js';
import { ensureDefaultPaymentMethods, ensureDefaultProducts, ensureDefaultPassPlans } from './utils/shopDefaults.js';
import { startCronJobs } from './cronJobs.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

// Auto-ensure schema columns & tables exist so deployments without manual `prisma db push` never fail
// IMPORTANT: PostgreSQL prepared statements via prisma.$executeRawUnsafe only allow ONE command per call!
const ensureDatabaseSchema = async () => {
  const statements = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_display_name" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_picture_url" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "line_status_msg" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3)`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "is_blacklisted" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "notes" TEXT`,

    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "payment_method" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_unlimited_pax" INTEGER`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_regular_hours" DOUBLE PRECISION`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checkout_details" JSONB`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "promo_code" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "discount_amount" INTEGER DEFAULT 0`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "addons_amount" INTEGER DEFAULT 0`,

    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "allow_equipment_exceed_pax" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_equipment_live_stock" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_enabled" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_buy_hours" INTEGER NOT NULL DEFAULT 3`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_free_hours" INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount_stackable" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_enabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_buy_hours" INTEGER NOT NULL DEFAULT 8`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "equipment_discount2_free_hours" INTEGER NOT NULL DEFAULT 4`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_price_cards" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "price_notice_text" TEXT DEFAULT '費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_announcement" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "announcement_text" TEXT DEFAULT '✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_line_button" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "line_button_url" TEXT DEFAULT 'https://lin.ee/vsZhRW5'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "require_line_login_every_time" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "enable_preview_page" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "preview_disabled_text" TEXT DEFAULT '系統維護中，請點擊下方按鈕使用 LINE 進行預約'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "line_messaging_token" TEXT`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "line_auto_notify_booking" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "line_auto_notify_cancel" BOOLEAN NOT NULL DEFAULT false`,

    `CREATE TABLE IF NOT EXISTS "UserLoginLog" (
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
    )`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "os" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "device_model" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "browser" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "line_version" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "screen_info" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "language" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "ip_address" TEXT`,
    `ALTER TABLE "UserLoginLog" ADD COLUMN IF NOT EXISTS "user_agent" TEXT`,
    `CREATE INDEX IF NOT EXISTS "UserLoginLog_user_id_created_at_idx" ON "UserLoginLog"("user_id", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "UserLoginLog_created_at_idx" ON "UserLoginLog"("created_at")`,

    `CREATE TABLE IF NOT EXISTS "PromoCode" (
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
    )`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "max_discount_amount" INTEGER`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "target_scope" TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "day_type_limit" TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "mode_limit" TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'all'`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "min_pax" INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "min_hours" INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "min_amount" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "max_uses" INTEGER`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "used_count" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "max_uses_per_user" INTEGER`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "is_pos_quick_select" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "start_date" DATE`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "end_date" DATE`,
    `ALTER TABLE "PromoCode" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PromoCode_code_key" ON "PromoCode"("code")`,

    `CREATE TABLE IF NOT EXISTS "AddonItem" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL,
      "price" INTEGER NOT NULL,
      "category" TEXT NOT NULL DEFAULT 'charm',
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AddonItem_pkey" PRIMARY KEY ("id")
    )`,
    `ALTER TABLE "AddonItem" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT 'charm'`,
    `ALTER TABLE "AddonItem" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "AddonItem" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0`,

    `DELETE FROM "BannedIP" WHERE "reason" IN ('Too many login attempts', 'Too many reservation queries')`,
    `UPDATE "GlobalSetting" SET "is_lockdown_mode" = false WHERE "id" = 1`,

    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_enabled" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_deposit_deadline_days" INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_default_arrival_note" TEXT DEFAULT '預計 11/10 ~ 11/15 到貨，商品抵達門市後將發送 LINE 訊息通知取貨'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_enable_shipping" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_shipping_fee" INTEGER NOT NULL DEFAULT 60`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "official_line_url" TEXT DEFAULT 'https://lin.ee/vsZhRW5'`,

    `CREATE TABLE IF NOT EXISTS "PaymentMethodConfig" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "method_type" TEXT NOT NULL,
      "is_enabled" BOOLEAN NOT NULL DEFAULT true,
      "display_instructions" TEXT,
      "bank_accounts_json" JSONB,
      "require_last5" BOOLEAN NOT NULL DEFAULT true,
      "show_line_verify_btn" BOOLEAN NOT NULL DEFAULT true,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaymentMethodConfig_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PaymentMethodConfig_code_key" ON "PaymentMethodConfig"("code")`,

    `CREATE TABLE IF NOT EXISTS "OneTimeAccountPool" (
      "id" SERIAL NOT NULL,
      "payment_method_code" TEXT NOT NULL DEFAULT 'ctbc_pool',
      "bank_code" TEXT NOT NULL DEFAULT '822',
      "bank_name" TEXT NOT NULL DEFAULT '中國信託（社群收款專屬帳號）',
      "account_number" TEXT NOT NULL,
      "payment_url" TEXT,
      "note" TEXT,
      "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
      "assigned_order_ref" TEXT,
      "assigned_user_id" INTEGER,
      "assigned_at" TIMESTAMP(3),
      "verified_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "OneTimeAccountPool_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "OneTimeAccountPool_account_number_key" ON "OneTimeAccountPool"("account_number")`,

    `CREATE TABLE IF NOT EXISTS "Product" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "category" TEXT NOT NULL DEFAULT 'bundle',
      "description" TEXT,
      "image_url" TEXT,
      "price" INTEGER NOT NULL,
      "is_preorder" BOOLEAN NOT NULL DEFAULT true,
      "deposit_amount" INTEGER NOT NULL DEFAULT 600,
      "estimated_arrival_text" TEXT,
      "allow_wish_input" BOOLEAN NOT NULL DEFAULT false,
      "wish_input_placeholder" TEXT DEFAULT '可輸入喜歡的顏色、款式或 IP 角色（例如：吉伊卡哇、馬卡龍粉、雙針筆優先）',
      "bonus_pass_plan_code" TEXT,
      "tier_pricing" JSONB,
      "visibility_status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Product_code_key" ON "Product"("code")`,

    `CREATE TABLE IF NOT EXISTS "ProductOrder" (
      "id" SERIAL NOT NULL,
      "order_ref" TEXT NOT NULL,
      "user_id" INTEGER NOT NULL,
      "total_amount" INTEGER NOT NULL,
      "shipping_fee" INTEGER NOT NULL DEFAULT 0,
      "deposit_required" INTEGER NOT NULL,
      "paid_amount" INTEGER NOT NULL DEFAULT 0,
      "balance_amount" INTEGER NOT NULL,
      "payment_method_code" TEXT NOT NULL,
      "selected_bank_info" TEXT,
      "assigned_pool_account" TEXT,
      "assigned_pool_url" TEXT,
      "remittance_last5" TEXT,
      "remittance_reported_at" TIMESTAMP(3),
      "payment_deadline" TIMESTAMP(3),
      "payment_status" TEXT NOT NULL DEFAULT 'pending_payment',
      "order_status" TEXT NOT NULL DEFAULT 'preorder_placed',
      "delivery_method" TEXT NOT NULL DEFAULT 'store_pickup',
      "shipping_info_json" JSONB,
      "estimated_arrival" TEXT,
      "wish_note" TEXT,
      "wish_reply" TEXT,
      "customer_note" TEXT,
      "admin_note" TEXT,
      "arrived_notified_at" TIMESTAMP(3),
      "picked_up_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProductOrder_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "ProductOrder_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "ProductOrder_order_ref_key" ON "ProductOrder"("order_ref")`,

    `CREATE TABLE IF NOT EXISTS "ProductOrderItem" (
      "id" SERIAL NOT NULL,
      "order_id" INTEGER NOT NULL,
      "product_id" INTEGER,
      "product_code_snapshot" TEXT NOT NULL,
      "product_name_snapshot" TEXT NOT NULL,
      "price_snapshot" INTEGER NOT NULL,
      "quantity" INTEGER NOT NULL,
      "subtotal" INTEGER NOT NULL,
      "customization_note" TEXT,
      CONSTRAINT "ProductOrderItem_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "ProductOrderItem_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ProductOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProductOrderItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS "PassPlan" (
      "id" SERIAL NOT NULL,
      "code" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "pass_type" TEXT NOT NULL,
      "price" INTEGER NOT NULL DEFAULT 0,
      "is_purchasable_online" BOOLEAN NOT NULL DEFAULT false,
      "total_quota" INTEGER,
      "valid_days" INTEGER,
      "day_restriction" TEXT NOT NULL DEFAULT 'ALL',
      "max_hours_per_day" INTEGER,
      "max_days_per_week" INTEGER,
      "max_hours_per_week" INTEGER,
      "discount_percent" INTEGER,
      "description" TEXT,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PassPlan_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PassPlan_code_key" ON "PassPlan"("code")`,

    `CREATE TABLE IF NOT EXISTS "UserPass" (
      "id" SERIAL NOT NULL,
      "pass_code" TEXT NOT NULL,
      "user_id" INTEGER NOT NULL,
      "plan_id" INTEGER NOT NULL,
      "plan_name_snapshot" TEXT NOT NULL,
      "pass_type" TEXT NOT NULL,
      "remaining_quota" INTEGER,
      "total_quota" INTEGER,
      "day_restriction" TEXT NOT NULL DEFAULT 'ALL',
      "max_hours_per_day" INTEGER,
      "max_days_per_week" INTEGER,
      "max_hours_per_week" INTEGER,
      "usage_logs_json" JSONB,
      "payment_status" TEXT NOT NULL DEFAULT 'active',
      "order_ref" TEXT,
      "expires_at" TIMESTAMP(3),
      "status" TEXT NOT NULL DEFAULT 'ACTIVE',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "UserPass_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "UserPass_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "UserPass_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "PassPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "UserPass_pass_code_key" ON "UserPass"("pass_code")`
  ];

  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      console.error('[Schema Check] Warning on statement:', err.message);
    }
  }
  console.log('[Schema Check] Database schema verified successfully.');
};

// Initialize database schema, default configs, and cron jobs
(async () => {
  await ensureDatabaseSchema();
  await ensureDefaultEquipmentConfigs();
  await ensureDefaultCheckoutConfigs();
  await ensureDefaultPaymentMethods();
  await ensureDefaultProducts();
  await ensureDefaultPassPlans();
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
app.get('/api/global-settings', getGlobalSetting);
app.use('/api/accounting', accountingRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/passes', passRoutes);

// Basic error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong on the server!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

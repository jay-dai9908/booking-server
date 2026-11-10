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
import { ensureDefaultEquipmentConfigs } from './controllers/equipmentController.js';
import { ensureDefaultCheckoutConfigs } from './controllers/checkoutController.js';
import { ensureDefaultPaymentMethods, ensureDefaultProducts, ensureDefaultPassPlans } from './utils/shopDefaults.js';
import { startCronJobs } from './cronJobs.js';

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
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "customer_note" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "admin_note" TEXT`,

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

    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "checked_in_by" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "seat_source" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "billing_status" TEXT`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "has_refund" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "paid_persons" INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "amount_due" INTEGER`,
    `ALTER TABLE "Reservation" ADD COLUMN IF NOT EXISTS "amount_received" INTEGER NOT NULL DEFAULT 0`,

    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "person_id" INTEGER`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "unit_group" TEXT`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "segment_no" INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "start_at" TIMESTAMP(3)`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "end_at" TIMESTAMP(3)`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "unit_rate" INTEGER`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "ended_reason" TEXT`,
    `ALTER TABLE "BookingEquipment" ADD COLUMN IF NOT EXISTS "planned_end_at" TIMESTAMP(3)`,

    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "billing_grace_minutes" INTEGER NOT NULL DEFAULT 10`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "billing_block_minutes" INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "early_leave_mode" TEXT NOT NULL DEFAULT 'booked'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "board_swap_grace_minutes" INTEGER NOT NULL DEFAULT 10`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "payment_methods_json" JSONB`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "default_split_mode" TEXT NOT NULL DEFAULT 'proportional'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "cash_float_amount" INTEGER NOT NULL DEFAULT 2000`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "auto_print_receipt" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "auto_print_summary" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "receipt_footer_text" TEXT DEFAULT '謝謝光臨，作品記得帶回家'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "print_lease_seconds" INTEGER NOT NULL DEFAULT 60`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "seat_layout_enabled" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "default_session_capacity" INTEGER NOT NULL DEFAULT 16`,

    `ALTER TABLE "PassPlan" ADD COLUMN IF NOT EXISTS "checkout_effect" TEXT`,
    `ALTER TABLE "PassPlan" ADD COLUMN IF NOT EXISTS "checkout_scope" TEXT NOT NULL DEFAULT 'entry'`,
    `ALTER TABLE "PassPlan" ADD COLUMN IF NOT EXISTS "checkout_value" INTEGER`,

    `ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0`,
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
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "show_shop_button" BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_deposit_deadline_days" INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_default_arrival_note" TEXT DEFAULT '預計 11/10 ~ 11/15 到貨，商品抵達門市後將發送 LINE 訊息通知取貨'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_enable_shipping" BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "shop_shipping_fee" INTEGER NOT NULL DEFAULT 60`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "official_line_url" TEXT DEFAULT 'https://lin.ee/vsZhRW5'`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "bead_colors_json" JSONB`,
    `ALTER TABLE "GlobalSetting" ADD COLUMN IF NOT EXISTS "print_enabled" BOOLEAN NOT NULL DEFAULT true`,

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
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "images_json" JSONB`,
    `ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "tier_discount_mode" TEXT NOT NULL DEFAULT 'combined'`,
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
    `CREATE UNIQUE INDEX IF NOT EXISTS "UserPass_pass_code_key" ON "UserPass"("pass_code")`,

    `CREATE TABLE IF NOT EXISTS "SeatLayout" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL DEFAULT '店內格局',
      "status" TEXT NOT NULL DEFAULT 'draft',
      "effective_from" DATE,
      "canvas_w" INTEGER NOT NULL DEFAULT 1000,
      "canvas_h" INTEGER NOT NULL DEFAULT 625,
      "seat_tile_w" INTEGER NOT NULL DEFAULT 60,
      "seat_tile_h" INTEGER NOT NULL DEFAULT 46,
      "grid_size" INTEGER NOT NULL DEFAULT 10,
      "background_image" TEXT,
      "background_opacity" DOUBLE PRECISION NOT NULL DEFAULT 0.35,
      "background_rect" JSONB,
      "elements_json" JSONB NOT NULL DEFAULT '[]',
      "rules_json" JSONB NOT NULL DEFAULT '{}',
      "capacity" INTEGER NOT NULL DEFAULT 0,
      "created_by_name" TEXT,
      "published_by_name" TEXT,
      "published_at" TIMESTAMP(3),
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "SeatLayout_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "SeatLayout_status_effective_from_idx" ON "SeatLayout"("status", "effective_from")`,

    `CREATE TABLE IF NOT EXISTS "SeatZone" (
      "id" SERIAL NOT NULL,
      "layout_id" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "note" TEXT,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "polygon" JSONB,
      CONSTRAINT "SeatZone_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "SeatZone_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "SeatLayout"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS "SeatTable" (
      "id" SERIAL NOT NULL,
      "layout_id" INTEGER NOT NULL,
      "zone_id" INTEGER NOT NULL,
      "label" TEXT NOT NULL,
      "shape" TEXT NOT NULL DEFAULT 'rect',
      "arrangement" TEXT NOT NULL DEFAULT 'two_sides',
      "cx" DOUBLE PRECISION NOT NULL,
      "cy" DOUBLE PRECISION NOT NULL,
      "w" DOUBLE PRECISION NOT NULL DEFAULT 60,
      "h" DOUBLE PRECISION NOT NULL DEFAULT 150,
      "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "SeatTable_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "SeatTable_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "SeatLayout"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "SeatTable_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "SeatZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS "Seat" (
      "id" SERIAL NOT NULL,
      "layout_id" INTEGER NOT NULL,
      "table_id" INTEGER,
      "zone_id" INTEGER NOT NULL,
      "code" TEXT NOT NULL,
      "lx" DOUBLE PRECISION NOT NULL,
      "ly" DOUBLE PRECISION NOT NULL,
      "side_mode" TEXT NOT NULL DEFAULT 'auto',
      "side" TEXT,
      "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "priority" TEXT NOT NULL DEFAULT 'normal',
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "adjacent_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "opposite_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      "sort_order" INTEGER NOT NULL DEFAULT 0,
      "origin_code" TEXT,
      CONSTRAINT "Seat_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "Seat_layout_id_fkey" FOREIGN KEY ("layout_id") REFERENCES "SeatLayout"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "Seat_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "SeatTable"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "Seat_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "SeatZone"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Seat_layout_id_code_key" ON "Seat"("layout_id", "code")`,

    `CREATE TABLE IF NOT EXISTS "BookingPerson" (
      "id" SERIAL NOT NULL,
      "booking_ref" TEXT NOT NULL,
      "person_no" INTEGER NOT NULL,
      "seat_code" TEXT,
      "status" TEXT NOT NULL DEFAULT 'active',
      "is_onsite_added" BOOLEAN NOT NULL DEFAULT false,
      "billing_start_at" TIMESTAMP(3),
      "timer_started_at" TIMESTAMP(3),
      "timer_ended_at" TIMESTAMP(3),
      "paused_at" TIMESTAMP(3),
      "paused_seconds" INTEGER NOT NULL DEFAULT 0,
      "created_by_name" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "BookingPerson_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "BookingPerson_booking_ref_person_no_key" ON "BookingPerson"("booking_ref", "person_no")`,
    `CREATE INDEX IF NOT EXISTS "BookingPerson_booking_ref_idx" ON "BookingPerson"("booking_ref")`,

    `CREATE TABLE IF NOT EXISTS "TimerPause" (
      "id" SERIAL NOT NULL,
      "person_id" INTEGER NOT NULL,
      "started_at" TIMESTAMP(3) NOT NULL,
      "ended_at" TIMESTAMP(3),
      "reason" TEXT,
      "staff_name" TEXT,
      CONSTRAINT "TimerPause_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "TimerPause_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "BookingPerson"("id") ON DELETE CASCADE ON UPDATE CASCADE
    )`,

    `CREATE TABLE IF NOT EXISTS "Payment" (
      "id" SERIAL NOT NULL,
      "payment_no" TEXT NOT NULL,
      "batch_no" TEXT NOT NULL,
      "client_batch_id" TEXT,
      "booking_ref" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'valid',
      "method" TEXT NOT NULL,
      "amount" INTEGER NOT NULL,
      "waived_amount" INTEGER,
      "cash_received" INTEGER,
      "change_given" INTEGER,
      "person_nos" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
      "breakdown_json" JSONB NOT NULL,
      "pass_json" JSONB,
      "related_payment_id" INTEGER,
      "reason" TEXT,
      "note" TEXT,
      "staff_name" TEXT NOT NULL,
      "staff_id" INTEGER,
      "device_id" TEXT,
      "device_label" TEXT NOT NULL,
      "receipt_status" TEXT NOT NULL DEFAULT 'none',
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "voided_at" TIMESTAMP(3),
      "voided_by_name" TEXT,
      "void_reason" TEXT,
      CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "Payment_payment_no_key" ON "Payment"("payment_no")`,
    `CREATE INDEX IF NOT EXISTS "Payment_booking_ref_idx" ON "Payment"("booking_ref")`,
    `CREATE INDEX IF NOT EXISTS "Payment_created_at_idx" ON "Payment"("created_at")`,
    `CREATE INDEX IF NOT EXISTS "Payment_batch_no_idx" ON "Payment"("batch_no")`,

    `CREATE TABLE IF NOT EXISTS "AccountingEvent" (
      "id" SERIAL NOT NULL,
      "booking_ref" TEXT,
      "event_type" TEXT NOT NULL,
      "category" TEXT NOT NULL,
      "summary" TEXT NOT NULL,
      "amount" INTEGER,
      "before_json" JSONB,
      "after_json" JSONB,
      "reason" TEXT,
      "payment_id" INTEGER,
      "print_job_id" INTEGER,
      "staff_name" TEXT NOT NULL,
      "staff_id" INTEGER,
      "device_id" TEXT,
      "device_label" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AccountingEvent_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE INDEX IF NOT EXISTS "AccountingEvent_created_at_idx" ON "AccountingEvent"("created_at")`,
    `CREATE INDEX IF NOT EXISTS "AccountingEvent_booking_ref_idx" ON "AccountingEvent"("booking_ref")`,
    `CREATE INDEX IF NOT EXISTS "AccountingEvent_category_created_at_idx" ON "AccountingEvent"("category", "created_at")`,

    `CREATE TABLE IF NOT EXISTS "PrintStation" (
      "id" SERIAL NOT NULL,
      "name" TEXT NOT NULL DEFAULT '櫃檯商米',
      "secret_hash" TEXT NOT NULL,
      "is_active" BOOLEAN NOT NULL DEFAULT true,
      "is_default" BOOLEAN NOT NULL DEFAULT true,
      "accepting" BOOLEAN NOT NULL DEFAULT true,
      "last_seen_at" TIMESTAMP(3),
      "printer_state" TEXT,
      "printer_message" TEXT,
      "app_version" TEXT,
      "device_model" TEXT,
      "paired_by_name" TEXT,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PrintStation_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "PrintJob" (
      "id" SERIAL NOT NULL,
      "job_no" TEXT NOT NULL,
      "station_id" INTEGER,
      "type" TEXT NOT NULL,
      "booking_ref" TEXT,
      "payment_id" INTEGER,
      "batch_no" TEXT,
      "closing_id" INTEGER,
      "title" TEXT NOT NULL,
      "commands_json" JSONB NOT NULL,
      "is_reprint" BOOLEAN NOT NULL DEFAULT false,
      "reprint_of_id" INTEGER,
      "copy_no" INTEGER NOT NULL DEFAULT 1,
      "status" TEXT NOT NULL DEFAULT 'queued',
      "error_code" TEXT,
      "error_message" TEXT,
      "attempts" INTEGER NOT NULL DEFAULT 0,
      "claimed_at" TIMESTAMP(3),
      "lease_until" TIMESTAMP(3),
      "printed_at" TIMESTAMP(3),
      "printed_by" TEXT,
      "requested_by_name" TEXT NOT NULL,
      "requested_device" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PrintJob_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "PrintJob_job_no_key" ON "PrintJob"("job_no")`,
    `CREATE INDEX IF NOT EXISTS "PrintJob_status_created_at_idx" ON "PrintJob"("status", "created_at")`,
    `CREATE INDEX IF NOT EXISTS "PrintJob_booking_ref_idx" ON "PrintJob"("booking_ref")`,

    `CREATE TABLE IF NOT EXISTS "CashClosing" (
      "id" SERIAL NOT NULL,
      "business_date" DATE NOT NULL,
      "float_amount" INTEGER NOT NULL,
      "expected_cash" INTEGER NOT NULL,
      "counted_cash" INTEGER NOT NULL,
      "difference" INTEGER NOT NULL,
      "totals_json" JSONB NOT NULL,
      "note" TEXT,
      "staff_name" TEXT NOT NULL,
      "device_label" TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CashClosing_pkey" PRIMARY KEY ("id")
    )`,

    `CREATE TABLE IF NOT EXISTS "DailyCounter" (
      "id" SERIAL NOT NULL,
      "date" DATE NOT NULL,
      "key" TEXT NOT NULL,
      "value" INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT "DailyCounter_pkey" PRIMARY KEY ("id")
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "DailyCounter_date_key_key" ON "DailyCounter"("date", "key")`
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

// Middleware
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxyVal = trustProxyEnv !== undefined
  ? (isNaN(trustProxyEnv) ? trustProxyEnv : Number(trustProxyEnv))
  : 1;
app.set('trust proxy', trustProxyVal);
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true, // Allow cookies to be sent
}));
app.use(checkBannedIP);
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));
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

// Basic error handler
app.use((err, req, res, next) => {
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

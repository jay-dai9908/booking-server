# 拾光製所 預約系統（booking-server）— AI 協作共用規則

> 本檔同時給 Claude Code（經 `CLAUDE.md` 的 `@AGENTS.md` 匯入）與 Antigravity 等工具讀取。
> 舊的工作區規則在 `.agents/AGENTS.md`，內容已併入下方「部署」與「環境偏好」。

## 共用記憶（Mem0）

- **Mem0 user_id: proj-web-booking-system**
- 讀寫 Mem0 一律帶這個 `user_id`：
  - 寫入：`add_memory(..., user_id="proj-web-booking-system", metadata={"topic": "..."})`
  - 讀取／搜尋：`filters: {"AND": [{"user_id": "proj-web-booking-system"}]}`
- 現有主題（metadata.topic）：
  - 總覽：`architecture`、`planning`、`database`、`booking-flow`、`auth-api`、`dev-deploy`、`infra-pitfalls`、`in-progress`
  - 深度細節：`billing-engine`（計費與卡券）、`seat-allocator`（自動排位）、`shop-closing-print`（商城對帳、交班、商米列印）、`kiosk-api-contract`、`kiosk-floor-firmware`（半自助日與報到機）、`product-decisions`（刻意保留、不可擅改的產品決定）
  - 實作慣例：`frontend-conventions`、`floor-checkout-impl`、`seat-layout-board-coupling`、`windows-test-infra`
- 改動計費、排位、帳務或報到機相關程式前，先讀 `product-decisions`。
- 開始一項工作前，先用 `search_memories` 查相關主題；完成重大決策、踩到新坑或改變架構後，更新對應主題的記憶。
- 不要寫入任何密碼、金鑰、Token、正式站 IP 或顧客個資。

## 專案一句話

手作拼豆店「拾光製所」的線上預約＋門市營運系統：顧客用 LINE 登入預約時段與座位、租智能拼豆板、買商品；店員在後台做現場帶位、計時、結帳收款、出單（商米印表機）、對帳與交班。

## 目錄索引

| 路徑 | 職責 | 入口 |
| :--- | :--- | :--- |
| `backend/` | Express API（ESM）+ Prisma + PostgreSQL | `src/server.js` |
| `backend/src/routes/` | 16 組 API 路由，掛在 `/api/*` | 見 `server.js` |
| `backend/src/controllers/` | 各路由的業務邏輯（預約、現場、座位版面、帳務、商城、卡券…） | `reservationController.js`、`floorController.js` 最核心 |
| `backend/src/services/` | `billing/`（帳單、收款、退款）、`floor/liveService.js`（現場狀態）、`seating/`（排位）、`print/`（列印佇列）、`audit/` | — |
| `backend/src/middlewares/` | JWT 驗證、權限、限流、列印站驗證 | `authMiddleware.js` |
| `backend/src/cronJobs.js` | 排程：00:00 標記未到、每小時清逾期商城預購、23:59 固化當日價格 | — |
| `backend/prisma/schema.prisma` | 資料模型（無 migrations 資料夾，用 `db push`） | — |
| `backend/prisma/sql/` | 測試資料庫要裝的 trigger（AccountingEvent 只能新增） | `accounting_event_guard.sql` |
| `backend/scripts/` | 維護腳本（裝測試 trigger、修資料） | — |
| `backend/test/` | 後端單元／整合測試（node:test，需測試資料庫） | — |
| `frontend/` | React 18 + Vite 4 + Tailwind 3 | `src/main.jsx`、`src/App.jsx` |
| `frontend/src/pages/Customer/` | 顧客端：首頁、預覽、預約、紀錄、商城、註冊 | — |
| `frontend/src/pages/Admin/` | 後台：今日帶位（SeatingPage）、座位設定（SeatLayoutPage）、預約、帳務、商米、設定… | — |
| `frontend/src/components/admin/` | 後台元件：現場平面圖 `floor/`、結帳工作台 `checkout/` | — |
| `frontend/tests/` | Playwright 腳本（`*.spec.js`）與前端單元測試（`*.test.mjs`） | — |
| `frontend/scripts/check-secrets.mjs` | lint 前的密碼／個人路徑掃描 | — |
| `shared/` | 前後端共用純函式：帳單 `billing.js`、時間 `time.js`、排位 `allocator/`、收據、板子計價 | — |
| `docs/sunmi_pos_api_guide.md` | 商米 POS 列印站 API 說明 | — |

## 啟動與測試

本機（預設 Windows + 本機 PostgreSQL）：

```bash
cd backend && npm install && npx prisma generate && npm run dev
```

```bash
cd frontend && npm install && npm run dev
```

- 後端預設 `PORT`，前端 Vite 5173。`backend/.env` 需要：`DATABASE_URL`、`JWT_SECRET`（≥32 字元，否則拒絕啟動）、`ADMIN_PASSWORD`、`FRONTEND_URL`、LINE 相關（`LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`、`LINE_CALLBACK_URL`）。前端 `VITE_LINE_*`。
- 改了 `schema.prisma`：`cd backend && npx prisma db push`（沒有 migrations）。

測試（全部都要在**專用測試資料庫**上跑，資料庫名稱必須以 `_test` 結尾）：

```bash
cd backend && NODE_ENV=test TEST_DATABASE_URL=postgresql://.../xxx_test npm test
```

```bash
TZ=Asia/Taipei node --test shared/__tests__/*.test.js
```

```bash
TZ=Asia/Taipei node --test frontend/tests/*.test.mjs
```

```bash
cd frontend && npm run lint && npm run test:all
```

- 新的測試資料庫要先裝 trigger：`node backend/scripts/apply_test_db_trigger.js`。
- `test:all` 需要前後端都在跑；截圖輸出用 `SCREENSHOT_DIR`，預設 `tests/screenshots/`。
- 不要在正式機上跑前端測試。

## 部署（GCP VM + pm2）

VM 上的資料夾是 `~/web-booking-system`（不是 `~/booking-server`）：

```bash
cd ~/web-booking-system && git pull origin main && cd frontend && npm run build && cd .. && pm2 restart all
```

- `frontend` 的 `postbuild` 會自動 `prisma generate` 並 `prisma db push` 到正式資料庫，錯誤會被吞掉；改 schema 前要先確認不會刪欄位。
- 後端啟動時 `ensureDatabaseSchema()` 會逐條執行 `CREATE TABLE/ALTER TABLE IF NOT EXISTS`（`server.js`），新欄位兩邊都要加。

## 協作慣例

- 回覆使用繁體中文。
- 工作流程：外部實作者推到 `main`；審查者寫「第 N 輪」修正提示詞（每輪 3～5 項，每項寫 問題／位置／改成／驗收，分層測試），實作者照做後再審查。
- 員工帳號系統（StaffPage、`AdminUser`）先不要動。
- 只有被要求時才 commit／push，也不要主動開 PR。
- 不要在程式、測試、提交訊息裡寫入密碼或個人電腦路徑（`check-secrets.mjs` 會擋）。

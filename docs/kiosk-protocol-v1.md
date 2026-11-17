# 拾光製所｜報到機通訊協定 v1（SGK1）

網站後端和報到機韌體都照這份實作。兩邊有出入時，以這份文件和 `sgk1-reference/` 的參考實作為準；要改協定，先改這份文件再改程式。

- 參考實作（Node，可直接執行）：`sgk1-reference/sgk1.mjs`
- 測試向量：`sgk1-reference/vectors.json`（`node check-vectors.mjs` 會印 `vectors ok`）
- 模擬伺服器：`sgk1-reference/mock-server.mjs`（韌體開發用）
- 模擬報到機：`sgk1-reference/kiosk-sim.mjs`（網站後端測試用）

## 1. 前提

- 正式站只有 HTTP，所以報到機和伺服器之間的內容全部用配對金鑰加密並驗證。
- 配對金鑰不經過網路：伺服器在 SSH 視窗產生並顯示成 QR，報到機用自己的掃碼頭掃入。
- 報到機只接受「對應自己這一次請求」的回應。側錄後重放、偽造的開門回應都會驗證失敗。
- 已知限制：後台本身還是 HTTP。
- 圖片、韌體、地圖這些檔案不加密，但檢查碼放在加密的 `sync` 回應裡，下載後比對不符就丟棄。

## 2. 配對

- 伺服器指令 `node backend/scripts/kiosk-pair.mjs --name "門口報到機" --url http://<站台位址>`：
  1. 產生 32 個隨機位元組當配對金鑰 `K`，建立一筆報到機裝置，得到 `device_id`。
  2. 在終端機印出配對字串和它的 QR。
- 配對字串：`SGPAIR1|<base_url>|<device_id>|<K 的 base64url，不補 =>`
  - 例：`SGPAIR1|http://192.0.2.10:3001|3|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`
  - `base_url` 不含結尾斜線。
- 報到機在設定模式掃到 `SGPAIR1|` 開頭的字串就存進 NVS（開發時也可以用序列埠 `pair <字串>`）。
- 重新配對 = 再跑一次指令，舊金鑰立即失效。

## 3. 加密信封

**金鑰**
- `k_req = HMAC-SHA256(K, "sgk1-req")`：報到機 → 伺服器。
- `k_res = HMAC-SHA256(K, "sgk1-res")`：伺服器 → 報到機。

**演算法**：AES-256-GCM，12 位元組隨機 nonce，16 位元組驗證碼接在密文後面。base64 用標準字元集、有補 `=`。

**請求**：`POST <base_url>/api/kiosk/v1/<op>`，`Content-Type: application/json`

```json
{ "v": 1, "d": 3, "n": "<nonce base64>", "c": "<密文＋驗證碼 base64>" }
```

- `op` 是 `sync` 或 `access`。`d` 是 `device_id`。
- 附加驗證資料（AAD，UTF-8）：`sgk1|req|<op>|<d>`
- 明文（UTF-8 JSON）：`{"rid":"<32 個小寫十六進位字元>","ts":<報到機的 unix 秒>,"body":{...}}`
  - `rid` 每次請求都用硬體亂數重新產生。

**回應**：HTTP 200

```json
{ "v": 1, "n": "<nonce base64>", "c": "<密文＋驗證碼 base64>" }
```

- AAD：`sgk1|res|<op>|<d>|<rid>`
- 明文：`{"rid":"<同一個 rid>","ts":<伺服器的 unix 秒>,"ok":true,"code":"OK","body":{...}}`

**伺服器檢查順序**
1. 裝置存在且啟用、解密與驗證成功。任何一項失敗：HTTP 401，內容 `{"error":"KIOSK_AUTH"}`（沒辦法加密，報到機當成連線失敗）。同一個 IP 10 分鐘內失敗 10 次，或同一台裝置每分鐘超過 60 次請求：HTTP 429。
2. `|ts − 伺服器時間| > 120 秒`：回加密的 `{"ok":false,"code":"CLOCK_SKEW"}`。
3. 同一台裝置 10 分鐘內出現過的 `rid`：回加密的 `{"ok":false,"code":"REPLAY"}`，不執行任何動作。
4. 執行，回 `{"ok":true,"code":"OK","body":{...}}`。伺服器內部錯誤：回加密的 `{"ok":false,"code":"SERVER_ERROR"}`。

**報到機檢查順序**
1. HTTP 不是 200、解不開、`rid` 不是剛送出的那個：全部丟棄，當成連線失敗。
2. 每次解開成功，都用回應的 `ts` 校正自己的時鐘（報到機沒有電池時鐘，不用 NTP）。
3. `CLOCK_SKEW`：校正時鐘後用新的 `rid` 重送一次。開機第一次請求一定會走這條路。
4. 逾時：連線 4 秒、整個請求 8 秒。`access` 不自動重送（避免重複報到）；`sync` 下一輪再試。

## 4. `sync`：同步設定與回報狀態

- 開機連上 Wi-Fi 後立刻一次，之後每 `sync_interval_s` 秒一次（預設 180）。
- 用過備用開門密碼後立刻多做一次。

**請求 body**

```json
{
  "fw": "0.2.0", "boot_id": "a1b2c3d4", "uptime_s": 3600, "reset_reason": "poweron",
  "heap_kb": 180, "psram_kb": 2100, "rssi": -58, "scanner_ok": true,
  "have": { "config_rev": 12, "backup_code_rev": 3, "setup_pin_rev": 1, "slides_rev": 4, "floor_map_version": "L2-1794700000", "fw_state": "idle" },
  "events": [
    { "id": "a1b2c3d4-7", "type": "backup_open", "at": 1794700000, "offline": true }
  ]
}
```

- `boot_id`：每次開機產生的 8 個十六進位字元。事件 `id` = `<boot_id>-<流水號>`，伺服器用它去重複。
- `reset_reason`：`poweron`、`software`、`panic`、`watchdog`、`brownout`、`ota`、`other`。
- `scanner_ok`：掃碼頭是否正常。報到機無法判斷時送 `null`，後台顯示「未知」。
- `fw_state`：`idle`、`downloading`、`ready`、`failed:<原因>`。
- 事件 `type`：
  - `backup_open`：用備用密碼開門。
  - `pad_locked`：鍵盤連續輸錯被鎖。
  - `ota_ok`、`ota_failed`：`data` 帶版本與原因。
  - `boot`：開機。
- 事件要保留到伺服器在 `ack_event_ids` 回覆收到為止。

**回應 body**

```json
{
  "sync_interval_s": 180, "tz_offset_min": 480, "config_rev": 12,
  "days": [
    { "date": "2026-11-22", "mode": "self", "open": "09:00", "close": "21:00", "iron_text": "店員會在今天下午到店協助熨燙" }
  ],
  "rules": { "early_minutes": 30, "after_close_minutes": 60, "result_seconds": 8, "result_map_seconds": 15, "pad_max_fail": 5, "pad_lock_seconds": 300 },
  "contact": { "line_url": "https://lin.ee/xxxx", "line_id": "@xxxx" },
  "backup_code": { "rev": 3, "code": "8800123456" },
  "setup_pin": { "rev": 1, "pin": "246810" },
  "slides": { "rev": 4, "items": [ { "id": 7, "url": "/api/kiosk/files/slides/7.bin", "sha256": "<64 hex>", "size": 768000, "seconds": 8 } ] },
  "floor_map": { "version": "L2-1794700000", "url": "/api/kiosk/files/floor-map/L2-1794700000.json", "sha256": "<64 hex>", "size": 5501 },
  "firmware": { "version": "0.2.1", "url": "/api/kiosk/files/firmware/12.bin", "sha256": "<64 hex>", "size": 1234567, "policy": "night" },
  "ack_event_ids": ["a1b2c3d4-7"]
}
```

- `days`：今天起 7 天（台北時間）。`mode`：
  - `self`：半自助日，報到機管門。
  - `normal`：一般營業日，顯示「目前為一般營業時段，可直接入場」。
  - `closed`：當天沒有任何時段，顯示「今日公休」。
- `open`、`close`：當天第一個時段開始和最後一個時段結束的時間。`closed` 時是 `null`。
- `backup_code`、`setup_pin`：報到機比對 `rev`，不同才寫進 NVS。還沒設定時是 `null`。
- `slides.items` 照順序播放。`url` 是相對於 `base_url` 的路徑，用一般的 HTTP GET 下載，下載完比對 `sha256`。
- `floor_map`、`firmware`：沒有時是 `null`。`firmware.policy`：
  - `none`：只是告知，不更新。
  - `night`：台北時間 03:00 到 05:00、閒置時更新。
  - `now`：閒置滿 1 分鐘就更新。
  - `version` 和報到機目前版本相同就不動作。
- 之後要加欄位直接加，雙方都要忽略不認得的欄位。

## 5. `access`：報到／進門

**請求 body**

```json
{ "method": "qr", "payload": "SG1-3F2A9C1E7B-4MCB7EAO" }
```

- `method`：`qr`（掃碼頭讀到的整串，去掉結尾換行）或 `phone`（`09` 開頭的 10 碼）。
- 報到機不解讀條碼內容，原樣轉送。

**回應 body**

```json
{
  "result": "FIRST_CHECKIN", "open_door": true,
  "booking": { "name": "王小明", "pax": 2, "zone": "A 區", "seats": ["A1-1", "A1-2"], "start": "13:00", "open_at": "12:30", "until": "21:00", "iron_text": "店員會在今天下午到店協助熨燙" }
}
```

| `result` | 開門 | 報到機畫面 | 什麼情況 |
| :--- | :--- | :--- | :--- |
| `FIRST_CHECKIN` | 是 | K6 報到成功（含座位地圖） | 這筆預約第一次進門 |
| `RE_ENTRY` | 是 | K7 歡迎回來（含座位地圖） | 已報到過，再次進門 |
| `TOO_EARLY` | 否 | K8 還沒開放，顯示 `open_at` | 還沒到「開始前 N 分鐘」 |
| `UNVERIFIED` | 否 | K9 款項核對中 | 還沒付款或還沒對帳完成 |
| `QR_EXPIRED` | 否 | K10 條碼過期 | 條碼格式對、找得到預約，但驗證碼不是目前或前一個時段 |
| `NOT_FOUND` | 否 | K11 查無預約 | 今天沒有符合的預約、格式不對、已取消 |
| `ENDED` | 否 | K11，文字改「今天的使用時間已結束」 | 已超過打烊後的寬限時間 |
| `NORMAL_DAY` | 否 | K17 可直接入場 | 今天不是半自助日 |

- `booking` 在 `FIRST_CHECKIN`、`RE_ENTRY`、`TOO_EARLY`、`UNVERIFIED`、`ENDED` 時提供；`seats` 只在前兩種提供，還沒有座位時是空陣列。
- 韋根訊號是單向的。「開門成功」以伺服器回 `open_door: true`、報到機送出訊號為準。
- 判斷順序、首次報到要做的事，寫在網站第 26 輪提示詞。

## 6. 動態進場條碼

- 內容：`SG1-<進場碼>-<驗證碼>`，共 23 個字元，只有大寫英數和 `-`。
  - 進場碼：`booking_ref`（uuid）去掉 `-` 後的前 10 個字元，轉大寫。
  - 驗證碼：`HMAC-SHA256(qr_key, "<booking_ref>|<時段>")` 的前 5 個位元組，用 RFC 4648 base32（`A–Z2–7`）編成 8 個字元。
  - 時段：`floor(unix 秒 / 300)`。
  - `qr_key = HMAC-SHA256(JWT_SECRET, "sgqr1-key")`，只存在伺服器。
- 伺服器接受目前和前一個時段（有效 5 到 10 分鐘）。
- 顧客頁面向伺服器要條碼，到期自動換新。條碼只在伺服器產生和驗證，報到機不需要知道演算法。
- 用進場碼找預約：`booking_ref` 以 `xxxxxxxx-xx` 開頭（例：進場碼 `3F2A9C1E7B` → `3f2a9c1e-7b`），範圍限當天的預約。

## 7. 檔案下載（不加密，靠檢查碼）

- `GET /api/kiosk/files/slides/<id>.bin`：800×480、RGB565、little-endian、不交換位元組、不含檔頭，固定 768,000 位元組。
- `GET /api/kiosk/files/floor-map/<version>.json`：座位地圖，格式見第 8 節。
- `GET /api/kiosk/files/firmware/<id>.bin`：ESP-IDF 應用程式映像檔，最大 4,194,304 位元組（程式區大小）。
  - 檔案第 1 個位元組是 `0xE9`。
  - 位移 32 起是應用程式描述：4 個位元組 `32 54 CD AB`；位移 48 起 32 個位元組是版本字串；位移 80 起 32 個位元組是專案名稱，固定 `kiosk-firmware`。
  - 這個版本字串必須和報到機在 `sync` 回報的 `fw` 相同（韌體用同一個來源產生兩者）。
- 回應要帶 `Content-Length`。報到機一邊下載一邊算 SHA-256，和 `sync` 給的不同就丟掉，下一輪再試。

## 8. 座位地圖 JSON

報到機和手機已進場頁共用同一份資料。

```json
{
  "version": "L2-1794700000", "w": 720, "h": 1160, "rotation": 0, "door": [375, 1160],
  "shapes": [
    { "kind": "wall", "closed": false, "pts": [[0,1160],[0,0],[720,110],[720,1160]], "label": "", "show": "shape", "color": "grey", "pattern": "none", "icon": "" },
    { "kind": "fixture", "closed": true, "pts": [[160,960],[210,960],[210,1160],[160,1160]], "label": "櫃檯", "show": "icon_name", "color": "brown", "pattern": "none", "icon": "counter" }
  ],
  "tables": [ { "label": "A1", "pts": [[200,180],[270,180],[270,320],[200,320]] } ],
  "seats": [ { "code": "A1-1", "x": 190, "y": 215, "table": 0 } ]
}
```

- 單位是公分，原點在所有形狀外框的左上角。
- `kind`：`wall`、`window`、`door`、`pillar`、`fixture`。
- `show`：`shape`、`name`、`icon`、`icon_name`、`hidden`。
- `color`：`grey`、`brown`、`coral`、`blue`、`honey`、`sage`、`lavender`、`pink`。
- `pattern`：`none`、`beads`。
- `icon`：`sofa`、`counter`、`iron`、`beads`、`locker`、`shelf`、`toilet`、`sink`、`water`、`trash`、`bag`、`entrance`、`exit`、`stairs`、`ac`，或空字串。
- `rotation`：`0`、`90`、`180`、`270`，畫的時候順時針轉這個角度。
- `door`：入口中心點，標「入口」。
- `seats[].table`：`tables` 的索引，沒有桌子的座位是 `-1`。只含啟用中的座位。
- `label` 裡的 `\n` 代表後台指定的換行位置。

## 9. 測試向量（完整內容在 `vectors.json`）

| 項目 | 值 |
| :--- | :--- |
| `K` | `000102…1e1f`（32 位元組，依序 00 到 1f） |
| `k_req` | `c7aaf7c2e2a4a42c65a6a140191d46a834dffebda9f4047fa2dccb7b56f18d27` |
| `k_res` | `ddc2ca5308daee342e1027183893635e5d2b44e1e515112d91670a99ab9784d6` |
| 進場條碼 | 測試密鑰 `test-secret-test-secret-test-secret-1234`、`booking_ref` `3f2a9c1e-7b4d-4e2a-9f10-5c6d7e8f9a0b`、unix `1794700000` → `SG1-3F2A9C1E7B-4MCB7EAO`；前一個時段是 `SG1-3F2A9C1E7B-ZBTSFDD6` |

以上金鑰和密鑰都是測試用的假資料，不可用在正式站。

# 拾光製所 - 商米 V2s POS 網頁列印 API 整合指南

本文件說明如何從 POS 網頁端發送列印指令給 Android 原生 App，以驅動商米 V2s 內建熱感應印表機進行單據列印。

## 1. 架構與溝通機制
* **App 角色**：純粹的指令轉發器與硬體驅動器，不干涉任何業務邏輯與排版。
* **網頁端角色**：負責所有的單據排版、資料計算、顧客個資遮蔽（電話 `0912***678`），並組裝為 JSON 指令陣列。
* **通訊管道**：App 會在全域注入 `window.AndroidPrinter` 物件。

## 2. API 呼叫規格

**方法名稱：**
`window.AndroidPrinter.printReceiptWithCallback(jsonString, callbackName)`

**參數說明：**
1. `jsonString` (String)：序列化後的 JSON 指令陣列字串（`JSON.stringify(commands)`）。
2. `callbackName` (String)：網頁端全域 Callback 函數名稱，App 執行完畢後會呼叫此函數並回傳 JSON 結果。

**Callback 回傳格式：**
App 完成列印後，會傳回 JSON 字串給網頁端 Callback：
* 成功：`{ "success": true }`
* 失敗：`{ "success": false, "error": "錯誤訊息（如：缺紙、印表機連線中斷）" }`

## 3. 完整支援的 JSON 列印指令集

網頁端傳遞的 `commands` 陣列中，每個元素為一個 JSON 物件，支援以下類型：

### 1. text (一般 / 內文文字)
* `text` (String): 要列印的文字內容（可包含 `\n` 換行）。
* `size` (Number, 選填): 字體大小，範圍 16 ~ 96 (預設 24)。
* `bold` (Boolean, 選填): 是否加粗 (`true` / `false`)。
* `align` (String, 選填): 對齊方式 (`"left"` | `"center"` | `"right"`)，預設 `"left"`。
```json
{ "type": "text", "text": "預約日期：2026-09-10 14:00", "size": 24, "bold": false, "align": "left" }
```

### 2. title (大字體標題)
* `text` (String): 標題文字。
* `align` (String, 選填): 對齊方式 (`"left"` | `"center"` | `"right"`)，預設 `"left"`。
* `bold` (Boolean, 選填): 是否加粗，預設 `true`。
```json
{ "type": "title", "text": "拾光製所 預約單", "align": "center", "bold": true }
```

### 3. columns (多欄對齊排版)
常用於「品名、數量、金額」的表格型排版。單行滿紙寬總字元長度限制為 31 字元（Line Budget）。
* `cols` (Array[String]): 欄位文字陣列（例如：`["體驗項目", "數量", "小計"]`）。
* `weights` (Array[Number], 選填): 欄位寬度比例，預設會依欄數自動以 31 字元進行比例分配（三欄 `[15, 6, 10]`、雙欄 `[19, 12]`），確保字字不溢出。
* `aligns` (Array[Number/String], 選填): 各欄對齊（0靠左, 1置中, 2靠右）。預設第一欄靠左、最後一欄靠右。
```json
{ 
  "type": "columns", 
  "cols": ["手作拼豆體驗 (雙人)", "x1", "$1,200"],
  "weights": [2, 1, 1]
}
```

### 4. qr (QR Code 條碼)
* `text` (String): 條碼內容或 URL（文字越短，QRCode 越清晰好掃）。
* `size` (Number, 選填): 點陣大小，範圍 4 ~ 12 (預設 8)。
* `align` (String, 選填): 對齊方式 (`"left"` | `"center"` | `"right"`)，預設 `"left"`。
```json
{ "type": "qr", "text": "BOOKING-REF-2026091001", "size": 8, "align": "center" }
```

### 5. barcode (一維條碼)
* `text` (String): 條碼內容。
* `symbology` (Number/String, 選填): 條碼格式，8 為 CODE128（預設 8）。
* `height` (Number, 選填): 條碼像素高度 (預設 100)。
* `align` (String, 選填): 對齊方式 (`"left"` | `"center"` | `"right"`)。
```json
{ "type": "barcode", "text": "202609100012", "symbology": 8, "height": 100, "align": "center" }
```

### 6. image / bitmap (圖片 / 店家 Logo)
* `base64` (String): 圖片 Base64 字串（支援 `data:image/png;base64,...` 或純 Base64）。
* `width` (Number, 選填): 指定圖片寬度像素。若僅指定寬度，高度會自動按比例調整（最高滿紙寬 384px）。
* `height` (Number, 選填): 指定圖片高度像素。若僅指定高度，寬度會自動按比例調整。
* `align` (String, 選填): 對齊方式 (`"left"` | `"center"` | `"right"`)。
*(註：若同時指定 width & height 則強制縮放至指定寬高。)*
```json
{ 
  "type": "image", 
  "base64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA...", 
  "width": 200, 
  "align": "center" 
}
```

### 7. lineWrap (空白走紙 / 推紙)
* `lines` (Number, 選填): 走紙行數，預設 1 行（方便店員撕下單據且節省紙張）。
```json
{ "type": "lineWrap", "lines": 1 }
```

## 4. 網頁端完整實作範例 (JavaScript)

```javascript
// 1. 會員手機號碼遮蔽函數 (第 5 到第 7 碼變更為 ***)
function maskPhone(phone) {
    if (!phone) return "";
    return phone.replace(/^(\d{4})\d{3}(\d{3})$/, "$1***$2");
}

// 2. 組裝預約單據指令陣列
function buildBookingReceiptCommands(bookingData) {
    return [
        // 店家標題 (置中加粗)
        { type: "title", text: "拾光製所", align: "center", bold: true },
        { type: "text", text: "--- 拼豆時段預約單 ---", align: "center" },
        { type: "text", text: "-------------------------------" },
        
        // 預約基本資料
        { type: "text", text: `預約單號：${bookingData.bookingRef}` },
        { type: "text", text: `預約日期：${bookingData.date} ${bookingData.time}` },
        { type: "text", text: `顧客姓名：${bookingData.customerName}` },
        { type: "text", text: `顧客電話：${maskPhone(bookingData.customerPhone)}` },
        { type: "text", text: `預約人數：${bookingData.pax} 人` },
        { type: "text", text: "-------------------------------" },
        
        // 多欄明細 (項目, 數量, 金額)
        { type: "columns", cols: [bookingData.itemName, `x${bookingData.pax}`, `$${bookingData.amount}`] },
        { type: "text", text: "-------------------------------" },
        
        // 合計金額 (右對齊加粗)
        { type: "text", text: `合計金額：$${bookingData.amount}`, align: "right", bold: true, size: 28 },
        { type: "text", text: "-------------------------------" },
        
        // 報到用 QR Code (置中)
        { type: "qr", text: bookingData.bookingRef, size: 8, align: "center" },
        { type: "text", text: "請妥善保管此單據，憑 QR Code 報到", align: "center", size: 18 },
        
        // 走紙推紙
        { type: "lineWrap", lines: 1 }
    ];
}

// 3. 註冊全域 Callback
window.onPOSPrintComplete = function(resultJson) {
    try {
        const res = JSON.parse(resultJson);
        if (res.success) {
            console.log("✅ 列印成功！");
        } else {
            alert("⚠️ 列印失敗：" + res.error);
        }
    } catch (e) {
        console.error("解析 Callback 結果失敗", e);
    }
};

// 4. 觸發列印按鈕點擊事件
function handlePrintReceipt(bookingData) {
    const commands = buildBookingReceiptCommands(bookingData);
    const jsonString = JSON.stringify(commands);
    
    // 檢查是否運行於 POS App 內
    if (window.AndroidPrinter && typeof window.AndroidPrinter.printReceiptWithCallback === 'function') {
        window.AndroidPrinter.printReceiptWithCallback(jsonString, "onPOSPrintComplete");
    } else {
        console.warn("未偵測到 POS 裝置，無法執行實體熱感應列印。");
        console.log("預期列印 JSON 指令：", commands);
    }
}
```

## 5. POS 裝置識別 API 擴充

網頁前端可隨時透過以下方法判定當前操作環境是否為 POS 裝置：

```javascript
// JavaScript 前端判斷
if (window.AndroidPrinter && typeof window.AndroidPrinter.isPosMachine === 'function' && window.AndroidPrinter.isPosMachine()) {
    const model = window.AndroidPrinter.getDeviceModel(); // 預期回傳 "SUNMI_V2s"
    console.log("當前於 POS 機上運行，型號：", model);
}

// 後端 / Server 端 HTTP Header 判斷
// 所有的 Request Header `User-Agent` 皆已包含 "ShiguangPOS/1.0 (SUNMI V2s)"
```

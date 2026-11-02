import '../src/loadEnv.js';
import prisma from '../src/prismaClient.js';
import { getTaipeiDateParts } from '../src/utils/dateUtils.js';

/**
 * 歷史 DailySetting 異常資料檢測腳本 (唯讀，絕不修改資料庫)
 * 檢測重點：
 * 1. 星期六或星期日 (週末)，但價格被設定為平日價
 * 2. 星期一至星期五 (平日)，但價格被設定為週末價
 */
async function checkSuspiciousDailySettings() {
  console.log('====================================================');
  console.log('🔍 開始檢查歷史 DailySetting 價格設定 (唯讀模式)...');
  console.log('====================================================');

  const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  if (!globalSetting) {
    console.error('❌ 找不到 GlobalSetting (id=1)，無法取得基準價格');
    process.exit(1);
  }

  const {
    weekday_hourly_price: defaultWeekdayHourly,
    weekday_unlimited_price: defaultWeekdayUnlimited,
    weekend_hourly_price: defaultWeekendHourly,
    weekend_unlimited_price: defaultWeekendUnlimited
  } = globalSetting;

  console.log('基準價格設定：');
  console.log(`- 平日每小時：NT$ ${defaultWeekdayHourly} / 平日包日：NT$ ${defaultWeekdayUnlimited}`);
  console.log(`- 週末每小時：NT$ ${defaultWeekendHourly} / 週末包日：NT$ ${defaultWeekendUnlimited}`);
  console.log('----------------------------------------------------');

  const allSettings = await prisma.dailySetting.findMany({
    orderBy: { date: 'asc' }
  });

  console.log(`資料庫中共有 ${allSettings.length} 筆 DailySetting 記錄。\n`);

  const suspiciousRecords = [];
  const dayNames = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

  for (const row of allSettings) {
    const { dateStr, dayOfWeek, isWeekend } = getTaipeiDateParts(row.date);
    const dayName = dayNames[dayOfWeek];

    let issue = null;

    if (isWeekend) {
      // 週末如果是平日價
      if (
        row.hourly_price === defaultWeekdayHourly ||
        row.unlimited_price === defaultWeekdayUnlimited
      ) {
        issue = `週末 (${dayName}) 但價格為平日價 (時: ${row.hourly_price}, 包: ${row.unlimited_price})`;
      }
    } else {
      // 平日如果是週末價
      if (
        row.hourly_price === defaultWeekendHourly ||
        row.unlimited_price === defaultWeekendUnlimited
      ) {
        issue = `平日 (${dayName}) 但價格為週末價 (時: ${row.hourly_price}, 包: ${row.unlimited_price})`;
      }
    }

    if (issue) {
      suspiciousRecords.push({
        id: row.id,
        date: dateStr,
        dayName,
        isWeekend,
        hourly_price: row.hourly_price,
        unlimited_price: row.unlimited_price,
        issue
      });
    }
  }

  if (suspiciousRecords.length === 0) {
    console.log('✅ 未發現任何可疑或錯置之 DailySetting 記錄！所有週末與平日價格皆正常對應。');
  } else {
    console.log(`⚠️ 發現 ${suspiciousRecords.length} 筆可疑記錄（可能因過去 UTC 轉換提早 8 小時導致）：\n`);
    suspiciousRecords.forEach((item, idx) => {
      console.log(`[${idx + 1}] ID: ${item.id} | 日期: ${item.date} (${item.dayName})`);
      console.log(`     說明: ${item.issue}`);
    });
    console.log('\n💡 提示：本腳本為唯讀檢查，未變更任何資料。若需要修正，可於後台「場次定價」或個別處理。');
  }

  console.log('====================================================');
  process.exit(0);
}

checkSuspiciousDailySettings().catch(err => {
  console.error('執行檢測腳本失敗:', err);
  process.exit(1);
});

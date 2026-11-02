/**
 * 台北時區 (Asia/Taipei) 日期處理工具函式
 * 確保在任何運行環境 (UTC 或本機) 下皆能精準計算出台北日期的 00:00:00.000Z，避免儲存至 @db.Date 欄位時產生日差
 */

export const getTaipeiDateParts = (date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.format(date); // YYYY-MM-DD
  const [year, month, day] = parts.split('-').map(Number);

  // 以台北當天日期的正午計算星期幾 (避開日光節約與邊界)
  const middayUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dayOfWeek = middayUtc.getUTCDay(); // 0 is Sunday, 6 is Saturday

  return {
    dateStr: parts, // 'YYYY-MM-DD'
    year,
    month,
    day,
    dayOfWeek, // 0-6
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    // UTC 00:00 物件，對應 PostgreSQL DATE 欄位的精確比對
    dateObject: new Date(`${parts}T00:00:00.000Z`)
  };
};

export const getTaipeiNow = () => {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
};

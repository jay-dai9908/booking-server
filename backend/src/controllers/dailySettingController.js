import prisma from '../prismaClient.js';

export const getDailySetting = async (req, res) => {
  const { date } = req.query;
  
  if (!date) {
    return res.status(400).json({ error: 'Date query parameter is required' });
  }

  try {
    const setting = await prisma.dailySetting.findUnique({
      where: { date: new Date(date) }
    });

    if (!setting) {
      // Default behavior: allow unlimited
      return res.json({ date, allow_unlimited: true });
    }

    res.json(setting);
  } catch (error) {
    console.error('Error fetching daily setting:', error);
    res.status(500).json({ error: 'Failed to fetch daily setting' });
  }
};

export const updateDailySetting = async (req, res) => {
  const { date, allow_unlimited, hourly_price, unlimited_price } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  try {
    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') dataToUpdate.allow_unlimited = allow_unlimited;
    if (hourly_price !== undefined) dataToUpdate.hourly_price = hourly_price === null ? null : parseInt(hourly_price);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = unlimited_price === null ? null : parseInt(unlimited_price);

    const setting = await prisma.dailySetting.upsert({
      where: { date: new Date(date) },
      update: dataToUpdate,
      create: {
        date: new Date(date),
        ...dataToUpdate,
        allow_unlimited: allow_unlimited !== undefined ? allow_unlimited : true
      }
    });

    res.json({ message: 'Daily setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating daily setting:', error);
    res.status(500).json({ error: 'Failed to update daily setting' });
  }
};

export const batchUpdateDailySettings = async (req, res) => {
  const { start_date, end_date, days_of_week, hourly_price, unlimited_price, allow_unlimited, dates } = req.body;

  let datesToUpdate = [];

  if (dates && Array.isArray(dates) && dates.length > 0) {
    datesToUpdate = dates.map(d => new Date(d));
  } else if (start_date && end_date) {
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const day = currentDate.getDay(); // 0 (Sun) to 6 (Sat)
      
      // If days_of_week is provided (e.g. [0, 6] for weekends), check if matches
      if (!days_of_week || days_of_week.includes(day)) {
        datesToUpdate.push(new Date(currentDate));
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }
  } else {
    return res.status(400).json({ error: '請提供日期陣列 (dates) 或起訖日期 (start_date, end_date)' });
  }

  if (datesToUpdate.length === 0) {
    return res.status(400).json({ error: '未選取任何有效日期' });
  }

  try {
    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') dataToUpdate.allow_unlimited = allow_unlimited;
    if (hourly_price !== undefined) dataToUpdate.hourly_price = (hourly_price === null || hourly_price === '') ? null : parseInt(hourly_price);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = (unlimited_price === null || unlimited_price === '') ? null : parseInt(unlimited_price);

    // Prisma doesn't support upsertMany, so we use a transaction
    const upserts = datesToUpdate.map(date => 
      prisma.dailySetting.upsert({
        where: { date },
        update: dataToUpdate,
        create: {
          date,
          ...dataToUpdate,
          allow_unlimited: allow_unlimited !== undefined ? allow_unlimited : true
        }
      })
    );

    await prisma.$transaction(upserts);

    res.json({ message: `Successfully updated ${upserts.length} days` });
  } catch (error) {
    console.error('Error batch updating daily settings:', error);
    res.status(500).json({ error: 'Failed to batch update daily settings' });
  }
};

export const getGlobalSetting = async (req, res) => {
  try {
    let setting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (!setting) {
      setting = await prisma.globalSetting.create({
        data: { 
          weekday_hourly_price: 100, 
          weekday_unlimited_price: 550,
          weekend_hourly_price: 150,
          weekend_unlimited_price: 800
        }
      });
    }
    res.json(setting);
  } catch (error) {
    console.error('Error fetching global setting:', error);
    res.status(500).json({ error: 'Failed to fetch global setting' });
  }
};

export const updateGlobalSetting = async (req, res) => {
  const { 
    weekday_hourly_price, 
    weekday_unlimited_price, 
    weekend_hourly_price, 
    weekend_unlimited_price,
    show_price_cards,
    price_notice_text,
    show_announcement,
    announcement_text,
    show_line_button,
    line_button_url
  } = req.body;

  try {
    const dataToUpdate = {};
    if (weekday_hourly_price !== undefined) dataToUpdate.weekday_hourly_price = parseInt(weekday_hourly_price);
    if (weekday_unlimited_price !== undefined) dataToUpdate.weekday_unlimited_price = parseInt(weekday_unlimited_price);
    if (weekend_hourly_price !== undefined) dataToUpdate.weekend_hourly_price = parseInt(weekend_hourly_price);
    if (weekend_unlimited_price !== undefined) dataToUpdate.weekend_unlimited_price = parseInt(weekend_unlimited_price);
    if (show_price_cards !== undefined) dataToUpdate.show_price_cards = Boolean(show_price_cards);
    if (price_notice_text !== undefined) dataToUpdate.price_notice_text = price_notice_text;
    if (show_announcement !== undefined) dataToUpdate.show_announcement = Boolean(show_announcement);
    if (announcement_text !== undefined) dataToUpdate.announcement_text = announcement_text;
    if (show_line_button !== undefined) dataToUpdate.show_line_button = Boolean(show_line_button);
    if (line_button_url !== undefined) dataToUpdate.line_button_url = line_button_url;

    const setting = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: dataToUpdate,
      create: {
        id: 1,
        weekday_hourly_price: dataToUpdate.weekday_hourly_price ?? 100,
        weekday_unlimited_price: dataToUpdate.weekday_unlimited_price ?? 550,
        weekend_hourly_price: dataToUpdate.weekend_hourly_price ?? 150,
        weekend_unlimited_price: dataToUpdate.weekend_unlimited_price ?? 800,
        show_price_cards: dataToUpdate.show_price_cards ?? true,
        price_notice_text: dataToUpdate.price_notice_text ?? "費用皆含基礎傳統拼豆板與豆子無限使用．預約現場保留 15 分鐘．離場前請預留 10 分鐘壓平作品",
        show_announcement: dataToUpdate.show_announcement ?? true,
        announcement_text: dataToUpdate.announcement_text ?? "✨ 歡迎來到拾光製所！線上預約享即時選位，智能拼豆板租借滿時數再享買送折抵優惠",
        show_line_button: dataToUpdate.show_line_button ?? true,
        line_button_url: dataToUpdate.line_button_url ?? "https://lin.ee/vsZhRW5"
      }
    });

    res.json({ message: 'Global setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating global setting:', error);
    res.status(500).json({ error: 'Failed to update global setting' });
  }
};


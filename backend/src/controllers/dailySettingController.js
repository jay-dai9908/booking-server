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
  const { start_date, end_date, days_of_week, hourly_price, unlimited_price, allow_unlimited } = req.body;

  if (!start_date || !end_date) {
    return res.status(400).json({ error: 'start_date and end_date are required' });
  }

  try {
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);
    
    // Generate all dates in range
    const datesToUpdate = [];
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const day = currentDate.getDay(); // 0 (Sun) to 6 (Sat)
      
      // If days_of_week is provided (e.g. [0, 6] for weekends), check if matches
      if (!days_of_week || days_of_week.includes(day)) {
        datesToUpdate.push(new Date(currentDate));
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    const dataToUpdate = {};
    if (typeof allow_unlimited === 'boolean') dataToUpdate.allow_unlimited = allow_unlimited;
    if (hourly_price !== undefined) dataToUpdate.hourly_price = hourly_price === null ? null : parseInt(hourly_price);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = unlimited_price === null ? null : parseInt(unlimited_price);

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
        data: { hourly_price: 100, unlimited_price: 300 }
      });
    }
    res.json(setting);
  } catch (error) {
    console.error('Error fetching global setting:', error);
    res.status(500).json({ error: 'Failed to fetch global setting' });
  }
};

export const updateGlobalSetting = async (req, res) => {
  const { hourly_price, unlimited_price } = req.body;

  try {
    const dataToUpdate = {};
    if (hourly_price !== undefined) dataToUpdate.hourly_price = parseInt(hourly_price);
    if (unlimited_price !== undefined) dataToUpdate.unlimited_price = parseInt(unlimited_price);

    const setting = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: dataToUpdate,
      create: {
        id: 1,
        hourly_price: dataToUpdate.hourly_price ?? 100,
        unlimited_price: dataToUpdate.unlimited_price ?? 300
      }
    });

    res.json({ message: 'Global setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating global setting:', error);
    res.status(500).json({ error: 'Failed to update global setting' });
  }
};


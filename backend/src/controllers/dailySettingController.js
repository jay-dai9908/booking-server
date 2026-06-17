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
  const { date, allow_unlimited } = req.body;

  if (!date || typeof allow_unlimited !== 'boolean') {
    return res.status(400).json({ error: 'Date and boolean allow_unlimited are required' });
  }

  try {
    const setting = await prisma.dailySetting.upsert({
      where: { date: new Date(date) },
      update: { allow_unlimited },
      create: {
        date: new Date(date),
        allow_unlimited
      }
    });

    res.json({ message: 'Daily setting updated successfully', setting });
  } catch (error) {
    console.error('Error updating daily setting:', error);
    res.status(500).json({ error: 'Failed to update daily setting' });
  }
};

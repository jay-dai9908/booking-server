import prisma from '../prismaClient.js';

export const getUsers = async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        line_user_id: true,
        name: true,
        phone: true,
        created_at: true,
        is_blacklisted: true,
        notes: true
      }
    });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getUserReservations = async (req, res) => {
  const { id } = req.params;
  try {
    const reservations = await prisma.reservation.findMany({
      where: { user_id: parseInt(id) },
      include: {
        session: true
      },
      orderBy: {
        session: {
          session_date: 'desc'
        }
      }
    });
    res.json(reservations);
  } catch (error) {
    console.error('Error fetching user reservations:', error);
    res.status(500).json({ error: 'Failed to fetch user reservations' });
  }
};

export const updateUser = async (req, res) => {
  const { id } = req.params;
  const { is_blacklisted, notes } = req.body;
  
  try {
    const updatedUser = await prisma.user.update({
      where: { id: parseInt(id) },
      data: {
        is_blacklisted: is_blacklisted !== undefined ? is_blacklisted : undefined,
        notes: notes !== undefined ? notes : undefined
      }
    });
    res.json({ message: 'User updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

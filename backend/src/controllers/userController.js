import prisma from '../prismaClient.js';

export const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = (req.query.search || '').trim();
    
    const skip = (page - 1) * limit;

    let whereClause = {};
    if (search) {
      whereClause = {
        OR: [
          { name: { contains: search } },
          { phone: { contains: search } },
        ]
      };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          line_user_id: true,
          name: true,
          phone: true,
          created_at: true,
          is_blacklisted: true,
          notes: true
        }
      }),
      prisma.user.count({ where: whereClause })
    ]);

    res.json({
      data: users,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getUserById = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(req.params.id) },
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

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
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

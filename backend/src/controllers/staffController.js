import prisma from '../prismaClient.js';

export const getStaffs = async (req, res) => {
  try {
    const staffs = await prisma.adminUser.findMany({
      orderBy: { id: 'asc' }
    });
    res.json(staffs);
  } catch (error) {
    console.error('Error fetching staff list:', error);
    res.status(500).json({ error: '無法取得人員列表' });
  }
};

export const createStaff = async (req, res) => {
  const { name, password, permissions, role } = req.body;

  if (!name || !password) {
    return res.status(400).json({ error: '姓名與密碼為必填欄位' });
  }

  const superAdminPassword = process.env.ADMIN_PASSWORD || 'gathering.light2609';
  if (password === superAdminPassword) {
    return res.status(400).json({ error: '此密碼已被最高管理員佔用，請更換其他密碼' });
  }

  try {
    const existing = await prisma.adminUser.findUnique({
      where: { password }
    });

    if (existing) {
      return res.status(400).json({ error: '此密碼已被其他人員使用，請設定不同密碼' });
    }

    const newStaff = await prisma.adminUser.create({
      data: {
        name,
        password,
        permissions: Array.isArray(permissions) ? permissions : [],
        role: role || 'staff',
        is_active: true
      }
    });

    res.status(201).json(newStaff);
  } catch (error) {
    console.error('Error creating staff:', error);
    res.status(500).json({ error: '新增人員失敗' });
  }
};

export const updateStaff = async (req, res) => {
  const { id } = req.params;
  const { name, password, permissions, role, is_active } = req.body;

  try {
    const staffId = parseInt(id, 10);
    const existingStaff = await prisma.adminUser.findUnique({
      where: { id: staffId }
    });

    if (!existingStaff) {
      return res.status(404).json({ error: '找不到該人員' });
    }

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (permissions !== undefined) updateData.permissions = permissions;
    if (role !== undefined) updateData.role = role;
    if (is_active !== undefined) updateData.is_active = is_active;

    if (password !== undefined && password !== existingStaff.password) {
      const superAdminPassword = process.env.ADMIN_PASSWORD || 'gathering.light2609';
      if (password === superAdminPassword) {
        return res.status(400).json({ error: '此密碼已被最高管理員佔用，請更換其他密碼' });
      }

      const duplicate = await prisma.adminUser.findFirst({
        where: {
          password,
          NOT: { id: staffId }
        }
      });

      if (duplicate) {
        return res.status(400).json({ error: '此密碼已被其他人員使用，請設定不同密碼' });
      }

      updateData.password = password;
    }

    const updated = await prisma.adminUser.update({
      where: { id: staffId },
      data: updateData
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating staff:', error);
    res.status(500).json({ error: '更新人員資料失敗' });
  }
};

export const deleteStaff = async (req, res) => {
  const { id } = req.params;

  try {
    const staffId = parseInt(id, 10);
    await prisma.adminUser.delete({
      where: { id: staffId }
    });

    res.json({ message: '人員已成功刪除' });
  } catch (error) {
    console.error('Error deleting staff:', error);
    res.status(500).json({ error: '刪除人員失敗' });
  }
};

import prisma from '../prismaClient.js';

/**
 * Ensure default POS Quick Promo Codes and Addon Items exist on server startup
 */
export const ensureDefaultCheckoutConfigs = async () => {
  try {
    const promoCount = await prisma.promoCode.count();
    if (promoCount === 0) {
      await prisma.promoCode.createMany({
        data: [
          {
            code: 'CHECKIN30',
            name: '📸 現場打卡／限動折 $30',
            description: 'IG / FB / Threads 現場打卡或發限動即享整單折 $30',
            discount_type: 'fixed_order',
            discount_value: 30,
            max_discount_amount: null,
            target_scope: 'all',
            day_type_limit: 'all',
            mode_limit: 'all',
            channel: 'all',
            min_pax: 1,
            min_hours: 1,
            min_amount: 0,
            is_pos_quick_select: true,
            is_active: true
          },
          {
            code: 'REVIEW50',
            name: '⭐ Google 五星好評折 $50',
            description: '出示 Google 地圖五星評論畫面折抵 $50',
            discount_type: 'fixed_order',
            discount_value: 50,
            max_discount_amount: null,
            target_scope: 'all',
            day_type_limit: 'all',
            mode_limit: 'all',
            channel: 'all',
            min_pax: 1,
            min_hours: 1,
            min_amount: 0,
            is_pos_quick_select: true,
            is_active: true
          },
          {
            code: 'CHECKIN20P',
            name: '👥 同行打卡每人折 $20',
            description: '每位打卡貴賓各折 $20（依人數計算）',
            discount_type: 'fixed_per_pax',
            discount_value: 20,
            max_discount_amount: null,
            target_scope: 'all',
            day_type_limit: 'all',
            mode_limit: 'all',
            channel: 'all',
            min_pax: 1,
            min_hours: 1,
            min_amount: 0,
            is_pos_quick_select: true,
            is_active: true
          },
          {
            code: 'VIP90',
            name: '💎 貴賓 9 折優惠 (-10%)',
            description: '整單座位與設備費用享 9 折優惠',
            discount_type: 'percentage',
            discount_value: 10,
            max_discount_amount: null,
            target_scope: 'all',
            day_type_limit: 'all',
            mode_limit: 'all',
            channel: 'all',
            min_pax: 1,
            min_hours: 1,
            min_amount: 0,
            is_pos_quick_select: true,
            is_active: true
          }
        ],
        skipDuplicates: true
      });
      console.log('[Init] Seeded default PromoCode items.');
    }

    const addonCount = await prisma.addonItem.count();
    if (addonCount === 0) {
      await prisma.addonItem.createMany({
        data: [
          { name: '精緻鑰匙圈配件', price: 20, category: 'charm', sort_order: 1, is_active: true },
          { name: '造型磁鐵 / 胸針', price: 30, category: 'charm', sort_order: 2, is_active: true },
          { name: '質感龍蝦扣吊飾', price: 40, category: 'charm', sort_order: 3, is_active: true },
          { name: '立體公仔配件組', price: 50, category: 'charm', sort_order: 4, is_active: true },
          { name: '豪華雙層配件組', price: 80, category: 'charm', sort_order: 5, is_active: true },
          { name: '專人代燙 / 大圖加固', price: 50, category: 'service', sort_order: 6, is_active: true }
        ]
      });
      console.log('[Init] Seeded default AddonItem items.');
    }
  } catch (err) {
    console.error('[Init] Failed to seed default checkout configs:', err.message);
  }
};

/**
 * Core promo code validation & discount calculation helper
 */
export const evaluatePromoCode = async (txOrPrisma, {
  code,
  session_date,
  pax = 1,
  hours = 1,
  is_unlimited = false,
  base_amount = 0,
  hourly_price = 150,
  user_id = null,
  is_pos = false,
  skip_usage_check = false
}) => {
  const cleanCode = (code || '').trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: '請輸入折扣碼' };
  }

  const promo = await txOrPrisma.promoCode.findUnique({
    where: { code: cleanCode }
  });

  if (!promo || !promo.is_active) {
    return { valid: false, error: '無效或已停用的優惠券／折扣碼' };
  }

  // 1. Channel check: online vs pos vs all
  const channel = promo.channel || 'all';
  if (channel === 'pos' && !is_pos) {
    return { valid: false, error: '此優惠券僅供現場櫃檯結帳使用' };
  }
  if (channel === 'online' && is_pos) {
    return { valid: false, error: '此折扣碼僅限線上預約時使用' };
  }

  // 2. Date validity check
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const targetDateStr = session_date ? new Date(session_date).toISOString().split('T')[0] : todayStr;

  const startDate = promo.start_date || promo.valid_from;
  const endDate = promo.end_date || promo.valid_until;

  if (startDate) {
    const sStr = new Date(startDate).toISOString().split('T')[0];
    if (targetDateStr < sStr) {
      return { valid: false, error: `此活動於 ${sStr} 開始，尚未生效` };
    }
  }
  if (endDate) {
    const eStr = new Date(endDate).toISOString().split('T')[0];
    if (targetDateStr > eStr) {
      return { valid: false, error: `此活動已於 ${eStr} 截止` };
    }
  }

  // 3. Usage limits
  if (!skip_usage_check && promo.max_uses != null && promo.used_count >= promo.max_uses) {
    return { valid: false, error: '此優惠碼已達總使用次數上限' };
  }

  if (!skip_usage_check && user_id && promo.max_uses_per_user != null) {
    const userUsedReservations = await txOrPrisma.reservation.findMany({
      where: {
        user_id: parseInt(user_id, 10),
        promo_code: { contains: cleanCode },
        status: 'confirmed'
      },
      select: { booking_ref: true }
    });
    const uniqueRefs = new Set(userUsedReservations.map(r => r.booking_ref));
    if (uniqueRefs.size >= promo.max_uses_per_user) {
      return { valid: false, error: `每位會員限用 ${promo.max_uses_per_user} 次，您已達使用上限` };
    }
  }

  // 4. Day of week check (weekday vs weekend)
  const dayLimit = promo.day_type_limit || promo.applicable_days || 'all';
  if (session_date && dayLimit !== 'all') {
    const d = new Date(session_date);
    const day = isNaN(d.getTime()) ? new Date().getDay() : d.getUTCDay();
    const isWeekend = day === 0 || day === 6;
    if (dayLimit === 'weekday' && isWeekend) {
      return { valid: false, error: '此優惠碼僅限平日使用' };
    }
    if (dayLimit === 'weekend' && !isWeekend) {
      return { valid: false, error: '此優惠碼僅限假日（週六／週日）使用' };
    }
  }

  // 5. Mode check (hourly vs unlimited)
  const modeLimit = promo.mode_limit || promo.applicable_mode || 'all';
  if (modeLimit !== 'all') {
    if ((modeLimit === 'hourly' || modeLimit === 'regular') && is_unlimited) {
      return { valid: false, error: '此優惠碼僅適用於一般計時方案' };
    }
    if (modeLimit === 'unlimited' && !is_unlimited) {
      return { valid: false, error: '此優惠碼僅適用於不限時（封頂）方案' };
    }
  }

  // 6. Minimum thresholds
  if (promo.min_pax > 1 && pax < promo.min_pax) {
    return { valid: false, error: `此優惠碼需滿 ${promo.min_pax} 人以上方可使用` };
  }
  if (promo.min_hours > 0 && hours < promo.min_hours) {
    return { valid: false, error: `此優惠碼需預約滿 ${promo.min_hours} 小時以上方可使用` };
  }
  if (promo.min_amount > 0 && base_amount > 0 && base_amount < promo.min_amount) {
    return { valid: false, error: `此優惠碼需消費滿 $${promo.min_amount} 方可使用` };
  }

  // 7. Calculate discount amount
  let discount_amount = 0;
  if (promo.discount_type === 'fixed_order') {
    discount_amount = promo.discount_value;
  } else if (promo.discount_type === 'fixed_per_pax') {
    discount_amount = promo.discount_value * Math.max(1, Number(pax) || 1);
  } else if (promo.discount_type === 'percentage') {
    const val = promo.discount_value;
    const pctOff = val > 50 && val < 100 ? (100 - val) : val;
    discount_amount = Math.round((Number(base_amount) || 0) * (pctOff / 100));
  } else if (promo.discount_type === 'free_hours') {
    discount_amount = Math.round((Number(hourly_price) || 150) * promo.discount_value);
  }

  // Apply maximum discount cap if configured
  if (promo.max_discount_amount && promo.max_discount_amount > 0) {
    discount_amount = Math.min(discount_amount, promo.max_discount_amount);
  }

  if (base_amount > 0) {
    discount_amount = Math.min(discount_amount, Number(base_amount));
  }

  return {
    valid: true,
    promo,
    discount_amount: Math.max(0, Math.round(discount_amount))
  };
};

// POST /api/checkout/promo-codes/validate
export const validatePromoCode = async (req, res) => {
  try {
    const result = await evaluatePromoCode(prisma, {
      ...req.body,
      user_id: req.user?.id || req.body.user_id || null,
      is_pos: req.body.is_pos === true || req.user?.role === 'admin'
    });

    if (!result.valid) {
      return res.status(400).json({ valid: false, error: result.error });
    }

    res.json({
      valid: true,
      promo: {
        id: result.promo.id,
        code: result.promo.code,
        name: result.promo.name,
        description: result.promo.description,
        discount_type: result.promo.discount_type,
        discount_value: result.promo.discount_value,
        max_discount_amount: result.promo.max_discount_amount,
        target_scope: result.promo.target_scope,
        channel: result.promo.channel
      },
      discount_amount: result.discount_amount
    });
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ error: '驗證折扣碼失敗' });
  }
};

// GET /api/checkout/promo-codes
export const getPromoCodes = async (req, res) => {
  try {
    const { pos_only, active_only, channel } = req.query;
    const where = {};
    if (pos_only === 'true') {
      where.is_active = true;
      where.is_pos_quick_select = true;
    }
    if (active_only === 'true') {
      where.is_active = true;
    }
    if (channel && channel !== 'all') {
      where.OR = [{ channel }, { channel: 'all' }];
    }

    const codes = await prisma.promoCode.findMany({
      where,
      orderBy: [
        { is_pos_quick_select: 'desc' },
        { created_at: 'desc' }
      ]
    });
    res.json(codes);
  } catch (error) {
    console.error('Error fetching promo codes:', error);
    res.status(500).json({ error: '無法載入優惠券列表' });
  }
};

// POST /api/checkout/promo-codes
export const createPromoCode = async (req, res) => {
  try {
    const {
      code,
      name,
      description,
      discount_type = 'fixed_order',
      discount_value = 0,
      max_discount_amount = null,
      target_scope = 'all',
      day_type_limit,
      applicable_days,
      mode_limit,
      applicable_mode,
      channel = 'all',
      min_pax = 1,
      min_hours = 1,
      min_amount = 0,
      max_uses = null,
      max_uses_per_user = null,
      start_date,
      valid_from,
      end_date,
      valid_until,
      is_pos_quick_select = false,
      is_active = true
    } = req.body;

    const cleanCode = (code || '').trim().toUpperCase();
    if (!cleanCode || !name) {
      return res.status(400).json({ error: '請填寫優惠碼代號與顯示名稱' });
    }

    const existing = await prisma.promoCode.findUnique({ where: { code: cleanCode } });
    if (existing) {
      return res.status(400).json({ error: `優惠碼代號 ${cleanCode} 已存在` });
    }

    const startDateVal = start_date || valid_from;
    const endDateVal = end_date || valid_until;

    const created = await prisma.promoCode.create({
      data: {
        code: cleanCode,
        name: name.trim(),
        description: description ? description.trim() : null,
        discount_type,
        discount_value: parseInt(discount_value, 10) || 0,
        max_discount_amount: max_discount_amount !== null && max_discount_amount !== '' ? parseInt(max_discount_amount, 10) : null,
        target_scope: target_scope || 'all',
        day_type_limit: day_type_limit || applicable_days || 'all',
        mode_limit: mode_limit || applicable_mode || 'all',
        channel: channel || 'all',
        min_pax: parseInt(min_pax, 10) || 1,
        min_hours: parseInt(min_hours, 10) || 1,
        min_amount: parseInt(min_amount, 10) || 0,
        max_uses: max_uses !== null && max_uses !== '' ? parseInt(max_uses, 10) : null,
        max_uses_per_user: max_uses_per_user !== null && max_uses_per_user !== '' ? parseInt(max_uses_per_user, 10) : null,
        start_date: startDateVal ? new Date(startDateVal) : null,
        end_date: endDateVal ? new Date(endDateVal) : null,
        is_pos_quick_select: Boolean(is_pos_quick_select),
        is_active: Boolean(is_active)
      }
    });

    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating promo code:', error);
    res.status(500).json({ error: '新增優惠券失敗' });
  }
};

// PUT /api/checkout/promo-codes/:id
export const updatePromoCode = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const {
      code,
      name,
      description,
      discount_type,
      discount_value,
      max_discount_amount,
      target_scope,
      day_type_limit,
      applicable_days,
      mode_limit,
      applicable_mode,
      channel,
      min_pax,
      min_hours,
      min_amount,
      max_uses,
      max_uses_per_user,
      start_date,
      valid_from,
      end_date,
      valid_until,
      is_pos_quick_select,
      is_active
    } = req.body;

    const data = {};
    if (code !== undefined) data.code = code.trim().toUpperCase();
    if (name !== undefined) data.name = name.trim();
    if (description !== undefined) data.description = description ? description.trim() : null;
    if (discount_type !== undefined) data.discount_type = discount_type;
    if (discount_value !== undefined) data.discount_value = parseInt(discount_value, 10) || 0;
    if (max_discount_amount !== undefined) data.max_discount_amount = max_discount_amount !== null && max_discount_amount !== '' ? parseInt(max_discount_amount, 10) : null;
    if (target_scope !== undefined) data.target_scope = target_scope;
    if (day_type_limit !== undefined || applicable_days !== undefined) data.day_type_limit = day_type_limit || applicable_days;
    if (mode_limit !== undefined || applicable_mode !== undefined) data.mode_limit = mode_limit || applicable_mode;
    if (channel !== undefined) data.channel = channel;
    if (min_pax !== undefined) data.min_pax = parseInt(min_pax, 10) || 1;
    if (min_hours !== undefined) data.min_hours = parseInt(min_hours, 10) || 1;
    if (min_amount !== undefined) data.min_amount = parseInt(min_amount, 10) || 0;
    if (max_uses !== undefined) data.max_uses = max_uses !== null && max_uses !== '' ? parseInt(max_uses, 10) : null;
    if (max_uses_per_user !== undefined) data.max_uses_per_user = max_uses_per_user !== null && max_uses_per_user !== '' ? parseInt(max_uses_per_user, 10) : null;
    
    if (start_date !== undefined || valid_from !== undefined) {
      const v = start_date !== undefined ? start_date : valid_from;
      data.start_date = v ? new Date(v) : null;
    }
    if (end_date !== undefined || valid_until !== undefined) {
      const v = end_date !== undefined ? end_date : valid_until;
      data.end_date = v ? new Date(v) : null;
    }
    if (is_pos_quick_select !== undefined) data.is_pos_quick_select = Boolean(is_pos_quick_select);
    if (is_active !== undefined) data.is_active = Boolean(is_active);

    const updated = await prisma.promoCode.update({
      where: { id },
      data
    });
    res.json(updated);
  } catch (error) {
    console.error('Error updating promo code:', error);
    res.status(500).json({ error: '更新優惠券失敗' });
  }
};

// DELETE /api/checkout/promo-codes/:id
export const deletePromoCode = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.promoCode.delete({ where: { id } });
    res.json({ message: '優惠券已刪除' });
  } catch (error) {
    console.error('Error deleting promo code:', error);
    res.status(500).json({ error: '刪除優惠券失敗' });
  }
};

// GET /api/checkout/addons
export const getAddonItems = async (req, res) => {
  try {
    const { active_only } = req.query;
    const where = active_only === 'true' ? { is_active: true } : {};
    const items = await prisma.addonItem.findMany({
      where,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
    });
    res.json(items);
  } catch (error) {
    console.error('Error fetching addon items:', error);
    res.status(500).json({ error: '無法載入加購品項' });
  }
};

// POST /api/checkout/addons
export const createAddonItem = async (req, res) => {
  try {
    const { name, price, category = 'charm', sort_order = 0, is_active = true } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ error: '請填寫品項名稱與價格' });
    }
    const created = await prisma.addonItem.create({
      data: {
        name: name.trim(),
        price: parseInt(price, 10) || 0,
        category,
        sort_order: parseInt(sort_order, 10) || 0,
        is_active: Boolean(is_active)
      }
    });
    res.status(201).json(created);
  } catch (error) {
    console.error('Error creating addon item:', error);
    res.status(500).json({ error: '新增加購品項失敗' });
  }
};

// PUT /api/checkout/addons/:id
export const updateAddonItem = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, price, category, sort_order, is_active } = req.body;
    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (price !== undefined) data.price = parseInt(price, 10) || 0;
    if (category !== undefined) data.category = category;
    if (sort_order !== undefined) data.sort_order = parseInt(sort_order, 10) || 0;
    if (is_active !== undefined) data.is_active = Boolean(is_active);

    const updated = await prisma.addonItem.update({
      where: { id },
      data
    });
    res.json(updated);
  } catch (error) {
    console.error('Error updating addon item:', error);
    res.status(500).json({ error: '更新加購品項失敗' });
  }
};

// DELETE /api/checkout/addons/:id
export const deleteAddonItem = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.addonItem.delete({ where: { id } });
    res.json({ message: '加購品項已刪除' });
  } catch (error) {
    console.error('Error deleting addon item:', error);
    res.status(500).json({ error: '刪除加購品項失敗' });
  }
};

/**
 * POST /api/checkout/reservations/:booking_ref
 * Complete or update split-billing checkout for a reservation
 */
export const submitReservationCheckout = async (req, res) => {
  const { booking_ref } = req.params;
  const {
    total_amount,
    payment_method = 'cash',
    checkout_unlimited_pax,
    checkout_regular_hours,
    checkout_details,
    promo_code,
    discount_amount = 0,
    addons_amount = 0,
    is_paid = true
  } = req.body;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.reservation.findMany({
        where: { booking_ref }
      });

      if (existing.length === 0) {
        throw new Error('NOT_FOUND');
      }

      const firstRes = existing[0];
      const prevPromoCode = firstRes.promo_code || '';
      const newPromoCode = promo_code ? String(promo_code).trim().toUpperCase() : null;

      // Increment used_count for newly applied promo codes
      if (newPromoCode && newPromoCode !== prevPromoCode) {
        const codesList = newPromoCode.split(',').map(s => s.trim()).filter(Boolean);
        const prevCodesList = prevPromoCode.split(',').map(s => s.trim()).filter(Boolean);
        for (const c of codesList) {
          if (!prevCodesList.includes(c)) {
            await tx.promoCode.updateMany({
              where: { code: c },
              data: { used_count: { increment: 1 } }
            });
          }
        }
      }

      const finalAmount = total_amount !== undefined && total_amount !== null
        ? Math.max(0, parseInt(total_amount, 10) || 0)
        : (firstRes.total_amount || 0);

      const updateData = {
        total_amount: finalAmount,
        is_amount_manual: true,
        is_paid: Boolean(is_paid),
        paid_at: is_paid ? (firstRes.paid_at || new Date()) : null,
        payment_method: is_paid ? (payment_method || 'cash') : null,
        checkout_unlimited_pax: checkout_unlimited_pax !== undefined && checkout_unlimited_pax !== null
          ? parseInt(checkout_unlimited_pax, 10)
          : null,
        checkout_regular_hours: checkout_regular_hours !== undefined && checkout_regular_hours !== null
          ? parseFloat(checkout_regular_hours)
          : null,
        checkout_details: checkout_details || null,
        promo_code: newPromoCode,
        discount_amount: parseInt(discount_amount, 10) || 0,
        addons_amount: parseInt(addons_amount, 10) || 0
      };

      await tx.reservation.updateMany({
        where: { booking_ref },
        data: updateData
      });

      return updateData;
    });

    res.json({
      message: '結帳資料已儲存',
      checkout: result
    });
  } catch (error) {
    console.error('Error submitting reservation checkout:', error);
    if (error.message === 'NOT_FOUND') {
      return res.status(404).json({ error: '找不到此預約單' });
    }
    res.status(500).json({ error: '結帳處理失敗' });
  }
};

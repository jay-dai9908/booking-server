import prisma from '../prismaClient.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { normalizePromoRule, computePromoDiscount } from '../../../shared/promo.js';
import { splitAmount } from '../../../shared/splitAmount.js';

export const DEFAULT_PROMO_CODES = [
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
    channel: 'pos',
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
    channel: 'pos',
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
    channel: 'pos',
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
    channel: 'pos',
    min_pax: 1,
    min_hours: 1,
    min_amount: 0,
    is_pos_quick_select: true,
    is_active: true
  }
];

/**
 * Ensure default POS Quick Promo Codes and Addon Items exist on server startup
 */
export const ensureDefaultCheckoutConfigs = async () => {
  try {
    const promoCount = await prisma.promoCode.count();
    if (promoCount === 0) {
      await prisma.promoCode.createMany({
        data: DEFAULT_PROMO_CODES,
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
  has_mixed_modes = false,
  base_amount = 0,
  hourly_price = 150,
  user_id = null,
  is_pos = false,
  skip_usage_check = false,
  seating_amount,
  equipment_amount,
  persons = null,
  exclude_booking_ref = null
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

  // 2. Date validity check (Taipei calendar date)
  const todayStr = toTaipeiDateString(new Date());
  const targetDateStr = session_date ? toTaipeiDateString(session_date) : todayStr;

  const startDate = promo.start_date || promo.valid_from;
  const endDate = promo.end_date || promo.valid_until;

  if (startDate) {
    const sStr = toTaipeiDateString(startDate);
    if (sStr && targetDateStr < sStr) {
      return { valid: false, error: `此活動於 ${sStr} 開始，尚未生效` };
    }
  }
  if (endDate) {
    const eStr = toTaipeiDateString(endDate);
    if (eStr && targetDateStr > eStr) {
      return { valid: false, error: `此活動已於 ${eStr} 截止` };
    }
  }

  // 3. Usage limits (derived from PromoRedemption active records)
  if (!skip_usage_check && promo.max_uses != null) {
    const activeTotal = await txOrPrisma.promoRedemption.count({
      where: {
        promo_id: promo.id,
        status: 'active',
        ...(exclude_booking_ref ? { booking_ref: { not: exclude_booking_ref } } : {})
      }
    });
    if (activeTotal >= promo.max_uses) {
      return { valid: false, error: '此優惠碼已達總使用次數上限' };
    }
  }

  if (!skip_usage_check && user_id && promo.max_uses_per_user != null) {
    const activeUserCount = await txOrPrisma.promoRedemption.count({
      where: {
        promo_id: promo.id,
        user_id: parseInt(user_id, 10),
        status: 'active',
        ...(exclude_booking_ref ? { booking_ref: { not: exclude_booking_ref } } : {})
      }
    });
    if (activeUserCount >= promo.max_uses_per_user) {
      return { valid: false, error: `每位會員限用 ${promo.max_uses_per_user} 次，您已達使用上限` };
    }
  }

  // 4. Day of week check (weekday vs weekend in Taipei date)
  const dayLimit = promo.day_type_limit || promo.applicable_days || 'all';
  if (session_date && dayLimit !== 'all' && targetDateStr) {
    const day = new Date(`${targetDateStr}T00:00:00Z`).getUTCDay();
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
    if (has_mixed_modes) {
      return { valid: false, error: '此優惠碼僅適用於全體相同計費方案（計時或不限時混用時不適用）' };
    }
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

  // 7. Normalize rule and compute unified discount
  const rule = normalizePromoRule(promo, { hourly_price });
  let personInputs;
  if (Array.isArray(persons) && persons.length > 0) {
    personInputs = persons.map((p, idx) => ({
      person_no: p.person_no ?? idx + 1,
      entry_amount: Number(p.entry_amount ?? p.entry?.amount ?? 0) || 0,
      board_amount: Number(p.board_amount ?? p.board?.amount ?? 0) || 0,
      base_amount: Number(p.base_amount ?? 0) || 0
    }));
  } else {
    const count = Math.max(1, parseInt(pax, 10) || 1);
    const rawBase = Math.max(0, Math.round(Number(base_amount) || 0));
    const dummyWeights = Array.from({ length: count }, (_, i) => ({ person_no: i + 1, weight: 1 }));
    if (seating_amount !== undefined || equipment_amount !== undefined) {
      const eqAmt = Math.max(0, Math.round(Number(equipment_amount) || 0));
      const seatTotal = seating_amount !== undefined
        ? Math.max(0, Math.round(Number(seating_amount) || 0))
        : Math.max(0, rawBase - eqAmt);
      const extraTotal = Math.max(0, rawBase - seatTotal - eqAmt);
      const seatSplits = splitAmount(seatTotal, dummyWeights);
      const extraSplits = extraTotal > 0 ? splitAmount(extraTotal, dummyWeights) : null;
      personInputs = seatSplits.map((s, idx) => {
        const boardAmt = idx === 0 ? eqAmt : 0;
        const extraAmt = extraSplits ? extraSplits[idx].amount : 0;
        return {
          person_no: s.person_no,
          entry_amount: s.amount,
          board_amount: boardAmt,
          base_amount: s.amount + boardAmt + extraAmt
        };
      });
    } else {
      const baseSplits = splitAmount(rawBase, dummyWeights);
      personInputs = baseSplits.map((s) => ({
        person_no: s.person_no,
        entry_amount: s.amount,
        board_amount: 0,
        base_amount: s.amount
      }));
    }
  }

  const { total } = computePromoDiscount(rule, personInputs);

  return {
    valid: true,
    promo,
    rule,
    discount_amount: Math.max(0, Math.round(total))
  };
};

async function validatePromoCodeCore(req, res) {
  try {
    const {
      is_pos: _ignoredIsPos,
      skip_usage_check: _ignoredSkipUsageCheck,
      user_id: _ignoredUserId,
      ...safeBody
    } = req.body || {};

    const result = await evaluatePromoCode(prisma, {
      ...safeBody,
      user_id: req.user.id,
      is_pos: false,
      skip_usage_check: false
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
        percent_off: result.promo.percent_off ?? null,
        min_spend: result.promo.min_amount ?? 0,
        min_amount: result.promo.min_amount ?? 0,
        min_pax: result.promo.min_pax ?? 1,
        min_hours: result.promo.min_hours ?? 1,
        max_discount: result.promo.max_discount_amount ?? null,
        max_discount_amount: result.promo.max_discount_amount ?? null,
        applicable_type: result.promo.target_scope ?? 'all',
        target_scope: result.promo.target_scope ?? 'all'
      },
      discount_amount: result.discount_amount
    });
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ error: '驗證折扣碼失敗' });
  }
}

// POST /api/checkout/promo-codes/validate
export const validatePromoCode = (req, res) => validatePromoCodeCore(req, res);

// POST /api/checkout/admin/promo-codes/validate (deprecated: replaced by /api/billing/:booking_ref/promos)
export const adminValidatePromoCode = (req, res) => {
  return res.status(410).json({ code: 'GONE', error: '請改用帳單的優惠碼端點' });
};

// GET /api/checkout/promo-codes
export const getPromoCodes = async (req, res) => {
  try {
    const { pos_only, active_only, channel, include_archived } = req.query;
    const where = {};
    if (include_archived !== 'true') {
      where.archived_at = null;
    }
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
      percent_off,
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
      return res.status(409).json({ error: `優惠碼代號 ${cleanCode} 已存在` });
    }

    const startDateVal = start_date || valid_from;
    const endDateVal = end_date || valid_until;

    let finalDiscountValue = parseInt(discount_value, 10) || 0;
    let finalPercentOff = null;
    if (discount_type === 'percentage') {
      const num = typeof percent_off === 'boolean' || percent_off === null || percent_off === '' || percent_off === undefined
        ? NaN
        : Number(percent_off);
      if (!Number.isInteger(num) || num < 1 || num > 100) {
        return res.status(422).json({ error: '百分比折抵 percent_off 必須為 1～100 的整數' });
      }
      finalPercentOff = num;
      finalDiscountValue = num;
    }

    const created = await prisma.promoCode.create({
      data: {
        code: cleanCode,
        name: name.trim(),
        description: description ? description.trim() : null,
        discount_type,
        discount_value: finalDiscountValue,
        percent_off: finalPercentOff,
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
    if (error?.code === 'P2002') {
      const cleanCode = (req.body?.code || '').trim().toUpperCase();
      return res.status(409).json({ error: `優惠碼代號 ${cleanCode} 已存在` });
    }
    console.error('Error creating promo code:', error);
    res.status(500).json({ error: '新增優惠券失敗' });
  }
};

// PUT /api/checkout/promo-codes/:id
export const updatePromoCode = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existingPromo = await prisma.promoCode.findUnique({ where: { id } });
    if (!existingPromo) {
      return res.status(404).json({ error: '找不到此優惠碼' });
    }

    const {
      code,
      name,
      description,
      discount_type,
      discount_value,
      percent_off,
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
    if (code !== undefined) {
      const nextCode = String(code).trim().toUpperCase();
      if (!nextCode) {
        return res.status(422).json({ error: '優惠碼代號不可為空' });
      }
      if (nextCode !== existingPromo.code) {
        const usedAnyCount = await prisma.promoRedemption.count({ where: { promo_id: id } });
        if (usedAnyCount > 0) {
          return res.status(422).json({ error: '已有使用紀錄，請停用後另建新碼' });
        }
        const dup = await prisma.promoCode.findUnique({ where: { code: nextCode } });
        if (dup && dup.id !== id) {
          return res.status(409).json({ error: `優惠碼代號 ${nextCode} 已存在` });
        }
      }
      data.code = nextCode;
    }
    if (name !== undefined) data.name = name.trim();
    if (description !== undefined) data.description = description ? description.trim() : null;
    if (discount_type !== undefined) data.discount_type = discount_type;
    const targetType = discount_type !== undefined ? discount_type : existingPromo.discount_type;
    if (targetType === 'percentage') {
      if (percent_off !== undefined) {
        const num = typeof percent_off === 'boolean' || percent_off === null || percent_off === ''
          ? NaN
          : Number(percent_off);
        if (!Number.isInteger(num) || num < 1 || num > 100) {
          return res.status(422).json({ error: '百分比折抵 percent_off 必須為 1～100 的整數' });
        }
        data.percent_off = num;
        data.discount_value = num;
      } else if (discount_type === 'percentage' || discount_value !== undefined) {
        return res.status(422).json({ error: '百分比折抵請提供 1～100 的整數 percent_off' });
      }
    } else {
      if (discount_value !== undefined) data.discount_value = parseInt(discount_value, 10) || 0;
      if (discount_type !== undefined) data.percent_off = null;
    }
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
    if (is_active !== undefined) {
      data.is_active = Boolean(is_active);
      if (data.is_active) data.archived_at = null;
    }

    const updated = await prisma.promoCode.update({
      where: { id },
      data
    });
    res.json(updated);
  } catch (error) {
    if (error?.code === 'P2002') {
      const nextCode = (req.body?.code || '').trim().toUpperCase();
      return res.status(409).json({ error: `優惠碼代號 ${nextCode} 已存在` });
    }
    console.error('Error updating promo code:', error);
    res.status(500).json({ error: '更新優惠券失敗' });
  }
};

// DELETE /api/checkout/promo-codes/:id (archive/deactivate instead of deleting)
export const deletePromoCode = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = await prisma.promoCode.update({
      where: { id },
      data: {
        is_active: false,
        archived_at: new Date()
      }
    });
    res.json({ message: '優惠券已停用', promo: updated });
  } catch (error) {
    console.error('Error deleting promo code:', error);
    res.status(500).json({ error: '停用優惠券失敗' });
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
 * POST /api/checkout/reservations/:booking_ref (Deprecated legacy endpoint)
 */
export const submitReservationCheckout = async (_req, res) => {
  return res.status(410).json({
    code: 'ENDPOINT_REMOVED',
    error: '這個結帳方式已停用，請用結帳工作台'
  });
};

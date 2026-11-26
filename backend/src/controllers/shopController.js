import crypto from 'crypto';
import prisma from '../prismaClient.js';
import {
  sendProductOrderDepositVerifiedNotification,
  sendProductArrivalNotification
} from '../utils/lineMessaging.js';
import {
  assignPoolAccount,
  releasePoolAccount,
  markPoolAccountUsed
} from '../services/selfService/poolAccountService.js';
import { activeUserWhere } from '../utils/userQuery.js';
import { sanitizeGlobalSetting } from '../utils/sanitizeGlobalSetting.js';
import auditService from '../services/audit/auditService.js';
import { isSafeHttpUrl, safeHttpUrl } from '../../../shared/safeUrl.js';
import { getAdminDeviceInfo } from '../utils/deviceParser.js';
import { applyShopOrderPayment } from '../services/shop/shopPayment.js';
import { refundShopOrder } from '../services/shop/shopRefund.js';
import { getNextDailySeq } from '../services/billing/billService.js';
import { toTaipeiDateString } from '../../../shared/time.js';
import { diffFields, maskBankAccountsForAudit } from '../services/audit/settingAudit.js';
import { buildOrderPaymentInfo, formatMultiBankChoice } from '../services/shop/orderPaymentInfo.js';

function normalizeBankAccountsForAudit(val) {
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? maskBankAccountsForAudit(parsed) : val;
    } catch {
      return val;
    }
  }
  return Array.isArray(val) ? maskBankAccountsForAudit(val) : (val ?? null);
}

/**
 * Public: Get active products for customer shop
 */
export const getPublicProducts = async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        visibility_status: { not: 'HIDDEN' }
      },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
    });
    res.json(products);
  } catch (error) {
    console.error('getPublicProducts error:', error);
    res.status(500).json({ error: '獲取商品列表失敗' });
  }
};

/**
 * Public: Get enabled payment methods
 */
export const getPublicPaymentMethods = async (req, res) => {
  try {
    const [methods, poolCountsRaw, globalSetting] = await Promise.all([
      prisma.paymentMethodConfig.findMany({
        where: { is_enabled: true },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
      }),
      prisma.oneTimeAccountPool.groupBy({
        by: ['payment_method_code'],
        where: { status: 'AVAILABLE' },
        _count: { _all: true }
      }),
      prisma.globalSetting.findUnique({ where: { id: 1 } })
    ]);

    const countByCode = new Map(poolCountsRaw.map((row) => [row.payment_method_code, row._count._all]));
    const pool_available_counts = {};
    for (const m of methods) {
      if (m.method_type === 'POOL_ACCOUNT') {
        pool_available_counts[m.code] = countByCode.get(m.code) || 0;
      }
    }
    const ctbcPoolAvailableCount = countByCode.get('ctbc_pool') || 0;

    res.json({
      payment_methods: methods,
      pool_available_counts,
      ctbc_pool_available_count: ctbcPoolAvailableCount,
      deposit_deadline_days: globalSetting?.shop_deposit_deadline_days ?? 2,
      official_line_url: safeHttpUrl(globalSetting?.official_line_url || globalSetting?.line_button_url, null),
      line_button_url: safeHttpUrl(globalSetting?.line_button_url || globalSetting?.official_line_url, null),
      enable_shipping: !!globalSetting?.shop_enable_shipping,
      shipping_fee: globalSetting?.shop_shipping_fee ?? 60,
      default_arrival_note: globalSetting?.shop_default_arrival_note || '',
      bead_colors_json: Array.isArray(globalSetting?.bead_colors_json) ? globalSetting.bead_colors_json : []
    });
  } catch (error) {
    console.error('getPublicPaymentMethods error:', error);
    res.status(500).json({ error: '獲取付款方式失敗' });
  }
};

/**
 * Public/Customer: Place preorder
 */
export const createProductOrder = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: '請先登入後再進行預購下單' });
  }

  const {
    items = [],
    payment_method_code,
    selected_bank_info = null,
    delivery_method = 'store_pickup',
    shipping_info = null,
    wish_note = null,
    customer_note = null,
    remittance_last5 = null
  } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: '請至少選擇一項商品' });
  }

  if (!payment_method_code) {
    return res.status(400).json({ error: '請選擇付款方式' });
  }

  try {
    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });
    if (globalSetting && globalSetting.shop_enabled === false) {
      return res.status(403).json({ error: '預購商城目前維護暫停中' });
    }

    // 所有付款方式（包含到店付款）皆套用付款期限 = 下單時間 + shop_deposit_deadline_days 天
    const now = (process.env.NODE_ENV === 'test' && req.body?.now)
      ? new Date(req.body.now)
      : new Date();
    const deadlineDays = globalSetting?.shop_deposit_deadline_days ?? 2;
    const paymentDeadline = new Date(now.getTime() + deadlineDays * 24 * 60 * 60 * 1000);

    // 檢查付款方式是否存在且已啟用
    const paymentMethod = await prisma.paymentMethodConfig.findUnique({
      where: { code: payment_method_code }
    });
    if (!paymentMethod || !paymentMethod.is_enabled) {
      return res.status(400).json({ error: '選擇的付款方式不存在或未啟用' });
    }

    let resolvedSelectedBankInfo = null;
    if (paymentMethod.method_type === 'MULTI_BANK') {
      const rawAccounts = paymentMethod.bank_accounts_json;
      let bankAccounts = [];
      if (Array.isArray(rawAccounts)) {
        bankAccounts = rawAccounts;
      } else if (typeof rawAccounts === 'string') {
        try {
          const parsed = JSON.parse(rawAccounts);
          bankAccounts = Array.isArray(parsed) ? parsed : [];
        } catch {
          bankAccounts = [];
        }
      }
      if (bankAccounts.length === 0) {
        return res.status(400).json({ code: 'NO_BANK_ACCOUNTS', error: '這個付款方式還沒設定帳號' });
      }
      const allowedChoices = bankAccounts.map((b) => formatMultiBankChoice(b).trim());
      const cleanBankInfo = selected_bank_info ? String(selected_bank_info).trim() : '';
      if (!cleanBankInfo && allowedChoices.length === 1) {
        resolvedSelectedBankInfo = allowedChoices[0];
      } else if (cleanBankInfo && allowedChoices.includes(cleanBankInfo)) {
        resolvedSelectedBankInfo = cleanBankInfo;
      } else {
        return res.status(400).json({ code: 'INVALID_BANK_INFO', error: '請重新選擇匯款帳號' });
      }
    }

    const productIds = items.map(i => parseInt(i.product_id, 10)).filter(Boolean);
    const dbProducts = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = new Map(dbProducts.map(p => [p.id, p]));

    let totalAmount = 0;
    let depositRequired = 0;
    const orderItemsData = [];
    let arrivalNote = '';

    for (const item of items) {
      const pid = parseInt(item.product_id, 10);
      const prod = productMap.get(pid);
      if (!prod) {
        return res.status(400).json({ error: `找不到商品 ID: ${item.product_id}` });
      }

      if (prod.visibility_status === 'HIDDEN' || prod.visibility_status === 'SOLD_OUT') {
        return res.status(400).json({ error: `商品「${prod.name}」目前已下架或售完，無法預購` });
      }

      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      let unitPrice = prod.price;

      // Handle tiered pricing if configured (e.g. 10g beads: 20 bags $280, 10 bags $150, 1 bag $16)
      // Supports two modes: 'combined' (混色合計包數) or 'per_color' (單色獨立計算)
      const calcTieredPriceForQty = (targetQty) => {
        if (!Array.isArray(prod.tier_pricing) || prod.tier_pricing.length === 0) {
          return unitPrice * targetQty;
        }
        const sortedTiers = [...prod.tier_pricing].sort((a, b) => (b.qty || 0) - (a.qty || 0));
        let remainingQty = targetQty;
        let tierTotal = 0;
        for (const tier of sortedTiers) {
          if (remainingQty >= tier.qty && tier.qty > 0) {
            const count = Math.floor(remainingQty / tier.qty);
            tierTotal += count * tier.price;
            remainingQty = remainingQty % tier.qty;
          }
        }
        if (remainingQty > 0) {
          tierTotal += remainingQty * prod.price;
        }
        return tierTotal;
      };

      let lineSubtotal = 0;
      const discountMode = prod.tier_discount_mode || 'combined';
      const colorBreakdown = item.color_breakdown && typeof item.color_breakdown === 'object' ? item.color_breakdown : null;
      const breakdownEntries = colorBreakdown
        ? Object.entries(colorBreakdown).filter(([, cQty]) => (parseInt(cQty, 10) || 0) > 0)
        : [];

      if (discountMode === 'per_color' && breakdownEntries.length > 0) {
        let sumByColor = 0;
        let remainingToAllocate = qty;
        for (const [, rawCQty] of breakdownEntries) {
          if (remainingToAllocate <= 0) break;
          const cQty = Math.min(remainingToAllocate, Math.max(0, parseInt(rawCQty, 10) || 0));
          if (cQty > 0) {
            remainingToAllocate -= cQty;
            sumByColor += calcTieredPriceForQty(cQty);
          }
        }
        if (remainingToAllocate > 0) {
          sumByColor += remainingToAllocate * prod.price;
        }
        lineSubtotal = sumByColor;
      } else {
        lineSubtotal = calcTieredPriceForQty(qty);
      }

      totalAmount += lineSubtotal;

      // Calculate deposit
      if (prod.is_preorder) {
        if (prod.deposit_amount && prod.deposit_amount > 0) {
          depositRequired += Math.min(prod.deposit_amount * qty, lineSubtotal);
        } else {
          depositRequired += lineSubtotal;
        }
      }

      if (prod.estimated_arrival_text && !arrivalNote) {
        arrivalNote = prod.estimated_arrival_text;
      }

      orderItemsData.push({
        product_id: prod.id,
        product_code_snapshot: prod.code,
        product_name_snapshot: prod.name,
        price_snapshot: unitPrice,
        quantity: qty,
        subtotal: lineSubtotal,
        customization_note: item.customization_note || null
      });
    }

    const shippingFee = delivery_method === 'shipping' ? (globalSetting?.shop_shipping_fee ?? 60) : 0;
    const grandTotal = totalAmount + shippingFee;
    const finalDeposit = Math.min(depositRequired, grandTotal);

    const taipeiDateCompact = toTaipeiDateString(now).replace(/-/g, '');

    // Execute in transaction
    let allocatedPoolRow = null;
    const order = await prisma.$transaction(async (tx) => {
      // 台北日期流水號 PO-YYYYMMDD-NNNN（於交易內取得）
      const seq = await getNextDailySeq(tx, 'shop_order', now);
      const orderRef = `PO-${taipeiDateCompact}-${String(seq).padStart(4, '0')}`;

      let assignedPoolAccount = null;
      let assignedPoolUrl = null;

      // 防洗單機制：若選擇專屬帳號池 (POOL_ACCOUNT)，在交易內鎖定檢查上限並取帳號
      if (paymentMethod.method_type === 'POOL_ACCOUNT') {
        const allocated = await assignPoolAccount(tx, {
          userId,
          orderRef,
          paymentMethodCode: paymentMethod.code,
          maxHolds: 2,
          checkHoldLimit: true,
          holdLimitMessage: '您目前已有 2 筆待繳納訂金並佔用專屬收款帳號的訂單／預約，請先完成現有款項之匯款與回報，或聯繫門市人員協助！'
        });

        if (!allocated) {
          const err = new Error('專屬收款帳號剛好發完了，請改選其他付款方式');
          err.isBusinessError = true;
          err.code = 'NO_POOL_ACCOUNT';
          err.status = 409;
          throw err;
        }
        assignedPoolAccount = allocated.accountNumber;
        assignedPoolUrl = allocated.paymentUrl;
        allocatedPoolRow = {
          bank_code: allocated.bankCode,
          bank_name: allocated.bankName,
          payment_url: allocated.paymentUrl
        };
      }

      const cleanLast5 = remittance_last5 ? String(remittance_last5).trim() : null;
      const initialPaymentStatus = cleanLast5 ? 'reported_pending_verify' : 'pending_payment';

      const newOrder = await tx.productOrder.create({
        data: {
          order_ref: orderRef,
          user_id: userId,
          total_amount: grandTotal,
          shipping_fee: shippingFee,
          deposit_required: finalDeposit,
          paid_amount: 0,
          balance_amount: grandTotal,
          payment_method_code,
          selected_bank_info: resolvedSelectedBankInfo,
          assigned_pool_account: assignedPoolAccount,
          assigned_pool_url: assignedPoolUrl,
          remittance_last5: cleanLast5,
          remittance_reported_at: cleanLast5 ? now : null,
          payment_deadline: paymentDeadline,
          auto_expire: true,
          payment_status: initialPaymentStatus,
          order_status: 'preorder_placed',
          delivery_method,
          shipping_info_json: shipping_info || null,
          estimated_arrival: arrivalNote,
          wish_note: wish_note ? String(wish_note).trim() : null,
          customer_note: customer_note ? String(customer_note).trim() : null,
          items: {
            create: orderItemsData
          }
        },
        include: {
          items: true
        }
      });

      return newOrder;
    });

    const sanitizedOrder = {
      ...order,
      payment_info: buildOrderPaymentInfo({
        order,
        method: paymentMethod,
        poolRow: allocatedPoolRow
      })
    };
    delete sanitizedOrder.admin_note;

    res.json({
      message: '預購訂單建立成功！',
      order: sanitizedOrder
    });
  } catch (error) {
    if (error.isBusinessError) {
      return res.status(error.status || 400).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {})
      });
    }
    console.error('createProductOrder error:', error);
    return res.status(500).json({ error: '建立訂單失敗，請稍後再試' });
  }
};

async function updateRemittanceLast5Core(req, res, { actor }) {
  const { id } = req.params;
  const userId = req.user?.id;
  const { remittance_last5 } = req.body;
  const isAdmin = actor === 'admin';

  if (!remittance_last5 || !String(remittance_last5).trim()) {
    return res.status(400).json({ error: '請輸入匯款末五碼' });
  }

  try {
    const order = await prisma.productOrder.findUnique({
      where: { id: parseInt(id, 10) }
    });

    if (!order) {
      return res.status(404).json({ error: '找不到該筆預購訂單' });
    }

    if (!isAdmin && order.user_id !== userId) {
      return res.status(403).json({ error: '無權限修改此訂單' });
    }

    if (!isAdmin && order.order_status === 'cancelled') {
      return res.status(409).json({ error: '這張訂單已取消' });
    }

    if (!isAdmin && !['pending_payment', 'reported_pending_verify'].includes(order.payment_status)) {
      return res.status(409).json({ error: '已核對的訂單不能修改末五碼' });
    }

    const cleanLast5 = String(remittance_last5).trim();
    if (!isAdmin && !/^\d{5}$/.test(cleanLast5)) {
      return res.status(400).json({ error: '匯款末五碼須為 5 位數字' });
    }
    const updated = await prisma.productOrder.update({
      where: { id: order.id },
      data: {
        remittance_last5: cleanLast5,
        remittance_reported_at: new Date(),
        payment_status: order.payment_status === 'pending_payment' ? 'reported_pending_verify' : order.payment_status
      }
    });

    if (isAdmin) {
      await auditService.log(prisma, {
        booking_ref: order.order_ref,
        event_type: 'shop_remittance_updated',
        category: 'shop',
        summary: `後台更新商城訂單 ${order.order_ref} 匯款末五碼`,
        before_json: { remittance_last5: order.remittance_last5, payment_status: order.payment_status },
        after_json: { remittance_last5: updated.remittance_last5, payment_status: updated.payment_status },
        staff_name: req.user?.name || '店員',
        staff_id: req.user?.id || null
      });
    }

    const sanitizedUpdated = { ...updated };
    if (!isAdmin) {
      delete sanitizedUpdated.admin_note;
    }

    res.json({ message: '匯款末五碼已成功回填！門市人員將於確認入帳後更新狀態。', order: sanitizedUpdated });
  } catch (error) {
    console.error('updateRemittanceLast5 error:', error);
    res.status(500).json({ error: '回報末五碼失敗' });
  }
}

export const updateRemittanceLast5 = (req, res) => updateRemittanceLast5Core(req, res, { actor: 'customer' });
export const adminUpdateRemittanceLast5 = (req, res) => updateRemittanceLast5Core(req, res, { actor: 'admin' });

/**
 * Customer: Get my preorder orders
 */
export const getMyProductOrders = async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: '尚未登入' });
  }

  try {
    const orders = await prisma.productOrder.findMany({
      where: { user_id: userId },
      include: {
        items: {
          include: {
            product: {
              select: { image_url: true, images_json: true, category: true, allow_wish_input: true }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    const poolAccountNumbers = [
      ...new Set(orders.map((o) => o.assigned_pool_account).filter(Boolean))
    ];
    const [allMethods, poolRows] = await Promise.all([
      prisma.paymentMethodConfig.findMany({ orderBy: [{ sort_order: 'asc' }, { id: 'asc' }] }),
      poolAccountNumbers.length > 0
        ? prisma.oneTimeAccountPool.findMany({
            where: { account_number: { in: poolAccountNumbers } },
            select: { account_number: true, bank_code: true, bank_name: true, payment_url: true }
          })
        : []
    ]);
    const methodByCode = new Map(allMethods.map((m) => [m.code, m]));
    const poolByAccount = new Map(poolRows.map((p) => [p.account_number, p]));

    const sanitizedOrders = orders.map(ord => {
      const copy = {
        ...ord,
        payment_info: buildOrderPaymentInfo({
          order: ord,
          method: methodByCode.get(ord.payment_method_code) || null,
          poolRow: ord.assigned_pool_account ? poolByAccount.get(ord.assigned_pool_account) || null : null
        })
      };
      delete copy.admin_note;
      return copy;
    });

    res.json(sanitizedOrders);
  } catch (error) {
    console.error('getMyProductOrders error:', error);
    res.status(500).json({ error: '獲取預購訂單失敗' });
  }
};

/**
 * Admin: Get all preorder orders with filtering & search
 */
export const getAdminProductOrders = async (req, res) => {
  const { search, payment_status, order_status, overdue, page = 1, limit = 30 } = req.query;

  try {
    const now = new Date();
    const andConditions = [];

    if (payment_status && payment_status !== 'all') {
      andConditions.push({ payment_status });
    }
    if (order_status && order_status !== 'all') {
      andConditions.push({ order_status });
    }
    if (overdue === '1' || overdue === 'true') {
      andConditions.push({
        order_status: { not: 'cancelled' },
        payment_status: { in: ['pending_payment', 'reported_pending_verify'] },
        payment_deadline: { lt: now }
      });
    }

    if (search && search.trim()) {
      const q = search.trim();
      andConditions.push({
        OR: [
          { order_ref: { contains: q, mode: 'insensitive' } },
          { assigned_pool_account: { contains: q, mode: 'insensitive' } },
          { remittance_last5: { contains: q, mode: 'insensitive' } },
          { user: activeUserWhere({ name: { contains: q, mode: 'insensitive' } }) },
          { user: activeUserWhere({ phone: { contains: q, mode: 'insensitive' } }) }
        ]
      });
    }

    const whereClause = andConditions.length > 0 ? { AND: andConditions } : {};

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const skip = (pageNum - 1) * take;

    const [orders, totalCount] = await Promise.all([
      prisma.productOrder.findMany({
        where: whereClause,
        include: {
          items: true,
          user: {
            select: { id: true, name: true, phone: true, line_display_name: true, line_picture_url: true, line_user_id: true }
          }
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        skip,
        take
      }),
      prisma.productOrder.count({ where: whereClause })
    ]);

    const orderRefs = orders.map((o) => o.order_ref).filter(Boolean);
    const heldAccounts = orderRefs.length > 0
      ? await prisma.oneTimeAccountPool.findMany({
          where: { assigned_order_ref: { in: orderRefs }, status: 'ASSIGNED' },
          select: { assigned_order_ref: true }
        })
      : [];
    const heldOrderRefSet = new Set(heldAccounts.map((a) => a.assigned_order_ref));
    const ordersWithHold = orders.map((o) => {
      const isOverdue =
        o.order_status !== 'cancelled' &&
        ['pending_payment', 'reported_pending_verify'].includes(o.payment_status) &&
        Boolean(o.payment_deadline) &&
        new Date(o.payment_deadline) < now;
      return {
        ...o,
        has_held_pool_account: Boolean(o.assigned_pool_account) && heldOrderRefSet.has(o.order_ref),
        is_overdue: isOverdue
      };
    });

    res.json({
      orders: ordersWithHold,
      totalCount,
      page: pageNum,
      totalPages: Math.max(1, Math.ceil(totalCount / take))
    });
  } catch (error) {
    console.error('getAdminProductOrders error:', error);
    res.status(500).json({ error: '獲取預購訂單列表失敗' });
  }
};

/**
 * Admin: Verify payment (✅ 對帳確認按鈕)
 */
export const verifyOrderPayment = async (req, res) => {
  const { id } = req.params;
  const {
    amount,
    paid_amount,
    method = 'transfer',
    cash_received,
    client_batch_id,
    is_full_payment = false,
    send_line_notification = true,
    note,
    no_payment_found = false
  } = req.body || {};

  try {
    if (no_payment_found === true) {
      const cleanNote = String(note || '').trim();
      if (!cleanNote) {
        return res.status(422).json({ error: '標記「查無入帳」請填寫備註說明' });
      }
      const orderId = parseInt(id, 10);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: '訂單編號格式不正確' });
      }

      const staffName = req.user?.name || '門市人員';
      const staffId = req.user?.id || null;
      const deviceInfo = getAdminDeviceInfo(req);

      const updated = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw`
          SELECT * FROM "ProductOrder" WHERE id = ${orderId} FOR UPDATE
        `;
        const order = locked?.[0];
        if (!order) {
          throw { status: 404, message: '找不到該筆訂單' };
        }
        if (order.order_status === 'cancelled' || order.order_status === 'picked_up') {
          throw { status: 409, message: '此訂單已取消或已完成取貨，不可再對帳' };
        }
        if (order.payment_status === 'fully_paid' || order.payment_status === 'refunded') {
          throw { status: 409, message: '此訂單已結清或已退款，不可標記查無入帳' };
        }
        if ((order.paid_amount || 0) > 0) {
          throw { status: 409, message: '此訂單已有實收金額，請改用取消退款或補收處理' };
        }

        const nextAdminNote = order.admin_note
          ? `${order.admin_note}｜查無入帳：${cleanNote}`
          : `查無入帳：${cleanNote}`;

        // Do NOT call markPoolAccountUsed: keep ASSIGNED pool account held on this order
        const row = await tx.productOrder.update({
          where: { id: order.id },
          data: {
            payment_status: 'verified_unpaid',
            admin_note: nextAdminNote
          },
          include: { items: true, user: true }
        });

        await auditService.log(tx, {
          booking_ref: order.order_ref,
          event_type: 'shop_payment_not_found',
          category: 'shop',
          summary: `商城訂單 ${order.order_ref} 對帳查無入帳（實收 NT$0）`,
          amount: 0,
          reason: cleanNote,
          before_json: {
            payment_status: order.payment_status,
            paid_amount: order.paid_amount
          },
          after_json: {
            payment_status: 'verified_unpaid',
            paid_amount: 0
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });

        return row;
      });

      return res.json({
        message: '已標記為「已對帳・查無入帳」（帳號仍保留，可取消後釋放）',
        order: updated,
        no_payment_found: true
      });
    }

    const rawAmount = amount !== undefined && amount !== null && amount !== ''
      ? amount
      : paid_amount;

    const { order: updated, payment, idempotent } = await applyShopOrderPayment({
      orderId: id,
      amountInput: rawAmount,
      isFullPayment: Boolean(is_full_payment),
      method: method || 'transfer',
      cashReceived: cash_received,
      clientBatchId: client_batch_id,
      staffUser: req.user,
      deviceInfo: getAdminDeviceInfo(req),
      markPoolUsed: true,
      note,
      reqBody: req.body || {},
      defaultToDeposit: true
    });

    // Optionally push LINE notification (skip on idempotent replay)
    if (!idempotent && send_line_notification && updated.user?.line_user_id) {
      try {
        await sendProductOrderDepositVerifiedNotification(updated, updated.user);
      } catch (lineErr) {
        console.warn('[shopController] Push LINE deposit verification notice failed:', lineErr.message);
      }
    }

    res.json({
      message: '款項對帳確認完成！',
      order: updated,
      payment,
      idempotent
    });
  } catch (error) {
    console.error('verifyOrderPayment error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '對帳確認失敗' });
  }
};

/**
 * Admin: Collect balance payment (收尾款)
 */
export const collectOrderBalance = async (req, res) => {
  const { id } = req.params;
  const { amount, method = 'cash', cash_received, client_batch_id, note } = req.body || {};

  try {
    const { order: updated, payment, idempotent } = await applyShopOrderPayment({
      orderId: id,
      amountInput: amount,
      isFullPayment: false,
      method: method || 'cash',
      cashReceived: cash_received,
      clientBatchId: client_batch_id,
      staffUser: req.user,
      deviceInfo: getAdminDeviceInfo(req),
      markPoolUsed: true,
      note,
      reqBody: req.body || {},
      defaultToDeposit: false
    });

    return res.json({
      message: '尾款收款完成！',
      order: updated,
      payment,
      idempotent
    });
  } catch (error) {
    console.error('collectOrderBalance error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '收尾款失敗' });
  }
};

/**
 * Admin: Edit order details (estimated arrival date, admin note, order status, wish reply)
 * STRICT REQUIREMENT: When wish_reply is updated, NEVER send LINE notification!
 */
export const updateAdminOrder = async (req, res) => {
  const { id } = req.params;
  const {
    estimated_arrival,
    admin_note,
    order_status,
    wish_reply,
    paid_amount,
    payment_status,
    reason
  } = req.body || {};

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  if (paid_amount !== undefined) {
    return res.status(422).json({ error: '已付金額請用收款或退款' });
  }

  try {
    const order = await prisma.productOrder.findUnique({
      where: { id: parseInt(id, 10) },
      include: { items: true, user: true }
    });

    if (!order) {
      return res.status(404).json({ error: '找不到該筆訂單' });
    }

    if (order_status === 'cancelled') {
      return res.status(409).json({ error: '請改用取消訂單並退款操作' });
    }

    if (payment_status !== undefined && payment_status !== order.payment_status) {
      return res.status(409).json({ error: '付款狀態不可直接修改，請透過收款或取消訂單並退款更新' });
    }

    if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
      if ((order.balance_amount || 0) > 0) {
        return res.status(409).json({ error: `還有尾款 NT$${order.balance_amount}，請先收尾款` });
      }
    }

    const dataToUpdate = {};
    if (estimated_arrival !== undefined) dataToUpdate.estimated_arrival = estimated_arrival;
    if (admin_note !== undefined) dataToUpdate.admin_note = admin_note;
    if (wish_reply !== undefined) dataToUpdate.wish_reply = wish_reply;
    if (order_status !== undefined) dataToUpdate.order_status = order_status;

    // If order transitioned to picked_up
    if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
      dataToUpdate.picked_up_at = new Date();
    }

    const beforeSnapshot = {
      estimated_arrival: order.estimated_arrival ?? null,
      admin_note: order.admin_note ?? null,
      wish_reply: order.wish_reply ?? null,
      order_status: order.order_status
    };

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.productOrder.update({
        where: { id: order.id },
        data: dataToUpdate,
        include: { items: true, user: true }
      });

      const { beforeChanged, afterChanged, changedKeys } = diffFields(beforeSnapshot, {
        estimated_arrival: row.estimated_arrival ?? null,
        admin_note: row.admin_note ?? null,
        wish_reply: row.wish_reply ?? null,
        order_status: row.order_status
      });
      if (changedKeys.length > 0) {
        await auditService.log(tx, {
          booking_ref: order.order_ref,
          event_type: 'shop_order_updated',
          category: 'shop',
          target_type: 'product_order',
          target_ref: order.order_ref,
          summary: `修改商城訂單 ${order.order_ref}（${changedKeys.join('、')}）`,
          reason: reason ? String(reason).trim() : null,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      // If picked up AND fully_paid, check if any items grant bonus pass plans
      if (order_status === 'picked_up' && order.order_status !== 'picked_up' && order.payment_status === 'fully_paid') {
        for (const item of order.items) {
          if (item.product_id) {
            const prod = await tx.product.findUnique({ where: { id: item.product_id } });
            if (prod?.bonus_pass_plan_code) {
              const plan = await tx.passPlan.findUnique({ where: { code: prod.bonus_pass_plan_code } });
              if (plan) {
                const existingPass = await tx.userPass.findFirst({
                  where: {
                    order_ref: order.order_ref,
                    plan_id: plan.id
                  }
                });

                if (!existingPass) {
                  const qty = item.quantity || 1;
                  const totalQuota = plan.total_quota != null ? plan.total_quota * qty : null;
                  const passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;

                  const createdPass = await tx.userPass.create({
                    data: {
                      pass_code: passCode,
                      user_id: order.user_id,
                      plan_id: plan.id,
                      plan_name_snapshot: plan.name,
                      pass_type: plan.pass_type,
                      remaining_quota: totalQuota,
                      total_quota: totalQuota,
                      day_restriction: plan.day_restriction,
                      payment_status: 'active',
                      order_ref: order.order_ref,
                      status: 'ACTIVE'
                    }
                  });

                  await auditService.log(tx, {
                    booking_ref: order.order_ref,
                    event_type: 'pass_granted',
                    category: 'pass',
                    summary: `商城取貨發放贈品券「${plan.name}」(${passCode})`,
                    reason: `商城贈品 單號 ${order.order_ref}`,
                    after_json: {
                      pass_id: createdPass.id,
                      pass_code: passCode,
                      plan_code: plan.code,
                      order_ref: order.order_ref
                    },
                    staff_name: staffName,
                    staff_id: staffId,
                    device_id: deviceInfo.device_id,
                    device_label: deviceInfo.device_label
                  });
                }
              }
            }
          }
        }
      }

      return row;
    });

    res.json({ message: '訂單資訊已更新', order: updated });
  } catch (error) {
    console.error('updateAdminOrder error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '更新訂單失敗' });
  }
};

/**
 * Admin: Cancel order with explicit refund validation & audit log
 */
export const cancelAdminOrder = async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const { refund_amount, refund_method = 'cash', reason = '' } = req.body || {};
  const cleanReason = String(reason || '').trim();
  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT * FROM "ProductOrder" WHERE id = ${orderId} FOR UPDATE
      `;
      const order = locked?.[0];
      if (!order) {
        throw { status: 404, message: '找不到該筆訂單' };
      }
      if (order.order_status === 'cancelled') {
        throw { status: 409, message: '此訂單已取消' };
      }
      if (order.order_status === 'picked_up') {
        throw { status: 409, message: '已取貨完成的訂單不可取消' };
      }
      if (order.payment_status === 'reported_pending_verify') {
        throw { status: 409, message: '請先對帳確認實收金額' };
      }

      const paidAmt = order.paid_amount || 0;
      let effectiveRefundAmt = 0;

      if (paidAmt > 0) {
        if (refund_amount === undefined || refund_amount === null || refund_amount === '') {
          throw { status: 422, message: '此訂單已有收款，請填寫退款金額' };
        }
        const parsedRefund = Number(refund_amount);
        if (!Number.isInteger(parsedRefund) || parsedRefund < 0 || parsedRefund > paidAmt) {
          throw { status: 422, message: `退款金額須為 0 到 ${paidAmt} 之間的整數` };
        }
        if (parsedRefund < paidAmt && !cleanReason) {
          throw { status: 422, message: '部分退款或不退款請填寫原因' };
        }
        effectiveRefundAmt = parsedRefund;

        if (effectiveRefundAmt > 0) {
          await refundShopOrder(tx, {
            order,
            amount: effectiveRefundAmt,
            method: refund_method,
            reason: cleanReason || '商城取消訂單全額退款',
            staffName,
            staffId,
            deviceInfo,
            reqBody: req.body
          });
        }
      }

      // 僅待付款（pending_payment）才在取消時自動釋放帳號池
      if (order.assigned_pool_account && order.payment_status === 'pending_payment') {
        await releasePoolAccount(tx, {
          accountNumber: order.assigned_pool_account,
          orderRef: order.order_ref
        });
      }

      const updateData = { order_status: 'cancelled' };
      if (paidAmt > 0 && effectiveRefundAmt === paidAmt) {
        updateData.payment_status = 'refunded';
      }

      const cancelledOrder = await tx.productOrder.update({
        where: { id: order.id },
        data: updateData,
        include: { items: true, user: true }
      });

      await auditService.log(tx, {
        booking_ref: order.order_ref,
        event_type: 'shop_order_cancelled',
        category: 'shop',
        summary:
          paidAmt > 0
            ? `取消商城訂單 ${order.order_ref}（原已付 NT$${paidAmt}，退款 NT$${effectiveRefundAmt}）`
            : `取消商城訂單 ${order.order_ref}`,
        reason: cleanReason || (paidAmt > 0 && effectiveRefundAmt === paidAmt ? '商城取消訂單全額退款' : '取消訂單'),
        before_json: {
          order_status: order.order_status,
          payment_status: order.payment_status,
          paid_amount: paidAmt
        },
        after_json: {
          order_status: cancelledOrder.order_status,
          payment_status: cancelledOrder.payment_status,
          paid_amount: cancelledOrder.paid_amount,
          refund_amount: effectiveRefundAmt
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return { order: cancelledOrder, refund_amount: effectiveRefundAmt };
    });

    return res.json({
      message: result.refund_amount > 0
        ? `訂單已取消並退款 NT$${result.refund_amount}`
        : '訂單已取消',
      order: result.order
    });
  } catch (error) {
    console.error('cancelAdminOrder error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: '取消訂單失敗' });
  }
};

/**
 * Admin: Manually release held pool account from a cancelled order after verifying no incoming remittance
 */
export const releaseOrderPoolAccount = async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  const cleanNote = String(req.body?.note || '').trim();
  if (!cleanNote) {
    return res.status(422).json({ error: '請填寫查帳無入帳之釋放說明' });
  }

  const staffName = req.user?.name || '管理員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const txResult = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw`
        SELECT id, order_ref, order_status, payment_status, assigned_pool_account
        FROM "ProductOrder"
        WHERE id = ${orderId}
        FOR UPDATE
      `;
      const order = locked?.[0];
      if (!order) {
        return { errorStatus: 404, errorBody: { error: '找不到該筆訂單' } };
      }
      if (order.order_status !== 'cancelled') {
        return { errorStatus: 409, errorBody: { error: '僅已取消的訂單可手動釋放收款帳號' } };
      }
      if (!order.assigned_pool_account) {
        return { errorStatus: 409, errorBody: { error: '此訂單沒有綁定收款帳號' } };
      }

      const released = await releasePoolAccount(tx, {
        accountNumber: order.assigned_pool_account,
        orderRef: order.order_ref
      });
      if (!released || released.count === 0) {
        return { errorStatus: 409, errorBody: { error: '此訂單的收款帳號已釋放或已入帳' } };
      }

      const last4 = String(order.assigned_pool_account).slice(-4);
      await auditService.log(tx, {
        booking_ref: order.order_ref,
        event_type: 'pool_account_released',
        category: 'shop',
        summary: `手動釋放訂單 #${order.order_ref} 保留中帳號末四碼 ${last4}`,
        reason: cleanNote,
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return { ok: true, order_ref: order.order_ref, account_last4: last4 };
    });

    if (txResult.errorStatus) {
      return res.status(txResult.errorStatus).json(txResult.errorBody);
    }

    return res.json({
      message: `已確認無入帳並釋放帳號（末四碼 ${txResult.account_last4}）回帳號池`,
      ...txResult
    });
  } catch (error) {
    console.error('releaseOrderPoolAccount error:', error);
    return res.status(500).json({ error: '釋放收款帳號失敗' });
  }
};

/**
 * Admin: Notify order arrival via LINE (single or batch)
 */
export const notifyOrderArrival = async (req, res) => {
  const { order_ids = [] } = req.body;
  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return res.status(400).json({ error: '請提供欲通知的訂單編號陣列' });
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const orders = await prisma.productOrder.findMany({
      where: { id: { in: order_ids.map(id => parseInt(id, 10)) } },
      include: { items: true, user: true }
    });

    let successCount = 0;
    const errors = [];

    for (const order of orders) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.productOrder.update({
            where: { id: order.id },
            data: {
              order_status: 'arrived',
              arrived_notified_at: new Date()
            }
          });

          let lineSent = false;
          let sendError = null;
          if (order.user?.line_user_id) {
            try {
              await sendProductArrivalNotification(order, order.user);
              lineSent = true;
              successCount++;
            } catch (pushErr) {
              sendError = pushErr.message;
              errors.push(`單號 ${order.order_ref}: ${pushErr.message}`);
            }
          }

          await auditService.log(tx, {
            booking_ref: order.order_ref,
            event_type: 'shop_arrival_notified',
            category: 'shop',
            target_type: 'product_order',
            target_ref: order.order_ref,
            summary: `發送商城到貨通知 ${order.order_ref}${lineSent ? '（LINE 已送出）' : '（未送出 LINE）'}`,
            after_json: {
              order_ref: order.order_ref,
              order_status: 'arrived',
              has_line: Boolean(order.user?.line_user_id),
              line_sent: lineSent,
              ...(sendError ? { line_error: sendError } : {})
            },
            staff_name: staffName,
            staff_id: staffId,
            device_id: deviceInfo.device_id,
            device_label: deviceInfo.device_label
          });
        });
      } catch (err) {
        errors.push(`單號 ${order.order_ref}: ${err.message}`);
      }
    }

    res.json({
      message: `已完成到貨通知發送！成功通知 ${successCount} 筆顧客。`,
      successCount,
      errors
    });
  } catch (error) {
    console.error('notifyOrderArrival error:', error);
    res.status(500).json({ error: '發送到貨通知失敗' });
  }
};

/**
 * Admin: One-Time Account Pool Management
 */
export const getAdminAccountPool = async (req, res) => {
  try {
    const pool = await prisma.oneTimeAccountPool.findMany({
      orderBy: [{ status: 'asc' }, { id: 'desc' }]
    });

    const summary = {
      total: pool.length,
      available: pool.filter(p => p.status === 'AVAILABLE').length,
      assigned: pool.filter(p => p.status === 'ASSIGNED').length,
      used: pool.filter(p => p.status === 'USED').length,
      void: pool.filter(p => p.status === 'VOID').length
    };

    res.json({ pool, summary });
  } catch (error) {
    console.error('getAdminAccountPool error:', error);
    res.status(500).json({ error: '獲取帳號池失敗' });
  }
};

export const batchImportAccountPool = async (req, res) => {
  const { text_lines, payment_method_code = 'ctbc_pool', bank_code = '822', note = null } = req.body;
  if (!text_lines || !String(text_lines).trim()) {
    return res.status(400).json({ error: '請輸入欲匯入的帳號文字' });
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const rawLines = String(text_lines).split('\n');

    const { addedCount, skippedCount, invalid_url_lines } = await prisma.$transaction(async (tx) => {
      let added = 0;
      let skipped = 0;
      const invalidUrls = [];
      const addedLast4 = [];

      for (let i = 0; i < rawLines.length; i += 1) {
        const lineNo = i + 1;
        const line = rawLines[i].trim();
        if (!line) continue;

        // Support comma or tab separated: account,payment_url,note
        const parts = line.split(/[,\t]/).map(s => s.trim());
        const account = parts[0];
        const rawUrl = parts[1] || '';
        const customNote = parts[2] || note || null;

        if (!account) continue;

        if (rawUrl && !isSafeHttpUrl(rawUrl)) {
          skipped++;
          invalidUrls.push(lineNo);
          continue;
        }
        const url = rawUrl ? safeHttpUrl(rawUrl, null) : null;

        const existing = await tx.oneTimeAccountPool.findUnique({
          where: { account_number: account }
        });

        if (existing) {
          skipped++;
          continue;
        }

        await tx.oneTimeAccountPool.create({
          data: {
            payment_method_code,
            bank_code,
            bank_name: '中國信託（社群收款專屬帳號）',
            account_number: account,
            payment_url: url,
            note: customNote,
            status: 'AVAILABLE'
          }
        });
        added++;
        addedLast4.push(`****${String(account).slice(-4)}`);
      }

      if (added > 0) {
        await auditService.log(tx, {
          event_type: 'pool_account_imported',
          category: 'shop',
          target_type: 'account_pool',
          target_ref: payment_method_code,
          summary: `匯入 ${added} 組一次性帳號（略過 ${skipped} 組）`,
          after_json: {
            payment_method_code,
            added_count: added,
            skipped_count: skipped,
            last4_list: addedLast4
          },
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return { addedCount: added, skippedCount: skipped, invalid_url_lines: invalidUrls };
    });

    res.json({
      message: `匯入完成！成功新增 ${addedCount} 組帳號，略過 ${skippedCount} 組。`,
      addedCount,
      skippedCount,
      invalid_url_lines
    });
  } catch (error) {
    console.error('batchImportAccountPool error:', error);
    res.status(500).json({ error: '批次匯入帳號池失敗' });
  }
};

export const updateAccountPoolItem = async (req, res) => {
  const { id } = req.params;
  const { status, note, payment_url } = req.body;

  if (payment_url !== undefined && payment_url !== null) {
    if (typeof payment_url !== 'string' || (payment_url.trim() && !isSafeHttpUrl(payment_url))) {
      return res.status(422).json({ code: 'INVALID_URL', error: '網址必須以 http:// 或 https:// 開頭' });
    }
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const poolId = parseInt(id, 10);
      const before = await tx.oneTimeAccountPool.findUnique({ where: { id: poolId } });
      if (!before) {
        const err = new Error('找不到該帳號項目');
        err.status = 404;
        throw err;
      }

      const row = await tx.oneTimeAccountPool.update({
        where: { id: poolId },
        data: {
          ...(status ? { status } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(payment_url !== undefined ? { payment_url: safeHttpUrl(payment_url, null) } : {})
        }
      });

      const last4 = String(row.account_number || '').slice(-4);
      const { beforeChanged, afterChanged, changedKeys } = diffFields(
        { status: before.status, note: before.note, payment_url: before.payment_url },
        { status: row.status, note: row.note, payment_url: row.payment_url }
      );

      if (changedKeys.length > 0) {
        await auditService.log(tx, {
          event_type: 'pool_account_updated',
          category: 'shop',
          target_type: 'account_pool',
          target_ref: last4,
          summary: `修改帳號池 ****${last4}（${changedKeys.join('、')}）`,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return row;
    });
    res.json({ message: '帳號資訊已更新', item: updated });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '更新帳號失敗' });
  }
};

/**
 * Admin: Payment Methods CRUD & Settings
 */
export const getAdminPaymentMethods = async (req, res) => {
  try {
    const methods = await prisma.paymentMethodConfig.findMany({
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
    });
    const globalSetting = await prisma.globalSetting.findUnique({ where: { id: 1 } });

    res.json({
      payment_methods: methods,
      settings: {
        shop_enabled: globalSetting?.shop_enabled ?? true,
        show_shop_button: globalSetting?.show_shop_button ?? globalSetting?.shop_enabled ?? true,
        shop_deposit_deadline_days: globalSetting?.shop_deposit_deadline_days ?? 2,
        shop_default_arrival_note: globalSetting?.shop_default_arrival_note || '',
        shop_enable_shipping: !!globalSetting?.shop_enable_shipping,
        shop_shipping_fee: globalSetting?.shop_shipping_fee ?? 60,
        official_line_url: globalSetting?.official_line_url || 'https://lin.ee/vsZhRW5',
        bead_colors_json: Array.isArray(globalSetting?.bead_colors_json) ? globalSetting.bead_colors_json : []
      }
    });
  } catch (error) {
    res.status(500).json({ error: '獲取付款設定失敗' });
  }
};

export const updateAdminPaymentMethod = async (req, res) => {
  const { id } = req.params;
  const {
    name,
    is_enabled,
    display_instructions,
    bank_accounts_json,
    require_last5,
    show_line_verify_btn,
    sort_order
  } = req.body;

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const methodId = parseInt(id, 10);
      const before = await tx.paymentMethodConfig.findUnique({ where: { id: methodId } });
      if (!before) {
        const err = new Error('找不到該付款方式');
        err.status = 404;
        throw err;
      }

      const row = await tx.paymentMethodConfig.update({
        where: { id: methodId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(is_enabled !== undefined ? { is_enabled: Boolean(is_enabled) } : {}),
          ...(display_instructions !== undefined ? { display_instructions } : {}),
          ...(bank_accounts_json !== undefined ? { bank_accounts_json } : {}),
          ...(require_last5 !== undefined ? { require_last5: Boolean(require_last5) } : {}),
          ...(show_line_verify_btn !== undefined ? { show_line_verify_btn: Boolean(show_line_verify_btn) } : {}),
          ...(sort_order !== undefined ? { sort_order: parseInt(sort_order, 10) || 0 } : {})
        }
      });

      const auditKeys = ['name', 'is_enabled', 'display_instructions', 'bank_accounts_json', 'require_last5', 'show_line_verify_btn', 'sort_order'];
      const beforeAudit = {};
      const afterAudit = {};
      for (const k of auditKeys) {
        if (k === 'bank_accounts_json') {
          beforeAudit[k] = normalizeBankAccountsForAudit(before[k]);
          afterAudit[k] = normalizeBankAccountsForAudit(row[k]);
        } else {
          beforeAudit[k] = before[k] ?? null;
          afterAudit[k] = row[k] ?? null;
        }
      }
      const { beforeChanged, afterChanged, changedKeys } = diffFields(beforeAudit, afterAudit);
      if (changedKeys.length > 0) {
        await auditService.log(tx, {
          event_type: 'shop_payment_method_changed',
          category: 'setting',
          target_type: 'payment_method',
          target_ref: row.code,
          summary: `修改付款方式「${row.name}」：${changedKeys.join('、')}`,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return row;
    });

    res.json({ message: '付款方式已更新', method: updated });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '更新付款方式失敗' });
  }
};

export const updateShopGlobalSettings = async (req, res) => {
  const {
    shop_enabled,
    show_shop_button,
    shop_deposit_deadline_days,
    shop_default_arrival_note,
    shop_enable_shipping,
    shop_shipping_fee,
    official_line_url,
    bead_colors_json
  } = req.body;

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const dataToUpdate = {};
    if (shop_enabled !== undefined) dataToUpdate.shop_enabled = Boolean(shop_enabled);
    if (show_shop_button !== undefined) dataToUpdate.show_shop_button = Boolean(show_shop_button);
    if (shop_deposit_deadline_days !== undefined) {
      dataToUpdate.shop_deposit_deadline_days = Math.max(1, parseInt(shop_deposit_deadline_days, 10) || 2);
    }
    if (shop_default_arrival_note !== undefined) dataToUpdate.shop_default_arrival_note = shop_default_arrival_note;
    if (shop_enable_shipping !== undefined) dataToUpdate.shop_enable_shipping = Boolean(shop_enable_shipping);
    if (shop_shipping_fee !== undefined) dataToUpdate.shop_shipping_fee = Math.max(0, parseInt(shop_shipping_fee, 10) || 0);
    if (official_line_url !== undefined) {
      if (official_line_url !== null && (typeof official_line_url !== 'string' || (official_line_url.trim() && !isSafeHttpUrl(official_line_url)))) {
        return res.status(422).json({ code: 'INVALID_URL', error: '網址必須以 http:// 或 https:// 開頭' });
      }
      dataToUpdate.official_line_url = safeHttpUrl(official_line_url, null);
    }
    if (bead_colors_json !== undefined) dataToUpdate.bead_colors_json = Array.isArray(bead_colors_json) ? bead_colors_json : [];

    const setting = await prisma.$transaction(async (tx) => {
      const before = await tx.globalSetting.findUnique({ where: { id: 1 } });
      const row = await tx.globalSetting.upsert({
        where: { id: 1 },
        update: dataToUpdate,
        create: { id: 1, ...dataToUpdate }
      });

      const { beforeChanged, afterChanged, changedKeys } = diffFields(before || {}, dataToUpdate);
      if (changedKeys.length > 0) {
        await auditService.log(tx, {
          event_type: 'shop_setting_changed',
          category: 'setting',
          target_type: 'shop_setting',
          target_ref: '1',
          summary: `修改商城全域設定：${changedKeys.join('、')}`,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return row;
    });

    res.json({ message: '預購商城全域設定已儲存', setting: sanitizeGlobalSetting(setting) });
  } catch (error) {
    res.status(500).json({ error: '儲存設定失敗' });
  }
};

/**
 * Admin: Products CRUD
 */
export const getAdminProducts = async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
    });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: '獲取商品列表失敗' });
  }
};

export const createAdminProduct = async (req, res) => {
  const {
    code,
    name,
    category = 'bundle',
    description,
    image_url,
    images_json,
    price,
    is_preorder = true,
    deposit_amount = 600,
    estimated_arrival_text,
    allow_wish_input = false,
    wish_input_placeholder,
    bonus_pass_plan_code,
    tier_pricing,
    tier_discount_mode = 'combined',
    visibility_status = 'ACTIVE',
    sort_order = 0
  } = req.body;

  if (!code || !name || price === undefined) {
    return res.status(400).json({ error: '商品代碼、名稱與售價為必填欄位' });
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: {
          code: String(code).trim(),
          name: String(name).trim(),
          category,
          description,
          image_url: image_url || (Array.isArray(images_json) && images_json[0] ? images_json[0] : null),
          images_json: Array.isArray(images_json) ? images_json : null,
          price: parseInt(price, 10) || 0,
          is_preorder: Boolean(is_preorder),
          deposit_amount: parseInt(deposit_amount, 10) || 0,
          estimated_arrival_text,
          allow_wish_input: Boolean(allow_wish_input),
          wish_input_placeholder,
          bonus_pass_plan_code,
          tier_pricing: tier_pricing || null,
          tier_discount_mode: tier_discount_mode === 'per_color' ? 'per_color' : 'combined',
          visibility_status,
          sort_order: parseInt(sort_order, 10) || 0
        }
      });

      await auditService.log(tx, {
        event_type: 'product_created',
        category: 'shop',
        target_type: 'product',
        target_ref: row.code,
        summary: `新增商品「${row.name}」(${row.code})`,
        after_json: {
          code: row.code,
          name: row.name,
          category: row.category,
          price: row.price,
          deposit_amount: row.deposit_amount,
          visibility_status: row.visibility_status
        },
        staff_name: staffName,
        staff_id: staffId,
        device_id: deviceInfo.device_id,
        device_label: deviceInfo.device_label
      });

      return row;
    });

    res.json({ message: '商品建立成功！', product: created });
  } catch (error) {
    console.error('createAdminProduct error:', error);
    res.status(500).json({ error: error.message || '建立商品失敗' });
  }
};

export const updateAdminProduct = async (req, res) => {
  const { id } = req.params;
  const updateData = { ...req.body };
  delete updateData.id;
  delete updateData.created_at;
  delete updateData.updated_at;
  delete updateData.items;

  if (updateData.price !== undefined) updateData.price = parseInt(updateData.price, 10) || 0;
  if (updateData.deposit_amount !== undefined) updateData.deposit_amount = parseInt(updateData.deposit_amount, 10) || 0;
  if (updateData.sort_order !== undefined) updateData.sort_order = parseInt(updateData.sort_order, 10) || 0;
  if (updateData.tier_discount_mode !== undefined) {
    updateData.tier_discount_mode = updateData.tier_discount_mode === 'per_color' ? 'per_color' : 'combined';
  }
  if (Array.isArray(updateData.images_json) && updateData.images_json.length > 0 && !updateData.image_url) {
    updateData.image_url = updateData.images_json[0];
  }

  const staffName = req.user?.name || '門市人員';
  const staffId = req.user?.id || null;
  const deviceInfo = getAdminDeviceInfo(req);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const productId = parseInt(id, 10);
      const before = await tx.product.findUnique({ where: { id: productId } });
      if (!before) {
        const err = new Error('找不到該商品');
        err.status = 404;
        throw err;
      }

      const row = await tx.product.update({
        where: { id: productId },
        data: updateData
      });

      const { beforeChanged, afterChanged, changedKeys } = diffFields(before, updateData);
      if (changedKeys.length > 0) {
        await auditService.log(tx, {
          event_type: 'product_updated',
          category: 'shop',
          target_type: 'product',
          target_ref: row.code,
          summary: `修改商品「${row.name}」(${row.code})：${changedKeys.join('、')}`,
          before_json: beforeChanged,
          after_json: afterChanged,
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      return row;
    });

    res.json({ message: '商品更新成功！', product: updated });
  } catch (error) {
    console.error('updateAdminProduct error:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: '更新商品失敗' });
  }
};

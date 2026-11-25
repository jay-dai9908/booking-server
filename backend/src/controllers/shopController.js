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
    const methods = await prisma.paymentMethodConfig.findMany({
      where: { is_enabled: true },
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }]
    });

    const ctbcPoolAvailableCount = await prisma.oneTimeAccountPool.count({
      where: { payment_method_code: 'ctbc_pool', status: 'AVAILABLE' }
    });

    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 }
    });

    res.json({
      payment_methods: methods,
      ctbc_pool_available_count: ctbcPoolAvailableCount,
      deposit_deadline_days: globalSetting?.shop_deposit_deadline_days ?? 2,
      official_line_url:
        globalSetting?.official_line_url ||
        globalSetting?.line_button_url ||
        'https://lin.ee/vsZhRW5',
      line_button_url:
        globalSetting?.line_button_url ||
        globalSetting?.official_line_url ||
        'https://lin.ee/vsZhRW5',
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

    const deadlineDays = globalSetting?.shop_deposit_deadline_days ?? 2;
    const paymentDeadline = new Date(Date.now() + deadlineDays * 24 * 60 * 60 * 1000);

    // 檢查付款方式是否存在且已啟用
    const paymentMethod = await prisma.paymentMethodConfig.findUnique({
      where: { code: payment_method_code }
    });
    if (!paymentMethod || !paymentMethod.is_enabled) {
      return res.status(400).json({ error: '選擇的付款方式不存在或未啟用' });
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

    // Generate unique order_ref: PO-YYYYMMDD-XXXX
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const randomHex = crypto.randomBytes(2).toString('hex').toUpperCase();
    const orderRef = `PO-${dateStr}-${randomHex}`;

    // Execute in transaction
    const order = await prisma.$transaction(async (tx) => {
      let assignedPoolAccount = null;
      let assignedPoolUrl = null;

      // 防洗單機制：若選擇社群收款 (ctbc_pool)，在交易內鎖定狀態下檢查顧客尚未完成付款且佔用虛擬帳號的筆數上限 (商城＋半自助預約合計最多 2 筆)
      if (payment_method_code === 'ctbc_pool') {
        const allocated = await assignPoolAccount(tx, {
          userId,
          orderRef,
          paymentMethodCode: 'ctbc_pool',
          maxHolds: 2,
          checkHoldLimit: true,
          holdLimitMessage: '您目前已有 2 筆待繳納訂金並佔用專屬收款帳號的訂單／預約，請先完成現有款項之匯款與回報，或聯繫門市人員協助！'
        });

        if (allocated) {
          assignedPoolAccount = allocated.accountNumber;
          assignedPoolUrl = allocated.paymentUrl;
        }
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
          selected_bank_info,
          assigned_pool_account: assignedPoolAccount,
          assigned_pool_url: assignedPoolUrl,
          remittance_last5: cleanLast5,
          remittance_reported_at: cleanLast5 ? new Date() : null,
          payment_deadline: paymentDeadline,
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

    const sanitizedOrder = { ...order };
    delete sanitizedOrder.admin_note;

    res.json({
      message: '預購訂單建立成功！',
      order: sanitizedOrder
    });
  } catch (error) {
    if (error.isBusinessError) {
      return res.status(400).json({ error: error.message });
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

    if (!isAdmin && !['pending_payment', 'reported_pending_verify'].includes(order.payment_status)) {
      return res.status(409).json({ error: '已核對的訂單不能修改末五碼' });
    }

    const cleanLast5 = String(remittance_last5).trim();
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

    const sanitizedOrders = orders.map(ord => {
      const copy = { ...ord };
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
  const { search, payment_status, order_status, page = 1, limit = 50 } = req.query;

  try {
    const whereClause = {};

    if (payment_status && payment_status !== 'all') {
      whereClause.payment_status = payment_status;
    }
    if (order_status && order_status !== 'all') {
      whereClause.order_status = order_status;
    }

    if (search && search.trim()) {
      const q = search.trim();
      whereClause.OR = [
        { order_ref: { contains: q, mode: 'insensitive' } },
        { assigned_pool_account: { contains: q, mode: 'insensitive' } },
        { remittance_last5: { contains: q, mode: 'insensitive' } },
        { user: activeUserWhere({ name: { contains: q, mode: 'insensitive' } }) },
        { user: activeUserWhere({ phone: { contains: q, mode: 'insensitive' } }) }
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const take = Math.max(1, parseInt(limit, 10) || 50);
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
        orderBy: { created_at: 'desc' },
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
    const ordersWithHold = orders.map((o) => ({
      ...o,
      has_held_pool_account: Boolean(o.assigned_pool_account) && heldOrderRefSet.has(o.order_ref)
    }));

    res.json({
      orders: ordersWithHold,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / take)
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
    note
  } = req.body || {};

  try {
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

    if (payment_status !== undefined && payment_status !== order.payment_status) {
      if (payment_status !== 'refunded') {
        return res.status(422).json({ error: '付款狀態只可透過對帳、收款或標記已退款更新' });
      }
      if (!reason || !String(reason).trim()) {
        return res.status(422).json({ error: '標記為已退款請填寫原因' });
      }
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
    if (payment_status !== undefined) dataToUpdate.payment_status = payment_status;

    // If order transitioned to picked_up
    if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
      dataToUpdate.picked_up_at = new Date();
    }

    const updated = await prisma.$transaction(async (tx) => {
      // 僅待付款（pending_payment）才在取消時自動釋放帳號池；已回報匯款/已付款之取消維持綁定，由店員查無入帳後手動釋放
      if (order_status === 'cancelled' && order.order_status !== 'cancelled') {
        if (order.assigned_pool_account && order.payment_status === 'pending_payment') {
          await releasePoolAccount(tx, {
            accountNumber: order.assigned_pool_account,
            orderRef: order.order_ref
          });
        }
      }

      const row = await tx.productOrder.update({
        where: { id: order.id },
        data: dataToUpdate,
        include: { items: true, user: true }
      });

      if (payment_status === 'refunded' && order.payment_status !== 'refunded') {
        await auditService.log(tx, {
          booking_ref: order.order_ref,
          event_type: 'shop_refund_marked',
          category: 'payment',
          summary: `商城訂單 ${order.order_ref} 標記為已退款。原因「${String(reason).trim()}」`,
          reason: String(reason).trim(),
          staff_name: staffName,
          staff_id: staffId,
          device_id: deviceInfo.device_id,
          device_label: deviceInfo.device_label
        });
      }

      // If picked up, check if any items grant bonus pass plans (e.g. 221-color bundle grants free_ironing_5)
      if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
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

                  await tx.userPass.create({
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

  try {
    const orders = await prisma.productOrder.findMany({
      where: { id: { in: order_ids.map(id => parseInt(id, 10)) } },
      include: { items: true, user: true }
    });

    let successCount = 0;
    const errors = [];

    for (const order of orders) {
      try {
        await prisma.productOrder.update({
          where: { id: order.id },
          data: {
            order_status: 'arrived',
            arrived_notified_at: new Date()
          }
        });

        if (order.user?.line_user_id) {
          await sendProductArrivalNotification(order, order.user);
          successCount++;
        }
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

  try {
    const rawLines = String(text_lines).split('\n');

    let addedCount = 0;
    let skippedCount = 0;
    const invalid_url_lines = [];

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
        skippedCount++;
        invalid_url_lines.push(lineNo);
        continue;
      }
      const url = rawUrl ? safeHttpUrl(rawUrl, null) : null;

      const existing = await prisma.oneTimeAccountPool.findUnique({
        where: { account_number: account }
      });

      if (existing) {
        skippedCount++;
        continue;
      }

      await prisma.oneTimeAccountPool.create({
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
      addedCount++;
    }

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

  try {
    const updated = await prisma.oneTimeAccountPool.update({
      where: { id: parseInt(id, 10) },
      data: {
        ...(status ? { status } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(payment_url !== undefined ? { payment_url: safeHttpUrl(payment_url, null) } : {})
      }
    });
    res.json({ message: '帳號資訊已更新', item: updated });
  } catch (error) {
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

  try {
    const updated = await prisma.paymentMethodConfig.update({
      where: { id: parseInt(id, 10) },
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

    res.json({ message: '付款方式已更新', method: updated });
  } catch (error) {
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

    const setting = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: dataToUpdate,
      create: { id: 1, ...dataToUpdate }
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

  try {
    const created = await prisma.product.create({
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

  try {
    const updated = await prisma.product.update({
      where: { id: parseInt(id, 10) },
      data: updateData
    });

    res.json({ message: '商品更新成功！', product: updated });
  } catch (error) {
    console.error('updateAdminProduct error:', error);
    res.status(500).json({ error: '更新商品失敗' });
  }
};

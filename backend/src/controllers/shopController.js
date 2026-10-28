import crypto from 'crypto';
import prisma from '../prismaClient.js';
import {
  sendProductOrderDepositVerifiedNotification,
  sendProductArrivalNotification
} from '../utils/lineMessaging.js';

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
      where: { payment_method_code: 'ctbc_pool', status: 'AVAILABLE', is_enabled: true }
    });

    const globalSetting = await prisma.globalSetting.findUnique({
      where: { id: 1 }
    });

    res.json({
      payment_methods: methods,
      ctbc_pool_available_count: ctbcPoolAvailableCount,
      deposit_deadline_days: globalSetting?.shop_deposit_deadline_days ?? 2,
      official_line_url: globalSetting?.official_line_url || 'https://lin.ee/vsZhRW5',
      enable_shipping: !!globalSetting?.shop_enable_shipping,
      shipping_fee: globalSetting?.shop_shipping_fee ?? 60,
      default_arrival_note: globalSetting?.shop_default_arrival_note || ''
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

    const productIds = items.map(i => parseInt(i.product_id, 10)).filter(Boolean);
    const dbProducts = await prisma.product.findMany({
      where: { id: { in: productIds } }
    });
    const productMap = new Map(dbProducts.map(p => [p.id, p]));

    let totalAmount = 0;
    let depositRequired = 0;
    const orderItemsData = [];
    let arrivalNote = globalSetting?.shop_default_arrival_note || '';

    for (const item of items) {
      const pid = parseInt(item.product_id, 10);
      const prod = productMap.get(pid);
      if (!prod) {
        return res.status(400).json({ error: `找不到商品 ID: ${item.product_id}` });
      }

      const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
      let unitPrice = prod.price;

      // Handle tiered pricing if configured (e.g. 10g beads: 20 bags $280, 10 bags $150, 1 bag $16)
      let lineSubtotal = 0;
      if (Array.isArray(prod.tier_pricing) && prod.tier_pricing.length > 0) {
        const sortedTiers = [...prod.tier_pricing].sort((a, b) => (b.qty || 0) - (a.qty || 0));
        let remainingQty = qty;
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
        lineSubtotal = tierTotal;
      } else {
        lineSubtotal = unitPrice * qty;
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

      // If CTBC one-time account pool selected, pull one AVAILABLE account from pool
      if (payment_method_code === 'ctbc_pool') {
        const availablePoolAccount = await tx.oneTimeAccountPool.findFirst({
          where: {
            payment_method_code: 'ctbc_pool',
            status: 'AVAILABLE',
            is_enabled: true
          },
          orderBy: { id: 'asc' }
        });

        if (!availablePoolAccount) {
          throw new Error('目前「中信社群收款專屬一次性帳號」已全數配發完畢，請改選「一般銀行匯款」或「街口支付」完成下單！');
        }

        await tx.oneTimeAccountPool.update({
          where: { id: availablePoolAccount.id },
          data: {
            status: 'ASSIGNED',
            assigned_order_ref: orderRef,
            assigned_user_id: userId,
            assigned_at: new Date()
          }
        });
        assignedPoolAccount = availablePoolAccount.account_number;
        assignedPoolUrl = availablePoolAccount.payment_url || null;
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

    res.json({
      message: '預購訂單建立成功！',
      order
    });
  } catch (error) {
    console.error('createProductOrder error:', error);
    const statusCode = error.message?.includes('配發完畢') ? 400 : 500;
    res.status(statusCode).json({ error: error.message || '建立預購訂單失敗' });
  }
};

/**
 * Customer: Update remittance last 5 digits
 */
export const updateRemittanceLast5 = async (req, res) => {
  const { id } = req.params;
  const userId = req.user?.id;
  const { remittance_last5 } = req.body;

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

    // Only allow customer who owns the order or admin
    if (order.user_id !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: '無權限修改此訂單' });
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

    res.json({ message: '匯款末五碼已成功回填！門市人員將於確認入帳後更新狀態。', order: updated });
  } catch (error) {
    console.error('updateRemittanceLast5 error:', error);
    res.status(500).json({ error: '回報末五碼失敗' });
  }
};

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
              select: { image_url: true, category: true, allow_wish_input: true }
            }
          }
        }
      },
      orderBy: { created_at: 'desc' }
    });

    res.json(orders);
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
        { user: { name: { contains: q, mode: 'insensitive' } } },
        { user: { phone: { contains: q, mode: 'insensitive' } } }
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

    res.json({
      orders,
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
  const { paid_amount, is_full_payment = false, send_line_notification = true } = req.body;

  try {
    const order = await prisma.productOrder.findUnique({
      where: { id: parseInt(id, 10) },
      include: {
        items: true,
        user: true
      }
    });

    if (!order) {
      return res.status(404).json({ error: '找不到該筆訂單' });
    }

    const actualPaid = paid_amount !== undefined && paid_amount !== null
      ? parseInt(paid_amount, 10)
      : (is_full_payment ? order.total_amount : order.deposit_required);

    const newBalance = Math.max(0, order.total_amount - actualPaid);
    const newPaymentStatus = (is_full_payment || newBalance === 0) ? 'fully_paid' : 'deposit_verified';

    const updated = await prisma.$transaction(async (tx) => {
      // If order had assigned pool account, update OneTimeAccountPool status to USED
      if (order.assigned_pool_account) {
        await tx.oneTimeAccountPool.updateMany({
          where: { account_number: order.assigned_pool_account },
          data: {
            status: 'USED',
            verified_at: new Date()
          }
        });
      }

      return tx.productOrder.update({
        where: { id: order.id },
        data: {
          paid_amount: actualPaid,
          balance_amount: newBalance,
          payment_status: newPaymentStatus
        },
        include: {
          items: true,
          user: true
        }
      });
    });

    // Optionally push LINE notification
    if (send_line_notification && updated.user?.line_user_id) {
      try {
        await sendProductOrderDepositVerifiedNotification(updated, updated.user);
      } catch (lineErr) {
        console.warn('[shopController] Push LINE deposit verification notice failed:', lineErr.message);
      }
    }

    res.json({
      message: '款項對帳確認完成！',
      order: updated
    });
  } catch (error) {
    console.error('verifyOrderPayment error:', error);
    res.status(500).json({ error: '對帳確認失敗' });
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
    payment_status
  } = req.body;

  try {
    const order = await prisma.productOrder.findUnique({
      where: { id: parseInt(id, 10) },
      include: { items: true, user: true }
    });

    if (!order) {
      return res.status(404).json({ error: '找不到該筆訂單' });
    }

    const dataToUpdate = {};
    if (estimated_arrival !== undefined) dataToUpdate.estimated_arrival = estimated_arrival;
    if (admin_note !== undefined) dataToUpdate.admin_note = admin_note;
    if (wish_reply !== undefined) dataToUpdate.wish_reply = wish_reply;
    if (order_status !== undefined) dataToUpdate.order_status = order_status;
    if (payment_status !== undefined) dataToUpdate.payment_status = payment_status;
    if (paid_amount !== undefined) {
      const p = parseInt(paid_amount, 10) || 0;
      dataToUpdate.paid_amount = p;
      dataToUpdate.balance_amount = Math.max(0, order.total_amount - p);
    }

    // If order transitioned to picked_up
    if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
      dataToUpdate.picked_up_at = new Date();
    }

    // If order transitioned to cancelled, release any assigned pool account back to AVAILABLE
    if (order_status === 'cancelled' && order.order_status !== 'cancelled') {
      if (order.assigned_pool_account) {
        await prisma.oneTimeAccountPool.updateMany({
          where: {
            account_number: order.assigned_pool_account,
            status: 'ASSIGNED'
          },
          data: {
            status: 'AVAILABLE',
            assigned_order_ref: null,
            assigned_user_id: null,
            assigned_at: null
          }
        });
      }
    }

    const updated = await prisma.productOrder.update({
      where: { id: order.id },
      data: dataToUpdate,
      include: { items: true, user: true }
    });

    // If picked up, check if any items grant bonus pass plans (e.g. 221-color bundle grants free_ironing_5)
    if (order_status === 'picked_up' && order.order_status !== 'picked_up') {
      for (const item of order.items) {
        if (item.product_id) {
          const prod = await prisma.product.findUnique({ where: { id: item.product_id } });
          if (prod?.bonus_pass_plan_code) {
            const plan = await prisma.passPlan.findUnique({ where: { code: prod.bonus_pass_plan_code } });
            if (plan) {
              // Check if already granted for this order to prevent duplicate grants
              const existingPass = await prisma.userPass.findFirst({
                where: {
                  order_ref: order.order_ref,
                  plan_id: plan.id
                }
              });

              if (!existingPass) {
                const qty = item.quantity || 1;
                const totalQuota = plan.total_quota != null ? plan.total_quota * qty : null;
                const passCode = `PASS-${Math.floor(10000000 + Math.random() * 90000000)}`;

                await prisma.userPass.create({
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

    res.json({ message: '訂單資訊已更新', order: updated });
  } catch (error) {
    console.error('updateAdminOrder error:', error);
    res.status(500).json({ error: '更新訂單失敗' });
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
    const lines = String(text_lines)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    let addedCount = 0;
    let skippedCount = 0;

    for (const line of lines) {
      // Support comma or whitespace separated: account,payment_url,note
      const parts = line.split(/[,\t]/).map(s => s.trim());
      const account = parts[0];
      const url = parts[1] || null;
      const customNote = parts[2] || note || null;

      if (!account) continue;

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
      message: `匯入完成！成功新增 ${addedCount} 組帳號，略過重複 ${skippedCount} 組。`,
      addedCount,
      skippedCount
    });
  } catch (error) {
    console.error('batchImportAccountPool error:', error);
    res.status(500).json({ error: '批次匯入帳號池失敗' });
  }
};

export const updateAccountPoolItem = async (req, res) => {
  const { id } = req.params;
  const { status, note, payment_url } = req.body;

  try {
    const updated = await prisma.oneTimeAccountPool.update({
      where: { id: parseInt(id, 10) },
      data: {
        ...(status ? { status } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(payment_url !== undefined ? { payment_url } : {})
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
        shop_deposit_deadline_days: globalSetting?.shop_deposit_deadline_days ?? 2,
        shop_default_arrival_note: globalSetting?.shop_default_arrival_note || '',
        shop_enable_shipping: !!globalSetting?.shop_enable_shipping,
        shop_shipping_fee: globalSetting?.shop_shipping_fee ?? 60,
        official_line_url: globalSetting?.official_line_url || 'https://lin.ee/vsZhRW5'
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
    shop_deposit_deadline_days,
    shop_default_arrival_note,
    shop_enable_shipping,
    shop_shipping_fee,
    official_line_url
  } = req.body;

  try {
    const dataToUpdate = {};
    if (shop_enabled !== undefined) dataToUpdate.shop_enabled = Boolean(shop_enabled);
    if (shop_deposit_deadline_days !== undefined) {
      dataToUpdate.shop_deposit_deadline_days = Math.max(1, parseInt(shop_deposit_deadline_days, 10) || 2);
    }
    if (shop_default_arrival_note !== undefined) dataToUpdate.shop_default_arrival_note = shop_default_arrival_note;
    if (shop_enable_shipping !== undefined) dataToUpdate.shop_enable_shipping = Boolean(shop_enable_shipping);
    if (shop_shipping_fee !== undefined) dataToUpdate.shop_shipping_fee = Math.max(0, parseInt(shop_shipping_fee, 10) || 0);
    if (official_line_url !== undefined) dataToUpdate.official_line_url = official_line_url;

    const setting = await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: dataToUpdate,
      create: { id: 1, ...dataToUpdate }
    });

    res.json({ message: '預購商城全域設定已儲存', setting });
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
    price,
    is_preorder = true,
    deposit_amount = 600,
    estimated_arrival_text,
    allow_wish_input = false,
    wish_input_placeholder,
    bonus_pass_plan_code,
    tier_pricing,
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
        image_url,
        price: parseInt(price, 10) || 0,
        is_preorder: Boolean(is_preorder),
        deposit_amount: parseInt(deposit_amount, 10) || 0,
        estimated_arrival_text,
        allow_wish_input: Boolean(allow_wish_input),
        wish_input_placeholder,
        bonus_pass_plan_code,
        tier_pricing: tier_pricing || null,
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

  if (updateData.price !== undefined) updateData.price = parseInt(updateData.price, 10) || 0;
  if (updateData.deposit_amount !== undefined) updateData.deposit_amount = parseInt(updateData.deposit_amount, 10) || 0;
  if (updateData.sort_order !== undefined) updateData.sort_order = parseInt(updateData.sort_order, 10) || 0;

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

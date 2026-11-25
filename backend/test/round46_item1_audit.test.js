import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import { dateOnly, toTaipeiDateString } from '../../shared/time.js';
import {
  updateDailySetting,
  batchUpdateDailySettings
} from '../src/controllers/dailySettingController.js';
import { updateKioskSettings } from '../src/controllers/kioskSettingController.js';
import { updateGlobalEquipmentSetting } from '../src/controllers/equipmentController.js';
import {
  updateAdminPaymentMethod,
  updateShopGlobalSettings,
  createAdminProduct,
  updateAdminProduct,
  batchImportAccountPool,
  updateAccountPoolItem,
  updateAdminOrder,
  notifyOrderArrival
} from '../src/controllers/shopController.js';
import {
  createPromoCode,
  updatePromoCode,
  deletePromoCode
} from '../src/controllers/checkoutController.js';
import { redeemUserPass } from '../src/controllers/passController.js';
import { updateUser, sendLineMessageToUser } from '../src/controllers/userController.js';
import { getEventsList } from '../src/controllers/accountingController.js';

function createMockReqRes({
  body = {},
  params = {},
  query = {},
  user = { id: 9461, name: 'R46稽核店長', role: 'admin', isSuperAdmin: true, permissions: ['all'] }
} = {}) {
  const req = { body, params, query, user, headers: { 'x-device-label': '測試桌機' }, ip: '127.0.0.1' };
  let statusCode = 200;
  let bodyData = null;
  const res = {
    status(c) { statusCode = c; return res; },
    json(d) { bodyData = d; return res; },
    getStatusCode() { return statusCode; },
    getBody() { return bodyData; }
  };
  return { req, res };
}

test('Round 46 Item 1: comprehensive audit logging, masking, and target_type/target_ref filtering', async () => {
  const ts = Date.now();
  const baseMs = Date.now() + 40 * 86400000;
  const d0 = toTaipeiDateString(new Date(baseMs));
  const d1 = toTaipeiDateString(new Date(baseMs + 86400000));
  const d2 = toTaipeiDateString(new Date(baseMs + 2 * 86400000));
  const d3 = toTaipeiDateString(new Date(baseMs + 3 * 86400000));
  const testDates = [d0, d1, d2, d3].map((s) => dateOnly(s));

  const origKiosk = await prisma.kioskSetting.findUnique({ where: { id: 1 } });
  const origGlobal = await prisma.globalSetting.findUnique({ where: { id: 1 } });
  const origDaily = await prisma.dailySetting.findMany({ where: { date: { in: testDates } } });

  const createdPaymentMethodIds = [];
  const createdProductIds = [];
  const createdPoolIds = [];
  const createdOrderIds = [];
  const createdPromoIds = [];
  const createdPassIds = [];
  const createdPlanIds = [];
  const createdUserIds = [];

  try {
    // Seed base records cleanly
    await prisma.dailySetting.upsert({
      where: { date: dateOnly(d0) },
      update: { hourly_price: 120, unlimited_price: 600, allow_unlimited: true },
      create: { date: dateOnly(d0), hourly_price: 120, unlimited_price: 600, allow_unlimited: true }
    });
    for (const s of [d1, d2, d3]) {
      await prisma.dailySetting.upsert({
        where: { date: dateOnly(s) },
        update: { hourly_price: 110, unlimited_price: 550, allow_unlimited: true },
        create: { date: dateOnly(s), hourly_price: 110, unlimited_price: 550, allow_unlimited: true }
      });
    }

    // 1. Single daily setting: hourly_price 120 -> 150 on d0
    const beforeD0 = new Date();
    const rSingle = createMockReqRes({ body: { date: d0, hourly_price: 150 } });
    await updateDailySetting(rSingle.req, rSingle.res);
    assert.equal(rSingle.res.getStatusCode(), 200);

    const d0Events = await prisma.accountingEvent.findMany({
      where: {
        event_type: 'daily_setting_changed',
        target_type: 'daily_setting',
        target_ref: d0,
        created_at: { gte: beforeD0 }
      }
    });
    assert.equal(d0Events.length, 1);
    assert.equal(d0Events[0].category, 'setting');
    assert.equal(d0Events[0].staff_name, 'R46稽核店長');
    assert.equal(d0Events[0].before_json?.hourly_price, 120);
    assert.equal(d0Events[0].after_json?.hourly_price, 150);

    // 2. Batch daily setting across 3 dates -> single event listing all 3 dates
    const beforeBatch = new Date();
    const rBatch = createMockReqRes({
      body: { dates: [d1, d2, d3], hourly_price: 165 }
    });
    await batchUpdateDailySettings(rBatch.req, rBatch.res);
    assert.equal(rBatch.res.getStatusCode(), 200);

    const batchEvents = await prisma.accountingEvent.findMany({
      where: {
        event_type: 'daily_setting_changed',
        staff_id: 9461,
        created_at: { gte: beforeBatch }
      },
      orderBy: { id: 'desc' }
    });
    assert.equal(batchEvents.length, 1);
    assert.deepEqual(batchEvents[0].after_json?.dates, [d1, d2, d3]);
    assert.equal(batchEvents[0].before_json?.[d1]?.hourly_price, 110);

    // 3. KioskSetting early_minutes 30 -> 20
    await prisma.kioskSetting.upsert({
      where: { id: 1 },
      update: { early_minutes: 30, line_id: '@r46test' },
      create: { id: 1, early_minutes: 30, line_id: '@r46test' }
    });
    const beforeKiosk = new Date();
    const rKiosk = createMockReqRes({
      body: { early_minutes: 20, line_id: '@r46updated' }
    });
    await updateKioskSettings(rKiosk.req, rKiosk.res);
    assert.equal(rKiosk.res.getStatusCode(), 200);

    const kioskEvents = await prisma.accountingEvent.findMany({
      where: { event_type: 'kiosk_setting_changed', created_at: { gte: beforeKiosk } }
    });
    assert.equal(kioskEvents.length, 1);
    assert.equal(kioskEvents[0].category, 'setting');
    assert.equal(kioskEvents[0].before_json?.early_minutes, 30);
    assert.equal(kioskEvents[0].after_json?.early_minutes, 20);
    assert.equal(kioskEvents[0].after_json?.line_id, '@r46updated');

    // 4. Equipment global setting (writes to GlobalSetting)
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { allow_equipment_exceed_pax: false },
      create: { id: 1, allow_equipment_exceed_pax: false }
    });
    const beforeEquip = new Date();
    const rEquip = createMockReqRes({ body: { allow_equipment_exceed_pax: true } });
    await updateGlobalEquipmentSetting(rEquip.req, rEquip.res);
    assert.equal(rEquip.res.getStatusCode(), 200);
    const equipEvents = await prisma.accountingEvent.findMany({
      where: { event_type: 'equipment_setting_changed', created_at: { gte: beforeEquip } }
    });
    assert.equal(equipEvents.length, 1);
    assert.equal(equipEvents[0].before_json?.allow_equipment_exceed_pax, false);
    assert.equal(equipEvents[0].after_json?.allow_equipment_exceed_pax, true);

    // 5. Shop PaymentMethod bank account masked (9990000000001 -> no full string, shows 0001)
    const pm = await prisma.paymentMethodConfig.create({
      data: {
        code: `r46_bank_${ts}`,
        name: 'R46測試匯款',
        method_type: 'static_bank',
        is_enabled: true,
        bank_accounts_json: [{ bank_code: '822', bank_name: '測試銀行', account_number: '1110000000009' }]
      }
    });
    createdPaymentMethodIds.push(pm.id);

    const beforePm = new Date();
    const rPm = createMockReqRes({
      params: { id: String(pm.id) },
      body: {
        bank_accounts_json: [{ bank_code: '822', bank_name: '測試銀行', account_number: '9990000000001' }]
      }
    });
    await updateAdminPaymentMethod(rPm.req, rPm.res);
    assert.equal(rPm.res.getStatusCode(), 200);
    const pmEvents = await prisma.accountingEvent.findMany({
      where: { event_type: 'shop_payment_method_changed', target_ref: pm.code, created_at: { gte: beforePm } }
    });
    assert.equal(pmEvents.length, 1);
    const pmSerialized = JSON.stringify(pmEvents[0]);
    assert.ok(!pmSerialized.includes('9990000000001'), 'Full bank account number must never be stored in audit log');
    assert.ok(pmSerialized.includes('0001'), 'Last 4 digits must appear in audit log');

    // 6. Shop global setting + product + account pool + order + arrival
    await prisma.globalSetting.upsert({
      where: { id: 1 },
      update: { shop_shipping_fee: 60 },
      create: { id: 1, shop_shipping_fee: 60 }
    });
    const beforeShopSet = new Date();
    const rShopSet = createMockReqRes({ body: { shop_shipping_fee: 80 } });
    await updateShopGlobalSettings(rShopSet.req, rShopSet.res);
    assert.equal(rShopSet.res.getStatusCode(), 200);
    const shopSetEv = await prisma.accountingEvent.findMany({
      where: { event_type: 'shop_setting_changed', created_at: { gte: beforeShopSet } }
    });
    assert.equal(shopSetEv.length, 1);

    const rProdCreate = createMockReqRes({
      body: { code: `R46PROD-${ts}`, name: 'R46稽核商品', price: 250, deposit_amount: 100 }
    });
    await createAdminProduct(rProdCreate.req, rProdCreate.res);
    assert.equal(rProdCreate.res.getStatusCode(), 200);
    const prod = rProdCreate.res.getBody().product;
    createdProductIds.push(prod.id);

    const rProdUpd = createMockReqRes({
      params: { id: String(prod.id) },
      body: { price: 299 }
    });
    await updateAdminProduct(rProdUpd.req, rProdUpd.res);
    assert.equal(rProdUpd.res.getStatusCode(), 200);

    const rPoolImp = createMockReqRes({
      body: { text_lines: `888000000${String(ts).slice(-4)},https://example.com/pay,test`, payment_method_code: 'ctbc_pool' }
    });
    await batchImportAccountPool(rPoolImp.req, rPoolImp.res);
    assert.equal(rPoolImp.res.getStatusCode(), 200);
    const importedNum = `888000000${String(ts).slice(-4)}`;
    const poolItem = await prisma.oneTimeAccountPool.findUnique({ where: { account_number: importedNum } });
    assert.ok(poolItem);
    createdPoolIds.push(poolItem.id);
    const poolImpEv = await prisma.accountingEvent.findFirst({
      where: { event_type: 'pool_account_imported', staff_id: 9461 },
      orderBy: { id: 'desc' }
    });
    assert.ok(poolImpEv);
    assert.ok(!JSON.stringify(poolImpEv).includes(importedNum));

    const rPoolUpd = createMockReqRes({
      params: { id: String(poolItem.id) },
      body: { note: '已調整備註' }
    });
    await updateAccountPoolItem(rPoolUpd.req, rPoolUpd.res);
    assert.equal(rPoolUpd.res.getStatusCode(), 200);

    // Shop order & user setup (also reused for member/LINE tests)
    const user = await prisma.user.create({
      data: {
        line_user_id: `U_R46_TEST_${ts}`,
        name: 'R46測試會員',
        phone: '0911222333',
        is_blacklisted: false
      }
    });
    createdUserIds.push(user.id);

    const order = await prisma.productOrder.create({
      data: {
        order_ref: `SHP-R46-${ts}`,
        user_id: user.id,
        payment_method_code: pm.code,
        total_amount: 299,
        deposit_required: 100,
        balance_amount: 199,
        paid_amount: 0,
        payment_status: 'unpaid',
        order_status: 'pending_arrival',
        delivery_method: 'store'
      }
    });
    createdOrderIds.push(order.id);

    const rOrderUpd = createMockReqRes({
      params: { id: String(order.id) },
      body: { admin_note: '櫃檯留貨', wish_reply: '許願已收到' }
    });
    await updateAdminOrder(rOrderUpd.req, rOrderUpd.res);
    assert.equal(rOrderUpd.res.getStatusCode(), 200);

    const orderUpdEv = await prisma.accountingEvent.findFirst({
      where: { event_type: 'shop_order_updated', target_ref: order.order_ref },
      orderBy: { id: 'desc' }
    });
    assert.ok(orderUpdEv);
    assert.equal(orderUpdEv.after_json?.admin_note, '櫃檯留貨');
    assert.equal(orderUpdEv.after_json?.wish_reply, '許願已收到');

    // Mock global LINE push for arrival notification & direct LINE send
    const sentMessages = [];
    const prevPushFn = globalThis.__TEST_LINE_PUSH_FN__;
    globalThis.__TEST_LINE_PUSH_FN__ = async (to, messages) => {
      sentMessages.push({ to, messages });
      return { ok: true };
    };
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('api.line.me')) {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return prevFetch(url, init);
    };

    try {
      const rArrive = createMockReqRes({ body: { order_ids: [order.id] } });
      await notifyOrderArrival(rArrive.req, rArrive.res);
      assert.equal(rArrive.res.getStatusCode(), 200);
      const arriveEv = await prisma.accountingEvent.findFirst({
        where: { event_type: 'shop_arrival_notified', target_ref: order.order_ref },
        orderBy: { id: 'desc' }
      });
      assert.ok(arriveEv);
      assert.equal(arriveEv.category, 'shop');

      // 10. Direct LINE push audit
      const rLine = createMockReqRes({
        params: { id: String(user.id) },
        body: { message_type: 'text', title: '行前提醒', content: 'R46 專屬測試通知內容' }
      });
      await sendLineMessageToUser(rLine.req, rLine.res);
      assert.equal(rLine.res.getStatusCode(), 200);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].to, user.line_user_id);

      const lineEv = await prisma.accountingEvent.findFirst({
        where: { event_type: 'line_message_sent', target_type: 'user', target_ref: String(user.id) },
        orderBy: { id: 'desc' }
      });
      assert.ok(lineEv);
      assert.equal(lineEv.category, 'line');
      assert.equal(lineEv.after_json?.content, 'R46 專屬測試通知內容');
      assert.equal(lineEv.after_json?.delivered, true);
    } finally {
      globalThis.__TEST_LINE_PUSH_FN__ = prevPushFn;
      globalThis.fetch = prevFetch;
    }

    // 7. Promo create, update, disable (delete) -> promo_created, promo_updated, promo_disabled with before_json
    const promoCodeStr = `R46PROMO${String(ts).slice(-5)}`;
    const rPromoCreate = createMockReqRes({
      body: { code: promoCodeStr, name: 'R46九折券', discount_type: 'percentage', percent_off: 10, discount_value: 0 }
    });
    await createPromoCode(rPromoCreate.req, rPromoCreate.res);
    assert.equal(rPromoCreate.res.getStatusCode(), 201);
    const promo = rPromoCreate.res.getBody();
    createdPromoIds.push(promo.id);

    const rPromoUpd = createMockReqRes({
      params: { id: String(promo.id) },
      body: { name: 'R46八五折券', percent_off: 15 }
    });
    await updatePromoCode(rPromoUpd.req, rPromoUpd.res);
    assert.equal(rPromoUpd.res.getStatusCode(), 200);

    const rPromoDel = createMockReqRes({
      params: { id: String(promo.id) }
    });
    await deletePromoCode(rPromoDel.req, rPromoDel.res);
    assert.equal(rPromoDel.res.getStatusCode(), 200);

    const promoEvents = await prisma.accountingEvent.findMany({
      where: { category: 'promo', target_type: 'promo_code', target_ref: promoCodeStr },
      orderBy: { id: 'asc' }
    });
    assert.deepEqual(
      promoEvents.map((e) => e.event_type),
      ['promo_created', 'promo_updated', 'promo_disabled']
    );
    const disabledEv = promoEvents[2];
    assert.equal(disabledEv.before_json?.discount_type, 'percentage');
    assert.equal(disabledEv.before_json?.percent_off, 15);

    // 8. Pass category filter includes pass_redeemed_manual
    const plan = await prisma.passPlan.create({
      data: {
        code: `R46PLAN_${ts}`,
        name: 'R46計時券方案',
        pass_type: 'TIME_PASS',
        total_quota: 10,
        price: 1000
      }
    });
    createdPlanIds.push(plan.id);
    const pass = await prisma.userPass.create({
      data: {
        pass_code: `PASS-R46-${String(ts).slice(-6)}`,
        user_id: user.id,
        plan_id: plan.id,
        plan_name_snapshot: plan.name,
        pass_type: 'TIME_PASS',
        total_quota: 10,
        remaining_quota: 10,
        status: 'ACTIVE'
      }
    });
    createdPassIds.push(pass.id);

    const rRedeem = createMockReqRes({
      body: { pass_code: pass.pass_code, units: 2, note: 'R46 手動核銷測試' }
    });
    await redeemUserPass(rRedeem.req, rRedeem.res);
    assert.equal(rRedeem.res.getStatusCode(), 200);

    const rPassFilter = createMockReqRes({
      query: { category: 'pass', limit: '50' }
    });
    await getEventsList(rPassFilter.req, rPassFilter.res);
    assert.equal(rPassFilter.res.getStatusCode(), 200);
    assert.ok(
      rPassFilter.res.getBody().events.some((e) => e.event_type === 'pass_redeemed_manual'),
      'pass filter must return pass_redeemed_manual'
    );

    // 9. Member update & blacklist -> unblacklist
    const rMemUpd = createMockReqRes({
      params: { id: String(user.id) },
      body: { name: 'R46更名會員', phone: '0988777666' }
    });
    await updateUser(rMemUpd.req, rMemUpd.res);
    assert.equal(rMemUpd.res.getStatusCode(), 200);

    const rBlack = createMockReqRes({
      params: { id: String(user.id) },
      body: { is_blacklisted: true }
    });
    await updateUser(rBlack.req, rBlack.res);
    assert.equal(rBlack.res.getStatusCode(), 200);

    const rUnblack = createMockReqRes({
      params: { id: String(user.id) },
      body: { is_blacklisted: false }
    });
    await updateUser(rUnblack.req, rUnblack.res);
    assert.equal(rUnblack.res.getStatusCode(), 200);

    const memEvents = await prisma.accountingEvent.findMany({
      where: { category: 'member', target_type: 'user', target_ref: String(user.id) },
      orderBy: { id: 'asc' }
    });
    assert.deepEqual(
      memEvents.map((e) => e.event_type),
      ['member_updated', 'member_blacklisted', 'member_unblacklisted']
    );
    assert.equal(memEvents[0].before_json?.name, 'R46測試會員');
    assert.equal(memEvents[0].after_json?.name, 'R46更名會員');

    // 11. GET /accounting/events?target_type=daily_setting&target_ref=d0 returns only d0 events
    const rTarget = createMockReqRes({
      query: { target_type: 'daily_setting', target_ref: d0, limit: '50' }
    });
    await getEventsList(rTarget.req, rTarget.res);
    assert.equal(rTarget.res.getStatusCode(), 200);
    const filteredList = rTarget.res.getBody().events;
    assert.ok(filteredList.length >= 1);
    assert.ok(filteredList.every((e) => e.target_type === 'daily_setting' && e.target_ref === d0));
  } finally {
    if (createdOrderIds.length > 0) {
      await prisma.productOrderItem.deleteMany({ where: { order_id: { in: createdOrderIds } } });
      await prisma.productOrder.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    if (createdPassIds.length > 0) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdPassIds } } });
    }
    if (createdPlanIds.length > 0) {
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } });
    }
    if (createdPromoIds.length > 0) {
      await prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
    }
    if (createdPoolIds.length > 0) {
      await prisma.oneTimeAccountPool.deleteMany({ where: { id: { in: createdPoolIds } } });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    }
    if (createdPaymentMethodIds.length > 0) {
      await prisma.paymentMethodConfig.deleteMany({ where: { id: { in: createdPaymentMethodIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await prisma.dailySetting.deleteMany({ where: { date: { in: testDates } } });
    for (const row of origDaily) {
      await prisma.dailySetting.create({ data: row });
    }
    if (origKiosk) {
      await prisma.kioskSetting.update({
        where: { id: 1 },
        data: {
          early_minutes: origKiosk.early_minutes,
          line_id: origKiosk.line_id,
          backup_code: origKiosk.backup_code
        }
      });
    }
    if (origGlobal) {
      await prisma.globalSetting.update({
        where: { id: 1 },
        data: {
          shop_shipping_fee: origGlobal.shop_shipping_fee,
          allow_equipment_exceed_pax: origGlobal.allow_equipment_exceed_pax
        }
      });
    }
  }
});

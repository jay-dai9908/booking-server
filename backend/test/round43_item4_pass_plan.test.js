import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';
import {
  createPassPlan,
  updatePassPlan,
  getAdminPassPlans,
  grantUserPass
} from '../src/controllers/passController.js';

function createMockReqRes({
  body = {},
  params = {},
  query = {},
  user = { id: 904, name: 'R43方案測試員', role: 'admin', isSuperAdmin: true, permissions: ['all'] }
} = {}) {
  const req = { body, params, query, user, headers: {}, ip: '127.0.0.1' };
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

test('Round 43 Item 4: PassPlan schema fields, auto/manual code, validation, 404/409, UserPass isolation, and audit logs', async () => {
  const testStart = new Date();
  const createdPlanIds = [];
  const createdUserPassIds = [];
  let testUser = null;

  try {
    // 1. POST create pass plan without code -> 201 with auto-generated plan_YYYYMMDD_NNN
    const rCreate1 = createMockReqRes({
      body: {
        name: '測試十次卡',
        pass_type: 'PUNCH_CARD',
        price: 1500,
        total_quota: 10,
        unit_name: '次',
        original_value: 2000
      }
    });
    await createPassPlan(rCreate1.req, rCreate1.res);
    assert.equal(rCreate1.res.getStatusCode(), 201, `Expected 201, got ${rCreate1.res.getStatusCode()}: ${JSON.stringify(rCreate1.res.getBody())}`);
    const plan1 = rCreate1.res.getBody();
    createdPlanIds.push(plan1.id);
    assert.ok(plan1.code, 'code must be non-empty');
    assert.match(plan1.code, /^plan_\d{8}_\d{3}$/, `Expected code plan_YYYYMMDD_NNN, got ${plan1.code}`);

    // 2. GET admin pass plans -> includes unit_name & original_value
    const rList = createMockReqRes();
    await getAdminPassPlans(rList.req, rList.res);
    assert.equal(rList.res.getStatusCode(), 200);
    const listed1 = rList.res.getBody().find((p) => p.id === plan1.id);
    assert.ok(listed1, 'Created plan must appear in admin list');
    assert.equal(listed1.unit_name, '次');
    assert.equal(listed1.original_value, 2000);

    // 3. POST same name again -> 201 with distinct code
    const rCreate2 = createMockReqRes({
      body: {
        name: '測試十次卡',
        pass_type: 'PUNCH_CARD',
        price: 1500,
        total_quota: 10,
        unit_name: '次',
        original_value: 2000
      }
    });
    await createPassPlan(rCreate2.req, rCreate2.res);
    assert.equal(rCreate2.res.getStatusCode(), 201);
    const plan2 = rCreate2.res.getBody();
    createdPlanIds.push(plan2.id);
    assert.notEqual(plan2.code, plan1.code, 'Second plan with same name must get distinct code');

    // 4. PUT { price: 1800, unit_name: '小時' } -> 200 and persisted
    const rUpdate1 = createMockReqRes({
      params: { id: String(plan1.id) },
      body: { price: 1800, unit_name: '小時' }
    });
    await updatePassPlan(rUpdate1.req, rUpdate1.res);
    assert.equal(rUpdate1.res.getStatusCode(), 200);

    const rListAfterUpdate = createMockReqRes();
    await getAdminPassPlans(rListAfterUpdate.req, rListAfterUpdate.res);
    const reloaded1 = rListAfterUpdate.res.getBody().find((p) => p.id === plan1.id);
    assert.equal(reloaded1.price, 1800);
    assert.equal(reloaded1.unit_name, '小時');

    // 5. PUT non-existent id -> 404
    const rMissing = createMockReqRes({
      params: { id: '99999999' },
      body: { price: 1000 }
    });
    await updatePassPlan(rMissing.req, rMissing.res);
    assert.equal(rMissing.res.getStatusCode(), 404);

    // 6. Validation errors -> 422 & duplicate code -> 409
    const rBadType = createMockReqRes({
      body: { name: '錯誤類型', pass_type: 'X', price: 100, total_quota: 1 }
    });
    await createPassPlan(rBadType.req, rBadType.res);
    assert.equal(rBadType.res.getStatusCode(), 422);

    const rZeroQuota = createMockReqRes({
      body: { name: '零次數卡', pass_type: 'PUNCH_CARD', price: 100, total_quota: 0 }
    });
    await createPassPlan(rZeroQuota.req, rZeroQuota.res);
    assert.equal(rZeroQuota.res.getStatusCode(), 422);

    const rBadUnit = createMockReqRes({
      body: { name: '單位太長', pass_type: 'PUNCH_CARD', price: 100, total_quota: 1, unit_name: '12345' }
    });
    await createPassPlan(rBadUnit.req, rBadUnit.res);
    assert.equal(rBadUnit.res.getStatusCode(), 422);

    const rFixedMissingVal = createMockReqRes({
      body: { name: '固定折抵缺值', pass_type: 'DISCOUNT_VOUCHER', price: 100, total_quota: 1, checkout_effect: 'fixed_amount' }
    });
    await createPassPlan(rFixedMissingVal.req, rFixedMissingVal.res);
    assert.equal(rFixedMissingVal.res.getStatusCode(), 422);

    const rDupCode = createMockReqRes({
      body: { code: plan1.code, name: '重複代碼', pass_type: 'PUNCH_CARD', price: 100, total_quota: 1 }
    });
    await createPassPlan(rDupCode.req, rDupCode.res);
    assert.equal(rDupCode.res.getStatusCode(), 409);

    // 7. Grant UserPass from plan1 (10 times), then update plan1 total_quota to 12 -> UserPass still has 10
    testUser = await prisma.user.create({
      data: {
        line_user_id: `test_r43_item4_${Date.now()}`,
        name: 'R43卡券測試會員',
        phone: '0987654399'
      }
    });

    const rGrant = createMockReqRes({
      body: {
        user_id: testUser.id,
        plan_id: plan1.id,
        mode: 'gift',
        reason: 'R43測試發放'
      }
    });
    await grantUserPass(rGrant.req, rGrant.res);
    assert.equal(rGrant.res.getStatusCode(), 200);
    const issuedPass = rGrant.res.getBody().pass;
    createdUserPassIds.push(issuedPass.id);
    assert.equal(issuedPass.remaining_quota, 10);

    const rUpdateQuota = createMockReqRes({
      params: { id: String(plan1.id) },
      body: { total_quota: 12 }
    });
    await updatePassPlan(rUpdateQuota.req, rUpdateQuota.res);
    assert.equal(rUpdateQuota.res.getStatusCode(), 200);

    const passAfterUpdate = await prisma.userPass.findUnique({ where: { id: issuedPass.id } });
    assert.equal(passAfterUpdate.remaining_quota, 10, 'Updating plan total_quota must not modify already-issued UserPass');

    // 8. Check AccountingEvent logs for plan1
    const events = await prisma.accountingEvent.findMany({
      where: {
        category: 'pass',
        created_at: { gte: testStart },
        event_type: { in: ['pass_plan_created', 'pass_plan_updated'] }
      },
      orderBy: { id: 'asc' }
    });
    const plan1Creates = events.filter((e) => e.event_type === 'pass_plan_created' && e.after_json?.id === plan1.id);
    const plan1Updates = events.filter((e) => e.event_type === 'pass_plan_updated' && e.after_json?.price === 1800);
    assert.equal(plan1Creates.length, 1);
    assert.equal(plan1Creates[0].staff_name, 'R43方案測試員');
    assert.equal(plan1Updates.length, 1);
    assert.deepEqual(plan1Updates[0].before_json, { price: 1500, unit_name: '次' });
    assert.deepEqual(plan1Updates[0].after_json, { price: 1800, unit_name: '小時' });
  } finally {
    if (createdUserPassIds.length > 0) {
      await prisma.userPass.deleteMany({ where: { id: { in: createdUserPassIds } } }).catch(() => {});
    }
    if (createdPlanIds.length > 0) {
      await prisma.passPlan.deleteMany({ where: { id: { in: createdPlanIds } } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }
  }
});

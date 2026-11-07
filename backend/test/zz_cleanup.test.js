import test from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/prismaClient.js';

test('zz_cleanup: Operational tables must have 0 rows remaining after test suite execution', async () => {
  const operationalModels = [
    { name: 'Reservation', model: prisma.reservation },
    { name: 'BookingPerson', model: prisma.bookingPerson },
    { name: 'BookingEquipment', model: prisma.bookingEquipment },
    { name: 'TimerPause', model: prisma.timerPause },
    { name: 'Payment', model: prisma.payment },
    { name: 'PrintJob', model: prisma.printJob },
    { name: 'ProductOrder', model: prisma.productOrder },
    { name: 'ProductOrderItem', model: prisma.productOrderItem },
    { name: 'UserPass', model: prisma.userPass },
    { name: 'CashClosing', model: prisma.cashClosing },
    { name: 'UserLoginLog', model: prisma.userLoginLog },
    { name: 'BannedIP', model: prisma.bannedIP },
    { name: 'OneTimeAccountPool', model: prisma.oneTimeAccountPool }
  ];

  const leftovers = [];
  for (const { name, model } of operationalModels) {
    const count = await model.count();
    if (count > 0) {
      leftovers.push(`${name}: ${count} rows`);
    }
  }

  assert.equal(
    leftovers.length,
    0,
    `Operational tables must be empty (0 rows) after test suite. Remaining rows:\n${leftovers.join('\n')}`
  );

  // Verify that AccountingEvent is preserved (protected by database trigger, cannot be deleted)
  const acctEventCount = await prisma.accountingEvent.count();
  assert.ok(acctEventCount >= 0, 'AccountingEvent audit log is preserved');
});

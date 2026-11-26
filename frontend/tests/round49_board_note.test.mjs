import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { boardDiscountNote } from '../src/utils/customer/discountText.js';
import { calculateEquipmentChargeableHours } from '../src/utils/equipmentPricing.js';

describe('Round 49 Item 4: boardDiscountNote reads discount config', () => {
  const defaultCfg = {
    enabled: true,
    buy_hours: 3,
    free_hours: 1,
    stackable: true,
    tier2_enabled: false,
    tier2_buy_hours: 8,
    tier2_free_hours: 4,
  };

  test('default config: 4h shows 買三送一 and 3h count; 3h returns null', () => {
    const note4 = boardDiscountNote(4, defaultCfg);
    assert.ok(note4 && note4.includes('買三送一') && note4.includes('以 3 小時計'), `got ${note4}`);
    assert.equal(boardDiscountNote(3, defaultCfg), null);
  });

  test('disabled config returns null even for 8 hours', () => {
    const offCfg = { ...defaultCfg, enabled: false, tier2_enabled: false };
    assert.equal(boardDiscountNote(8, offCfg), null);
  });

  test('tier2 enabled: chargeable hours in note matches calculateEquipmentChargeableHours', () => {
    const tier2Cfg = { ...defaultCfg, enabled: true, tier2_enabled: true };
    for (const h of [4, 5, 8, 12, 14]) {
      const expectedChargeable = calculateEquipmentChargeableHours(h, tier2Cfg);
      const note = boardDiscountNote(h, tier2Cfg);
      if (expectedChargeable < h) {
        assert.ok(note && note.includes(`以 ${expectedChargeable} 小時計`), `h=${h} -> ${note}`);
      } else {
        assert.equal(note, null);
      }
    }
  });
});

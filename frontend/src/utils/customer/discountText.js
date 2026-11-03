import { cnNum } from './format.js';
import { calculateEquipmentChargeableHours } from '../equipmentPricing.js';
export { buildDiscountConfig } from './pricing.js';

export function boardDiscountTexts(cfg) {
  const t1 = Boolean(cfg && cfg.enabled);
  const t2 = Boolean(cfg && cfg.tier2_enabled);
  if (!t1 && !t2) return null;

  const b1 = cfg.buy_hours, f1 = cfg.free_hours;
  const b2 = cfg.tier2_buy_hours, f2 = cfg.tier2_free_hours;

  const deal1 = t1 ? `買${cnNum(b1)}送${cnNum(f1)}` : '';
  const deal2 = t2 ? `買${cnNum(b2)}送${cnNum(f2)}` : '';

  const dealList = [t1 && deal1, t2 && deal2].filter(Boolean);
  const deals = dealList.join('、');

  let rule = '';
  if (t1 && t2) {
    rule = `租滿 ${b1 + f1} 小時自動折抵 ${f1} 小時（${deal1}）；租滿 ${b2 + f2} 小時折抵 ${f2} 小時`;
  } else if (t1) {
    rule = `租滿 ${b1 + f1} 小時自動折抵 ${f1} 小時（${deal1}）`;
  } else {
    rule = `租滿 ${b2 + f2} 小時自動折抵 ${f2} 小時（${deal2}）`;
  }
  if (!cfg.stackable) rule += '（每台限折一次）';

  const only1 = { ...cfg, tier2_enabled: false };
  const only2 = { ...cfg, enabled: false };

  return {
    deal: deals,
    deals,
    home: `租借時段${deals}`,
    rule,
    lineLabel: (hours, freeHours) => {
      const dealText1 = `買${cnNum(cfg.buy_hours)}送${cnNum(cfg.free_hours)}`;
      const dealText2 = `買${cnNum(cfg.tier2_buy_hours)}送${cnNum(cfg.tier2_free_hours)}`;
      const both = calculateEquipmentChargeableHours(hours, cfg);
      const c1 = cfg.enabled ? calculateEquipmentChargeableHours(hours, only1) : Infinity;
      const c2 = cfg.tier2_enabled ? calculateEquipmentChargeableHours(hours, only2) : Infinity;
      let name;
      if (c1 === both) name = dealText1;
      else if (c2 === both) name = dealText2;
      else name = `${dealText1}＋${dealText2}`;
      return `智能板${name}（折抵 ${freeHours} 小時）`;
    },
  };
}

import { cnNum } from './format.js';

export function boardDiscountTexts(cfg) {
  if (!cfg || !cfg.enabled) return null;
  const b = cfg.buy_hours, f = cfg.free_hours;
  const deal = `買${cnNum(b)}送${cnNum(f)}`;
  let rule = `租滿 ${b + f} 小時自動折抵 ${f} 小時（${deal}）`;
  if (cfg.tier2_enabled) {
    rule += `；租滿 ${cfg.tier2_buy_hours + cfg.tier2_free_hours} 小時折抵 ${cfg.tier2_free_hours} 小時`;
  }
  if (!cfg.stackable) rule += '（每台限折一次）';
  return {
    deal,
    home: `租借時段${deal}`,
    rule,
    lineLabel: (freeHours) => cfg.tier2_enabled
      ? `智能板時數優惠（折抵 ${freeHours} 小時）`
      : `智能板${deal}（折抵 ${freeHours} 小時）`,
  };
}

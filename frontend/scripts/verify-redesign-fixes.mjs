import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseYMD,
  groupUnits,
  buildPriceLines,
  shortBoardName,
  getDayPricing,
  buildDiscountConfig,
} from '../src/utils/customer/pricing.js';
import {
  formatDateShort,
  formatDateFull,
  formatMoney,
  weekdayChar,
} from '../src/utils/customer/format.js';

console.log('--- 1. Testing date parsing with ISO strings and Date instances ---');
const isoDateStr = '2026-11-05T00:00:00.000Z';
const parsedIso = parseYMD(isoDateStr);
assert.strictEqual(parsedIso.getFullYear(), 2026);
assert.strictEqual(parsedIso.getMonth(), 10);
assert.strictEqual(parsedIso.getDate(), 5);
console.log('✓ parseYMD with ISO string passed');

const dObj = new Date(2026, 10, 5);
assert.strictEqual(parseYMD(dObj).getDate(), 5);
console.log('✓ parseYMD with Date object passed');

const shortDate = formatDateShort(isoDateStr);
assert.strictEqual(shortDate, '11/05 週四');
console.log('✓ formatDateShort with ISO string passed');

console.log('\n--- 2. Testing groupUnits and boundary resolvers ---');
const bookingSessions = [
  { id: 1, start_time: '12:00', end_time: '13:00' },
  { id: 2, start_time: '13:00', end_time: '14:00' },
  { id: 3, start_time: '14:00', end_time: '15:00' },
  { id: 4, start_time: '15:00', end_time: '16:00' },
];

const units = [
  { uid: 'u1', equipment_id: 'small', from: 0, to: 3 },
  { uid: 'u2', equipment_id: 'small', from: 0, to: 3 },
  { uid: 'u3', equipment_id: 'medium', from: 1, to: 4 },
];

const groups = groupUnits(units, bookingSessions);
assert.strictEqual(groups.length, 2);
const smallGroup = groups.find((g) => g.equipment_id === 'small');
assert.strictEqual(smallGroup.qty, 2);
assert.strictEqual(smallGroup.start, '12:00');
assert.strictEqual(smallGroup.end, '15:00');
assert.strictEqual(smallGroup.hours, 3);
console.log('✓ groupUnits with bookingSessions array passed');

const configs = {
  small: { id: 'small', name: '小板 (50×50)', hourly_rate: 100, daily_cap: 300 },
  medium: { id: 'medium', name: '中板 (78×78)', hourly_rate: 120, daily_cap: 360 },
};

const discountCfg = buildDiscountConfig({
  equipment_discount_enabled: true,
  equipment_discount_buy_hours: 2,
  equipment_discount_free_hours: 1,
  equipment_discount_stackable: true,
});

const priceResult = buildPriceLines({
  pax: 2,
  hours: 4,
  startTime: '12:00',
  endTime: '16:00',
  day: { hourly: 100, cap: 550, allowUnlimited: true, dayType: 'weekday' },
  mode: 'timed',
  units,
  configs,
  discountCfg,
  bookingSessions,
});

assert.strictEqual(priceResult.lines.length > 0, true);
console.log('✓ buildPriceLines with bookingSessions resolved passed');

console.log('\n--- 3. Verifying Spec text rules and forbidden copy across customer tree ---');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const customerDir = path.resolve(__dirname, '../src');

const checkDirs = [
  path.join(customerDir, 'pages/Customer'),
  path.join(customerDir, 'components/customer'),
  path.join(customerDir, 'styles/customer.css'),
  path.join(customerDir, 'utils/customer'),
  path.join(customerDir, 'hooks/customer'),
];

const forbiddenPhrases = [
  '預約好了',
  '每人最多',
  '即時選位',
  '不會用來發廣告',
  '系統會自動折抵',
  '強制同步最新人數',
  '不限時預約提醒',
  '相鄰名額不足提示',
  '正在處理登入資訊',
  '拼豆時段預約系統',
];

const emojiRegex = /[\uD83C-\uDBFF\uDC00-\uDFFF\u2600-\u27BF]/;
const dialogRegex = /\b(alert|confirm|prompt)\s*\(/;
const animateSpinRegex = /\banimate-spin\b/;

let totalCheckedFiles = 0;

function scanDir(dir) {
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    checkFile(dir);
    return;
  }
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const fullPath = path.join(dir, f);
    const subStat = fs.statSync(fullPath);
    if (subStat.isDirectory()) {
      scanDir(fullPath);
    } else if (f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.css')) {
      checkFile(fullPath);
    }
  }
}

function checkFile(filePath) {
  totalCheckedFiles++;
  const content = fs.readFileSync(filePath, 'utf-8');

  // Check forbidden phrases
  for (const phrase of forbiddenPhrases) {
    if (content.includes(phrase)) {
      throw new Error(`Forbidden phrase "${phrase}" found in ${filePath}`);
    }
  }

  // Check browser dialogs
  const dialogMatch = content.match(dialogRegex);
  if (dialogMatch) {
    throw new Error(`Forbidden browser dialog "${dialogMatch[0]}" found in ${filePath}`);
  }

  // Check animate-spin
  if (animateSpinRegex.test(content)) {
    throw new Error(`Forbidden animate-spin found in ${filePath}`);
  }

  // Check emoji (exclude comment lines if any)
  const lines = content.split('\n');
  lines.forEach((line, lineIdx) => {
    // Ignore purely unicode comments or escapes
    if (line.includes('Extended_Pictographic')) return;
    if (emojiRegex.test(line)) {
      throw new Error(`Forbidden emoji found in ${filePath} line ${lineIdx + 1}: ${line}`);
    }
  });

  // Check single letter css classes in customer.css
  if (filePath.endsWith('customer.css')) {
    const singleLetterMatch = content.match(/\.[a-z][ ,{:.]/);
    if (singleLetterMatch) {
      throw new Error(`Forbidden single letter CSS class found in ${filePath}: ${singleLetterMatch[0]}`);
    }
  }
}

for (const d of checkDirs) {
  if (fs.existsSync(d)) {
    scanDir(d);
  }
}

console.log(`✓ Scanned ${totalCheckedFiles} customer files: 0 forbidden phrases, 0 dialogs, 0 animate-spin, 0 emojis, 0 single-letter classes.`);
console.log('\n=== ALL DEEP VERIFICATION CHECKS PASSED ===\n');

/**
 * Verify the actual Client money formatter truncates to cents instead of
 * rounding. The test harness executes client.js as the module loader would,
 * then reads its exported test API.
 *
 *   node scripts/verify-formatting.mjs
 */

import { clientTest } from './client-test-api.mjs';

const { truncateToCents, formatMoney, formatWallets } = clientTest;

const centsCases = [
  [7.155, 715],
  [7.15, 715],
  [7.16, 716],
  ['7.1550000000', 715],
  ['7.1599999999', 715],
  ['7.999', 799],
  ['0.009', 0],
  ['1,234.567', 123456],
];
for (const [value, expected] of centsCases) {
  const actual = truncateToCents(value);
  if (actual !== expected) throw new Error(`truncateToCents(${value}) = ${actual}, expected ${expected}`);
}
console.log('truncateToCents: OK');

const single = formatMoney('7.155', 'CNY', 'zh-CN');
if (single !== '¥7.15') throw new Error(`single wallet formatted as ${single}`);
console.log(`7.155 -> ${single}`);

const summed = formatWallets([
  { balance: '3.58', currency: 'CNY' },
  { balance: '3.57', currency: 'CNY' },
], 'zh-CN');
if (summed !== '¥7.15') throw new Error(`summed wallets formatted as ${summed}`);
console.log(`3.58 + 3.57 -> ${summed}`);

const mixed = formatWallets([
  { balance: '7.155', currency: 'CNY' },
  { balance: '1.00', currency: 'USD' },
], 'zh-CN');
if (mixed !== '¥7.15 · $1.00') throw new Error(`mixed currencies formatted as ${mixed}`);
console.log(`mixed currencies -> ${mixed}`);

const eur = formatMoney(1.239, 'EUR', 'en');
const hkd = formatMoney(1.239, 'HKD', 'en');
if (!String(eur).startsWith('€') || !String(hkd).startsWith('HK$')) {
  throw new Error(`unexpected currency symbols ${eur} / ${hkd}`);
}

console.log('formatting verification: OK');

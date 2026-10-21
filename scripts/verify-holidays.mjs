import { fileURLToPath } from 'node:url';
import { createHolidayService } from '../holidays.js';
import { createPricingEngine, isBeijingPeak, loadCnyPriceTable } from '../pricing.js';

const service = await createHolidayService({
  cacheDir: fileURLToPath(new URL('../.tmp-holiday-test', import.meta.url)),
});

const years = service.status.years.map((entry) => entry.year);
for (const year of [2024, 2025, 2026]) {
  if (!years.includes(year)) throw new Error(`missing fallback year ${year}`);
}
if (service.map.size < 100) throw new Error(`too few holiday days: ${service.map.size}`);

const at = (dateTime) => new Date(`${dateTime}+08:00`).getTime();
if (isBeijingPeak(at('2026-10-01T10:00:00'), service.map)) {
  throw new Error('National Day must be off-peak all day');
}
if (!isBeijingPeak(at('2026-09-20T10:00:00'), service.map)) {
  throw new Error('make-up workday Sunday must use peak windows');
}
if (isBeijingPeak(at('2026-09-20T12:00:00'), service.map)) {
  throw new Error('make-up workday lunch break must be off-peak');
}
if (!isBeijingPeak(at('2026-10-19T10:00:00'), service.map)) {
  throw new Error('ordinary Monday morning must be peak');
}
if (isBeijingPeak(at('2026-10-18T10:00:00'), service.map)) {
  throw new Error('ordinary Sunday must be off-peak');
}

const priceTable = await loadCnyPriceTable();
const engine = await createPricingEngine({ priceTable, holidayMap: service.map });
const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const holidayCost = engine.costCnyForUsage(usage, { provider: 'deepseek', model: 'deepseek-flash' }, at('2026-10-01T10:00:00'));
const makeupCost = engine.costCnyForUsage(usage, { provider: 'deepseek', model: 'deepseek-flash' }, at('2026-09-20T10:00:00'));
if (Math.abs(holidayCost - 1) > 1e-9) throw new Error(`holiday should use off-peak input price, got ${holidayCost}`);
if (Math.abs(makeupCost - 2) > 1e-9) throw new Error(`make-up workday should use peak input price, got ${makeupCost}`);

console.log(`holiday years: ${service.status.years.map((entry) => `${entry.year}:${entry.source}:${entry.days}`).join(', ')}`);
console.log(`holiday map: ${service.map.size} days`);
console.log(`engine prices: holiday=¥${holidayCost}, make-up=¥${makeupCost}`);
console.log('holiday verification: OK');

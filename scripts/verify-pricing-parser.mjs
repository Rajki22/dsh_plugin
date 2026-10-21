import fs from 'node:fs';
import { parseOfficialPricingHtml } from '../pricing-source.js';

const html = fs.readFileSync(new URL('./fixtures/pricing-page.html', import.meta.url), 'utf8');
const table = parseOfficialPricingHtml(html);
const flash = table.models['deepseek-flash'];
const pro = table.models['deepseek-v4-pro'];
if (!flash || !pro) throw new Error('expected both models');
if (flash.peak.cacheRead !== 0.04 || flash.peak.input !== 2 || flash.peak.output !== 8) {
  throw new Error(`unexpected flash peak ${JSON.stringify(flash.peak)}`);
}
if (flash.offPeak.cacheRead !== 0.02 || flash.offPeak.input !== 1 || flash.offPeak.output !== 4) {
  throw new Error(`unexpected flash off-peak ${JSON.stringify(flash.offPeak)}`);
}
if (pro.peak.cacheRead !== 0.3 || pro.peak.input !== 9 || pro.peak.output !== 27) {
  throw new Error(`unexpected pro peak ${JSON.stringify(pro.peak)}`);
}

let failedClosed = false;
try {
  parseOfficialPricingHtml('<html><body><p>pricing moved</p></body></html>');
} catch (error) {
  failedClosed = true;
}
if (!failedClosed) throw new Error('malformed page must fail closed');

console.log('official pricing fixture verification: OK');

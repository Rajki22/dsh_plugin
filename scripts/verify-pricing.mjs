/**
 * Local pricing check for the whale widget.
 *
 * Run from the plugin package:
 *   node scripts/verify-pricing.mjs
 *
 * Prices are the official DeepSeek CNY table in pricing/deepseek.json.
 */

import { __test } from '../index.js';
import {
  createPricingEngine,
  isBeijingPeak,
  loadPriceTableForTest,
} from '../pricing.js';

const engine = await createPricingEngine();
const table = await loadPriceTableForTest();
console.log(`pricing source: ${engine.source}, currency: ${engine.currency}, models: ${engine.modelCount}`);
console.log(`price file: ${table.sourceFile}`);

const peakTime = new Date('2026-10-19T10:00:00+08:00').getTime();
const offPeakTime = new Date('2026-10-19T12:00:00+08:00').getTime();
if (!isBeijingPeak(peakTime)) throw new Error('10:00 Beijing should be peak');
if (isBeijingPeak(offPeakTime)) throw new Error('12:00 Beijing should be off-peak');
console.log('peak window check: OK');

const usage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 0,
};
const model = { provider: 'deepseek-account', model: 'deepseek-flash' };
const peakCost = engine.costCnyForUsage(usage, model, peakTime);
const offPeakCost = engine.costCnyForUsage(usage, model, offPeakTime);
console.log(`1M uncached + 1M output + 1M cache-read peak: ¥${peakCost.toFixed(4)}`);
console.log(`same usage off-peak: ¥${offPeakCost.toFixed(4)}`);
if (Math.abs(peakCost - 10.04) > 1e-9) throw new Error(`unexpected peak cost ${peakCost}`);
if (Math.abs(offPeakCost - 5.02) > 1e-9) throw new Error(`unexpected off-peak cost ${offPeakCost}`);

const userMessage = {
  type: 'user/message',
  seq: 0,
  time: peakTime,
  data: {},
};
const baseEvent = {
  type: 'request/header',
  seq: 1,
  time: peakTime,
  data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
};
const firstMessage = {
  type: 'assistant/message',
  seq: 2,
  time: peakTime,
  data: {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage,
    stream: [],
  },
};
const replacement = {
  ...firstMessage,
  seq: 3,
  time: offPeakTime,
  data: {
    ...firstMessage.data,
    usage: {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    },
  },
};
const replaced = await __test.foldColdSession([userMessage, baseEvent, firstMessage, replacement], engine, 0, false);
console.log(`replacement total: ¥${replaced.costCny.toFixed(4)}`);
if (Math.abs(replaced.costCny - 6.02) > 1e-9) {
  throw new Error(`unexpected replacement total ${replaced.costCny}`);
}

const retry = {
  type: 'llm/retry-started',
  seq: 4,
  time: offPeakTime,
  data: { turn: 1, step: 1 },
};
const retried = await __test.foldColdSession([userMessage, baseEvent, firstMessage, retry, replacement], engine, 0, false);
console.log(`retry adds a new sample: ¥${retried.costCny.toFixed(4)}`);
if (Math.abs(retried.costCny - 16.06) > 1e-9) {
  throw new Error(`retry should add, got ${retried.costCny}`);
}

const cold = await __test.foldColdSession([userMessage, baseEvent, firstMessage, replacement], engine);
console.log(`cold fold: ¥${cold.costCny.toFixed(4)}, turn=¥${cold.currentTurnCny}, seq=${cold.turnSeq}`);
if (Math.abs(cold.costCny - 6.02) > 1e-9) throw new Error(`unexpected cold cost ${cold.costCny}`);
if (Math.abs(cold.currentTurnCny - 6.02) > 1e-9) throw new Error('cold turn cost mismatch');
if (cold.turnSeq !== 0) throw new Error('cold turn sequence mismatch');
if (cold.usage.uncachedInputTokens !== 2_000_000) throw new Error('cold usage replacement failed');

// A fork's inherited prefix must not be counted again in workspace totals.
const inherited = await __test.foldColdSession([userMessage, baseEvent, firstMessage, replacement], engine, 2);
console.log(`inherited-prefix cold fold: ¥${inherited.costCny.toFixed(4)}, turn=¥${inherited.currentTurnCny}`);
if (Math.abs(inherited.costCny - 6.02) > 1e-9) throw new Error(`unexpected inherited cost ${inherited.costCny}`);
if (inherited.turnSeq !== null) throw new Error('inherited turn sequence should be null');
if (inherited.currentTurnCny !== 0) throw new Error('inherited turn cost should be zero');

// An unparsable timestamp must not silently fall back to off-peak pricing.
const invalidReplacement = {
  ...firstMessage,
  seq: 5,
  time: 'not-a-real-time',
};
const invalid = await __test.foldColdSession(
  [userMessage, baseEvent, firstMessage, invalidReplacement],
  engine,
);
console.log(`invalid timestamp: ¥${invalid.costCny.toFixed(4)}, count=${invalid.invalidTimeCount}`);
if (invalid.costCny !== 0) throw new Error(`invalid timestamp must cost zero, got ${invalid.costCny}`);
if (invalid.invalidTimeCount !== 1) throw new Error('invalid timestamp was not counted');

console.log('pricing verification: OK');

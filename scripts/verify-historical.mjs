import { createPricingEngine, isBeijingPeak, loadCnyPriceTable } from '../pricing.js';
import { toEpochMs } from '../time.js';
import { __test } from '../index.js';

const table = await loadCnyPriceTable();
const engine = await createPricingEngine({ priceTable: table });
const model = { provider: 'deepseek', model: 'deepseek-flash' };
const usage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

if (!isBeijingPeak('2026-10-19T10:00:00+08:00')) throw new Error('ISO peak was not recognized');
if (isBeijingPeak('2026-10-19T20:00:00+08:00')) throw new Error('ISO off-peak was not recognized');
if (!isBeijingPeak('2026-10-19T10:00:00')) throw new Error('naive ISO should default to Beijing time');
if (toEpochMs('2026-10-19T10:00:00+08:00') === null) throw new Error('ISO timestamp was not parsed');

const events = [
  {
    type: 'user/message',
    seq: 0,
    time: '2026-10-19T09:59:00+08:00',
    data: {},
  },
  {
    type: 'request/header',
    seq: 1,
    time: '2026-10-19T10:00:00+08:00',
    data: { header: { config: { provider: 'deepseek', model: 'deepseek-flash' } } },
  },
  {
    type: 'assistant/message',
    seq: 2,
    time: '2026-10-19T10:00:00+08:00',
    data: { turn: 1, step: 1, message: { source: { kind: 'model', ...model } }, usage, stream: [] },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: '2026-10-19T20:00:00+08:00',
    data: { turn: 1, step: 2, message: { source: { kind: 'model', ...model } }, usage, stream: [] },
  },
];

const folded = await __test.foldColdSession(events, engine);
console.log(`peak + off-peak total: ¥${folded.costCny.toFixed(2)}, turn=¥${folded.currentTurnCny.toFixed(2)}`);
if (Math.abs(folded.costCny - 3) > 1e-9) throw new Error(`expected ¥3.00, got ${folded.costCny}`);
if (Math.abs(folded.currentTurnCny - 3) > 1e-9) throw new Error(`expected turn ¥3.00, got ${folded.currentTurnCny}`);
if (folded.turnSeq !== 0) throw new Error('turn sequence mismatch');

console.log('historical cross-period verification: OK');

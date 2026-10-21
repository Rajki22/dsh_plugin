/**
 * Host wiring smoke test: runs apply() with a minimal Context shaped like the
 * real Host, captures the registered projection and routes, and checks the
 * injected route token.
 *
 *   node scripts/verify-host.mjs
 */

import { apply } from '../index.js';

process.env.DSH_WHALE_WIDGET_DISABLE_REFRESH = '1';

let projection = null;
let indexTap = null;
const routes = [];
const effects = [];
const timerIntervals = [];

const ctx = {
  effect(callback) {
    const disposer = callback();
    const normalized = typeof disposer === 'function' ? disposer : () => {};
    effects.push(normalized);
    return normalized;
  },
  sessionProjections: {
    register(definition) {
      projection = definition;
      return () => {};
    },
  },
  webServer: {
    tapIndex(transform) {
      indexTap = transform;
      return () => {};
    },
    register(route) {
      routes.push(route);
      return () => {};
    },
  },
  timer: {
    interval(callback, delay) {
      const record = { callback, delay, disposed: false };
      record.dispose = () => {
        record.disposed = true;
      };
      timerIntervals.push(record);
      return record.dispose;
    },
  },
};

await apply(ctx);

if (!projection || projection.key !== 'whaleCost') throw new Error('whaleCost projection missing');
if (projection.stateVersion !== 5) throw new Error(`unexpected stateVersion ${projection.stateVersion}`);
if (routes.length !== 6) throw new Error(`expected 6 routes, got ${routes.length}`);
if (timerIntervals.length !== 2) throw new Error(`expected 2 daily timers, got ${timerIntervals.length}`);
if (timerIntervals.some((timer) => timer.delay !== 24 * 60 * 60 * 1000)) {
  throw new Error('daily timer interval mismatch');
}
for (const route of routes) {
  if (route.kind !== 'exact') throw new Error(`unexpected route kind ${route.kind}`);
}
if (!indexTap) throw new Error('index tap missing');

const html = indexTap('<!doctype html><html><head></head><body></body></html>');
if (!html.includes('__DSH_WHALE_COST_TOKEN__')) throw new Error('route token not injected');

const peakTime = new Date('2026-10-19T10:00:00+08:00').getTime();
const turnStart = projection.apply(projection.init(), {
  type: 'user/message',
  seq: 0,
  time: peakTime,
  data: {},
});
const state = projection.apply(turnStart, {
  type: 'request/header',
  seq: 1,
  time: peakTime,
  data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } },
});
const afterUsage = projection.apply(state, {
  type: 'assistant/message',
  seq: 2,
  time: peakTime,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    },
    stream: [],
  },
});
if (Math.abs(afterUsage.totalCostCny - 10.04) > 1e-9) {
  throw new Error(`unexpected projection cost ${afterUsage.totalCostCny}`);
}
const wire = projection.wire.view(afterUsage);
projection.wire.viewSchema.parse(wire);
if (wire.totalCny !== afterUsage.totalCostCny) throw new Error('wire total mismatch');
if (Math.abs(wire.currentTurnCny - 10.04) > 1e-9) throw new Error('wire turn cost mismatch');
if (wire.turnSeq !== 0) throw new Error(`wire turn seq ${wire.turnSeq}`);

console.log(`routes: ${routes.map((route) => route.path).join(', ')}`);
console.log(`projection cost: ¥${afterUsage.totalCostCny.toFixed(4)}`);
console.log(`wire: total=¥${wire.totalCny.toFixed(4)} turn=¥${wire.currentTurnCny.toFixed(4)} seq=${wire.turnSeq}`);

for (const dispose of effects.reverse()) dispose();
if (timerIntervals.some((timer) => !timer.disposed)) {
  throw new Error('daily timer was not disposed with the Host effect');
}
console.log('daily timers: disposed with Host effects');
console.log('host wiring verification: OK');

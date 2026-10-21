import { usageSampleIterator } from './usage.js';

export const COST_KEY = 'whaleCost';
export const YIELD_EVERY_EVENTS = 512;

export function isFiniteCost(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export const costStateSchema = {
  parse(value) {
    if (!value || typeof value !== 'object') throw new TypeError('whaleCost: state must be an object');
    if (!isFiniteCost(value.totalCostCny)) throw new TypeError('whaleCost: invalid totalCostCny');
    if (!Number.isSafeInteger(value.startSeq)) throw new TypeError('whaleCost: invalid startSeq');
    if (!isFiniteCost(value.turnBaseCny)) throw new TypeError('whaleCost: invalid turnBaseCny');
    if (value.turnSeq !== null && !Number.isSafeInteger(value.turnSeq)) {
      throw new TypeError('whaleCost: invalid turnSeq');
    }
    if (!Number.isSafeInteger(value.invalidTimeCount) || value.invalidTimeCount < 0) {
      throw new TypeError('whaleCost: invalid invalidTimeCount');
    }
    if (value.model !== null) {
      if (!value.model || typeof value.model !== 'object'
        || typeof value.model.provider !== 'string'
        || typeof value.model.model !== 'string') {
        throw new TypeError('whaleCost: invalid model');
      }
    }
    if (value.last !== null) {
      if (!value.last || typeof value.last !== 'object'
        || !Number.isSafeInteger(value.last.turn)
        || !Number.isSafeInteger(value.last.step)
        || !isFiniteCost(value.last.costCny)) {
        throw new TypeError('whaleCost: invalid last sample');
      }
    }
    return value;
  },
};

export const costViewSchema = {
  parse(value) {
    if (!value || typeof value !== 'object') throw new TypeError('whaleCost: view must be an object');
    if (!isFiniteCost(value.totalCny)) throw new TypeError('whaleCost: invalid totalCny');
    if (!isFiniteCost(value.currentTurnCny)) throw new TypeError('whaleCost: invalid currentTurnCny');
    if (value.turnSeq !== null && !Number.isSafeInteger(value.turnSeq)) {
      throw new TypeError('whaleCost: invalid view turnSeq');
    }
    if (!Number.isSafeInteger(value.invalidTimeCount) || value.invalidTimeCount < 0) {
      throw new TypeError('whaleCost: invalid view invalidTimeCount');
    }
    return value;
  },
};

export function initialCostState() {
  return {
    totalCostCny: 0,
    startSeq: 0,
    turnBaseCny: 0,
    turnSeq: null,
    invalidTimeCount: 0,
    model: null,
    last: null,
  };
}

function sameModel(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model;
}

export function applyCostState(state, record, engine) {
  const event = record.event;
  if (Number.isSafeInteger(state.startSeq)
    && Number.isSafeInteger(event.seq)
    && event.seq < state.startSeq) {
    return state;
  }
  let next = state;
  if (record.model && !sameModel(next.model, record.model)) {
    next = { ...next, model: record.model };
  }
  if (event.type === 'user/message') {
    return {
      ...next,
      turnBaseCny: next.totalCostCny,
      turnSeq: event.seq,
    };
  }
  if (record.retry) {
    return next.last !== null
      && next.last.turn === record.turn
      && next.last.step === record.step
      ? { ...next, last: null }
      : next;
  }
  if (!record.usage) return next;

  const previous = next.last !== null
    && next.last.turn === record.turn
    && next.last.step === record.step
    ? next.last.costCny
    : 0;
  const costCny = record.invalidTime
    ? 0
    : engine.costCnyForUsage(record.usage, record.model, record.event.time);
  return {
    ...next,
    totalCostCny: Math.max(0, next.totalCostCny - previous + costCny),
    invalidTimeCount: next.invalidTimeCount + (record.invalidTime ? 1 : 0),
    last: { turn: record.turn, step: record.step, costCny },
  };
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function initialUsageState() {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function usageSample(usage) {
  return {
    uncachedInputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    cacheReadTokens: tokenCount(usage?.cacheReadTokens),
    cacheWriteTokens: tokenCount(usage?.cacheWriteTokens),
  };
}

export function applyUsageState(state, record) {
  if (!record.usage) return state;
  const sample = usageSample(record.usage);
  const previous = record.previous ? usageSample(record.previous.usage) : null;
  return {
    uncachedInputTokens: Math.max(0, state.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + sample.uncachedInputTokens),
    outputTokens: Math.max(0, state.outputTokens - (previous?.outputTokens ?? 0) + sample.outputTokens),
    cacheReadTokens: Math.max(0, state.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + sample.cacheReadTokens),
    cacheWriteTokens: Math.max(0, state.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + sample.cacheWriteTokens),
  };
}

export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function foldColdSession(events, engine, inheritedEventCount = 0, includeUsage = true) {
  const startSeq = Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0;
  let costState = { ...initialCostState(), startSeq };
  let usageState = includeUsage ? initialUsageState() : null;
  let count = 0;
  for (const record of usageSampleIterator(events, startSeq)) {
    costState = applyCostState(costState, record, engine);
    if (usageState !== null) usageState = applyUsageState(usageState, record);
    count += 1;
    if (count > 0 && count % YIELD_EVERY_EVENTS === 0) await yieldToEventLoop();
  }
  const currentTurnCny = costState.turnSeq === null
    ? 0
    : Math.max(0, costState.totalCostCny - costState.turnBaseCny);
  return {
    costCny: costState.totalCostCny,
    currentTurnCny,
    turnSeq: costState.turnSeq,
    invalidTimeCount: costState.invalidTimeCount,
    model: costState.model,
    usage: usageState,
  };
}

export function viewDetails(values) {
  const value = values?.[COST_KEY];
  if (!value || typeof value !== 'object') {
    return {
      totalCny: 0,
      currentTurnCny: 0,
      turnSeq: null,
      invalidTimeCount: 0,
    };
  }
  return {
    totalCny: isFiniteCost(value.totalCny) ? value.totalCny : 0,
    currentTurnCny: isFiniteCost(value.currentTurnCny) ? value.currentTurnCny : 0,
    turnSeq: Number.isSafeInteger(value.turnSeq) ? value.turnSeq : null,
    invalidTimeCount: Number.isSafeInteger(value.invalidTimeCount) ? value.invalidTimeCount : 0,
  };
}

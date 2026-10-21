import { toEpochMs } from './time.js';

export function modelOf(provider, model) {
  if (typeof provider !== 'string' || provider.length === 0) return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  return { provider, model };
}

export function modelFromConfig(config) {
  return modelOf(config?.provider, config?.model);
}

export function modelFromSource(source) {
  if (!source || source.kind !== 'model') return null;
  return modelOf(source.provider, source.model);
}

function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === 'chunk' && record.chunk?.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}

export function usageOfEvent(event) {
  if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
    return event.data.usage;
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined;
  return lastStreamUsage(event.data?.stream);
}

/**
 * Interpret one event against the model active before it. This is the only
 * place that extracts usage/model/turn/time from a raw Session event; the
 * projection uses it per event, and usageSampleIterator uses it per stream.
 */
export function eventUsageSample(event, currentModel = null) {
  let model = currentModel;
  let usage;
  let turn = null;
  let step = null;
  let epoch = null;
  let invalidTime = false;
  let retry = false;
  let userMessage = false;

  if (event.type === 'request/header') {
    const next = modelFromConfig(event.data?.header?.config);
    if (next) model = next;
  } else if (event.type === 'request/context') {
    const next = modelOf(event.data?.provider, event.data?.model);
    if (next) model = next;
  } else if (event.type === 'user/message') {
    userMessage = true;
  } else if (event.type === 'llm/retry-started') {
    retry = true;
    turn = event.data?.turn;
    step = event.data?.step;
  } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
    usage = usageOfEvent(event);
    turn = event.data?.turn;
    step = event.data?.step;
    if (event.type === 'assistant/message') {
      const next = modelFromSource(event.data?.message?.source);
      if (next) model = next;
    }
    if (usage && Number.isSafeInteger(turn) && Number.isSafeInteger(step)) {
      epoch = toEpochMs(event.time);
      invalidTime = epoch === null;
    } else {
      usage = undefined;
    }
  }

  return {
    event,
    usage,
    model,
    turn,
    step,
    epoch,
    invalidTime,
    retry,
    userMessage,
    replaced: false,
    replacesPrevious: false,
    previous: null,
  };
}

/**
 * The single interpretation of a Session event stream for billing.
 *
 * It yields every non-inherited event so callers can yield to the event loop,
 * while centralizing the parts that are easy to get wrong:
 * - model tracking from request headers/context and assistant sources;
 * - retry slot clearing;
 * - same turn/step replacement and the previous sample reference;
 * - event timestamp parsing and invalid-time marking.
 *
 * A yielded record with `usage` is a candidate usage sample. `previous` points
 * at the sample it replaces; `replaced` is already set on that previous
 * sample. Callers that only need totals ignore non-usage records.
 */
export function* usageSampleIterator(events, inheritedEventCount = 0) {
  const startSeq = Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0;
  let model = null;
  let lastKey = null;
  let lastSample = null;

  for (const event of events) {
    if (Number.isSafeInteger(event.seq) && event.seq < startSeq) continue;
    const record = eventUsageSample(event, model);
    model = record.model;

    if (record.retry) {
      const key = `${record.turn}:${record.step}`;
      if (lastKey !== null && lastKey === key) {
        lastKey = null;
        lastSample = null;
      }
    }

    if (record.usage) {
      const key = `${record.turn}:${record.step}`;
      const previous = lastKey === key ? lastSample : null;
      if (previous) previous.replaced = true;
      record.replacesPrevious = previous !== null;
      record.previous = previous;
      lastKey = key;
      lastSample = record;
    }

    yield record;
  }
}

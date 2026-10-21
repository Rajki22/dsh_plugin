/**
 * Host half of the DeepSeek whale widget.
 *
 * It owns two things the Client cannot compute safely:
 *  - a `whaleCost` session projection that folds durable usage events into CNY;
 *  - a token-protected workspace-cost route that sums the workspace's sessions.
 *
 * The price catalog is the bundled official DeepSeek CNY table; no USD
 * conversion and no pi-ai catalog scan are involved.
 */

import { randomBytes } from 'node:crypto';
import { isBeijingPeak } from './pricing.js';
import { createPricingService } from './pricing-source.js';
import { createHolidayService } from './holidays.js';
import { beijingDateKey, toBeijingIso } from './time.js';
import {
  COST_KEY,
  YIELD_EVERY_EVENTS,
  applyCostState,
  costStateSchema,
  costViewSchema,
  foldColdSession,
  initialCostState,
  isFiniteCost,
  viewDetails,
  yieldToEventLoop,
} from './cost.js';
import { eventUsageSample, usageSampleIterator } from './usage.js';

const WORKSPACE_ROUTE = '/dsh-whale-widget/workspace-cost';
const RECONCILIATION_ROUTE = '/dsh-whale-widget/cost-reconciliation';
const SESSION_ROUTE = '/dsh-whale-widget/session-cost';
const USAGE_BREAKDOWN_ROUTE = '/dsh-whale-widget/usage-breakdown';
const PRICING_ROUTE = '/dsh-whale-widget/pricing-info';
const HOLIDAY_ROUTE = '/dsh-whale-widget/holiday-info';
const TOKEN_HEADER = 'x-dsh-whale-cost-token';
const TOKEN_GLOBAL = '__DSH_WHALE_COST_TOKEN__';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function workspaceSessionScope(ctx, sessionId) {
  const workspace = ctx.workspaceRegistry.list().find((entry) => entry.sessionIds.includes(sessionId));
  return {
    workspace,
    ids: workspace ? [...workspace.sessionIds] : [sessionId],
    scope: workspace
      ? 'workspace.sessionIds (canonical cwd; includes main, subagent, fork, archived)'
      : 'current session only (workspace not found)',
  };
}

const COLD_CACHE_LIMIT = 100;

/**
 * Small LRU for cold session totals. A lookup touches the entry; an insert
 * evicts the least recently used session once the cap is exceeded.
 */
function coldCacheGet(coldCache, sessionId) {
  const cached = coldCache.get(sessionId);
  if (cached === undefined) return undefined;
  coldCache.delete(sessionId);
  coldCache.set(sessionId, cached);
  return cached;
}

function coldCacheSet(coldCache, sessionId, entry) {
  if (coldCache.has(sessionId)) coldCache.delete(sessionId);
  coldCache.set(sessionId, entry);
  while (coldCache.size > COLD_CACHE_LIMIT) {
    coldCache.delete(coldCache.keys().next().value);
  }
}

function coldCacheEntry(coldCache, sessionId, revision, mtimeMs, cacheVersion, requireUsage) {
  const cached = coldCacheGet(coldCache, sessionId);
  if (!cached) return undefined;
  if (cached.revision !== revision) return undefined;
  if (cached.mtimeMs !== mtimeMs) return undefined;
  if (cached.cacheVersion !== cacheVersion) return undefined;
  if (requireUsage && !cached.hasUsage) return undefined;
  return cached;
}

async function readColdSession(ctx, sessionId, engine, coldCache, includeDetails) {
  const stat = await ctx.sessionPersistence.stat(sessionId);
  if (!stat) {
    return {
      costCny: 0,
      currentTurnCny: 0,
      turnSeq: null,
      invalidTimeCount: 0,
      usage: null,
      model: null,
      revision: null,
      mtimeMs: null,
      cacheVersion: engine.cacheVersion,
      hasUsage: false,
    };
  }
  const revision = stat.revision ?? null;
  const mtimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  const cacheVersion = engine.cacheVersion;
  const cached = coldCacheEntry(
    coldCache,
    sessionId,
    revision,
    mtimeMs,
    cacheVersion,
    includeDetails,
  );
  if (cached) return cached;

  const log = await ctx.sessionQuery.readSession(sessionId);
  const folded = await foldColdSession(
    log.events,
    engine,
    log.inheritedEventCount,
    includeDetails,
  );
  const entry = {
    revision,
    mtimeMs,
    cacheVersion,
    hasUsage: includeDetails,
    costCny: folded.costCny,
    currentTurnCny: folded.currentTurnCny,
    turnSeq: folded.turnSeq,
    invalidTimeCount: folded.invalidTimeCount,
    usage: folded.usage,
    model: folded.model,
  };
  coldCacheSet(coldCache, sessionId, entry);
  return entry;
}

async function sessionCost(ctx, sessionId, engine, coldCache, includeDetails = false) {
  const live = ctx.sessions.get(sessionId);
  if (live) {
    const keys = includeDetails ? [COST_KEY, 'tokenUsage'] : [COST_KEY];
    const snapshot = ctx.sessionProjections.snapshot(live, keys);
    const details = viewDetails(snapshot.values);
    const state = includeDetails && typeof ctx.sessionProjections.stateOf === 'function'
      ? ctx.sessionProjections.stateOf(live, COST_KEY)
      : null;
    return {
      costCny: details.totalCny,
      currentTurnCny: details.currentTurnCny,
      turnSeq: details.turnSeq,
      invalidTimeCount: details.invalidTimeCount,
      usage: includeDetails ? snapshot.values?.tokenUsage ?? null : null,
      model: includeDetails && state ? state.model : null,
      hasUsage: includeDetails,
      live: true,
    };
  }
  const cold = await readColdSession(ctx, sessionId, engine, coldCache, includeDetails);
  return { ...cold, live: false };
}

async function sumSessionIds(ctx, ids, engine, coldCache) {
  let totalCny = 0;
  let processedSessions = 0;
  let failedSessions = 0;
  for (const id of ids) {
    try {
      const entry = await sessionCost(ctx, id, engine, coldCache, false);
      if (isFiniteCost(entry.costCny)) {
        totalCny += entry.costCny;
        processedSessions += 1;
      }
    } catch (error) {
      failedSessions += 1;
    }
    await yieldToEventLoop();
  }
  return { totalCny, processedSessions, failedSessions };
}

async function workspaceCost(ctx, sessionId, engine, coldCache) {
  const { workspace, ids, scope } = workspaceSessionScope(ctx, sessionId);
  const summed = await sumSessionIds(ctx, ids, engine, coldCache);
  return {
    ...summed,
    workspaceId: workspace?.id ?? null,
    scope,
    sessionCount: ids.length,
    pricingSource: engine.source,
    currency: engine.currency,
    modelCount: engine.modelCount,
  };
}

async function costReconciliation(ctx, sessionId, engine, coldCache) {
  const workspaces = ctx.workspaceRegistry.list();
  const seen = new Set();
  const allLocalWorkspaces = [];
  let allLocalTotal = 0;
  let currentWorkspace = null;

  for (const workspace of workspaces) {
    const ids = [];
    for (const id of workspace.sessionIds ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    const summed = await sumSessionIds(ctx, ids, engine, coldCache);
    const item = {
      id: workspace.id,
      path: workspace.path ?? null,
      title: workspace.title ?? null,
      totalCny: summed.totalCny,
      sessionCount: ids.length,
      processedSessions: summed.processedSessions,
      failedSessions: summed.failedSessions,
    };
    allLocalWorkspaces.push(item);
    allLocalTotal += summed.totalCny;
    if (workspace.sessionIds?.includes(sessionId)) currentWorkspace = item;
  }

  const currentSession = await sessionCost(ctx, sessionId, engine, coldCache, true);
  const currentTotal = currentWorkspace ? currentWorkspace.totalCny : currentSession.costCny;
  return {
    currentWorkspace,
    allLocalWorkspaces,
    allLocalTotal,
    otherWorkspaceTotal: Math.max(0, allLocalTotal - currentTotal),
    currentSession: {
      totalCny: currentSession.costCny,
      currentTurnCny: currentSession.currentTurnCny,
      turnSeq: currentSession.turnSeq,
      invalidTimeCount: currentSession.invalidTimeCount,
    },
    scope: 'all local workspaces (deduped sessionIds)',
    pricingSource: engine.source,
    currency: engine.currency,
    generatedAt: new Date().toISOString(),
  };
}

async function usageBreakdown(ctx, sessionId, engine, limit = 200) {
  const live = ctx.sessions.get(sessionId);
  let events;
  let inheritedEventCount;
  if (live) {
    events = live.snapshotEvents();
    inheritedEventCount = live.inheritedEventCount;
  } else {
    const log = await ctx.sessionQuery.readSession(sessionId);
    events = log.events;
    inheritedEventCount = log.inheritedEventCount;
  }
  const startSeq = Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0;
  const buckets = {
    peak: { count: 0, costCny: 0 },
    offPeak: { count: 0, costCny: 0 },
    holiday: { count: 0, costCny: 0 },
    unknown: { count: 0, costCny: 0 },
  };
  const entries = [];
  const entryBySample = new Map();
  let appliedTotalCny = 0;
  let invalidTimeCount = 0;
  let lastModel = null;
  let index = 0;

  for (const record of usageSampleIterator(events, startSeq)) {
    index += 1;
    if (record.model) lastModel = record.model;
    if (!record.usage) {
      if (index % YIELD_EVERY_EVENTS === 0) await yieldToEventLoop();
      continue;
    }

    if (record.invalidTime) invalidTimeCount += 1;
    const costCny = record.invalidTime
      ? 0
      : engine.costCnyForUsage(record.usage, record.model, record.event.time);
    if (record.previous) {
      /*
       * The iterator reports the exact prior sample for a same-turn/step
       * replacement. Remove that sample from both the total and its bucket so
       * `usage-breakdown` stays equal to the incremental projection.
       */
      const previousEntry = entryBySample.get(record.previous);
      if (previousEntry) {
        previousEntry.replaced = true;
        appliedTotalCny = Math.max(0, appliedTotalCny - previousEntry.costCny);
        buckets[previousEntry.period].count = Math.max(0, buckets[previousEntry.period].count - 1);
        buckets[previousEntry.period].costCny = Math.max(0, buckets[previousEntry.period].costCny - previousEntry.costCny);
      }
    }

    const dateKey = record.epoch === null ? null : beijingDateKey(record.epoch);
    const holiday = dateKey !== null && engine.holidayMap.get(dateKey) === true;
    const peak = record.epoch !== null && isBeijingPeak(record.epoch, engine.holidayMap);
    const period = record.epoch === null
      ? 'unknown'
      : holiday
        ? 'holiday'
        : peak
          ? 'peak'
          : 'offPeak';
    const entry = {
      seq: record.event.seq,
      time: record.epoch === null ? null : new Date(record.epoch).toISOString(),
      beijingTime: record.epoch === null ? null : toBeijingIso(record.epoch),
      beijingDate: dateKey,
      period,
      holiday,
      peak,
      model: record.model,
      usage: record.usage,
      costCny,
      replaced: false,
    };
    entries.push(entry);
    entryBySample.set(record, entry);
    appliedTotalCny += costCny;
    buckets[period].count += 1;
    buckets[period].costCny += costCny;
    if (index % YIELD_EVERY_EVENTS === 0) await yieldToEventLoop();
  }

  return {
    totalCny: appliedTotalCny,
    invalidTimeCount,
    entryCount: entries.length,
    truncated: entries.length > limit,
    buckets,
    entries: entries.slice(-limit),
    inheritedEventCount: startSeq,
    model: lastModel,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function authorized(req, token) {
  // Local tooling may probe the aggregate cost endpoints directly. Remote
  // clients still need the token injected into the page.
  return isLoopbackRequest(req) || req.headers[TOKEN_HEADER] === token;
}

function requestSessionId(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get('sessionId');
  } catch (error) {
    return null;
  }
}

function injectToken(html, token) {
  const script = `<script>globalThis.${TOKEN_GLOBAL}=${JSON.stringify(token)};</script>`;
  return html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${html}${script}`;
}

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1'
    || address === '::1'
    || address.endsWith('127.0.0.1');
}

function handlePricingInfo(req, res, pricing, holiday) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  return sendJson(res, 200, {
    ok: true,
    ...pricing.status,
    holiday: holiday.status,
  });
}

function handleHolidayInfo(req, res, holiday) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  return sendJson(res, 200, {
    ok: true,
    ...holiday.status,
  });
}

async function handleWorkspaceCost(req, res, ctx, engine, coldCache, token) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!authorized(req, token)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const sessionId = requestSessionId(req);
  if (!sessionId) return sendJson(res, 400, { ok: false, error: 'session-required' });
  try {
    const result = await workspaceCost(ctx, sessionId, engine, coldCache);
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: 'workspace-cost-failed' });
  }
}

async function handleCostReconciliation(req, res, ctx, engine, coldCache, token) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!authorized(req, token)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const sessionId = requestSessionId(req);
  if (!sessionId) return sendJson(res, 400, { ok: false, error: 'session-required' });
  try {
    const result = await costReconciliation(ctx, sessionId, engine, coldCache);
    return sendJson(res, 200, { ok: true, sessionId, ...result });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: 'cost-reconciliation-failed' });
  }
}

async function handleUsageBreakdown(req, res, ctx, engine, token) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!authorized(req, token)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const sessionId = requestSessionId(req);
  if (!sessionId) return sendJson(res, 400, { ok: false, error: 'session-required' });
  let limit = 200;
  try {
    const rawLimit = new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit');
    if (rawLimit !== null) {
      const parsed = Number.parseInt(rawLimit, 10);
      if (Number.isSafeInteger(parsed)) limit = Math.min(1000, Math.max(1, parsed));
    }
  } catch (error) {
    // Keep the default limit.
  }
  try {
    const result = await usageBreakdown(ctx, sessionId, engine, limit);
    return sendJson(res, 200, { ok: true, sessionId, ...result });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: 'usage-breakdown-failed' });
  }
}

async function handleSessionCost(req, res, ctx, engine, coldCache, token) {
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
  if (!authorized(req, token)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
  const sessionId = requestSessionId(req);
  if (!sessionId) return sendJson(res, 400, { ok: false, error: 'session-required' });
  try {
    const result = await sessionCost(ctx, sessionId, engine, coldCache, true);
    const price = result.model ? engine.resolvePrice(result.model.provider, result.model.model) : null;
    return sendJson(res, 200, {
      ok: true,
      sessionId,
      live: result.live,
      tokenUsage: result.usage,
      totalCostCny: result.costCny,
      currentTurnCny: result.currentTurnCny,
      turnSeq: result.turnSeq,
      invalidTimeCount: result.invalidTimeCount,
      model: result.model,
      price: price
        ? {
          provider: price.provider,
          model: price.id,
          peak: price.peak,
          offPeak: price.offPeak,
        }
        : null,
      pricingSource: engine.source,
      currency: engine.currency,
    });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: 'session-cost-failed' });
  }
}

export const inject = [
  'webServer',
  'sessions',
  'workspaceRegistry',
  'sessionPersistence',
  'sessionProjections',
  'sessionQuery',
  'timer',
];

/** Pure helpers exposed for local verification without a live Harness context. */
export const __test = {
  foldColdSession,
};

export async function apply(ctx) {
  const pricing = await createPricingService();
  const engine = pricing.engine;
  const holiday = await createHolidayService({ cacheDir: pricing.cacheDir });
  engine.setHolidayMap(holiday.map);
  const coldCache = new Map();
  const routeToken = randomBytes(24).toString('hex');
  let costView = null;

  console.log(
    `[dsh-whale-widget] pricing loaded source=${pricing.status.pricingSource} currency=${engine.currency} models=${engine.modelCount} cache=${pricing.cacheFile}`,
  );
  console.log(
    `[dsh-whale-widget] holidays loaded days=${holiday.map.size} years=${holiday.status.years.map((entry) => `${entry.year}:${entry.source}`).join(',')}`,
  );

  ctx.effect(() => ctx.sessionProjections.register({
    key: COST_KEY,
    stateVersion: 5,
    stateSchema: costStateSchema,
    init: (_header, inheritedEventCount) => ({
      ...initialCostState(),
      startSeq: Number.isSafeInteger(inheritedEventCount) ? inheritedEventCount : 0,
    }),
    apply: (state, event) => {
      if (Number.isSafeInteger(state.startSeq)
        && Number.isSafeInteger(event.seq)
        && event.seq < state.startSeq) {
        return state;
      }
      return applyCostState(state, eventUsageSample(event, state.model), engine);
    },
    wire: {
      viewSchema: costViewSchema,
      view: (state) => {
        const totalCny = state.totalCostCny;
        const currentTurnCny = state.turnSeq === null
          ? 0
          : Math.max(0, totalCny - state.turnBaseCny);
        const turnSeq = state.turnSeq;
        const invalidTimeCount = state.invalidTimeCount;
        if (costView
          && costView.totalCny === totalCny
          && costView.currentTurnCny === currentTurnCny
          && costView.turnSeq === turnSeq
          && costView.invalidTimeCount === invalidTimeCount) {
          return costView;
        }
        /*
         * The projection registry only publishes when the wire view reference
         * changes. Reusing this object when all visible fields are equal keeps
         * model-only events from waking every Client subscriber.
         */
        costView = { totalCny, currentTurnCny, turnSeq, invalidTimeCount };
        return costView;
      },
    },
  }), 'dsh-whale-widget: whaleCost projection');

  ctx.effect(
    () => ctx.webServer.tapIndex((html) => injectToken(html, routeToken)),
    'dsh-whale-widget: cost route token',
  );

  ctx.effect(() => {
    const disposeWorkspace = ctx.webServer.register({
      kind: 'exact',
      path: WORKSPACE_ROUTE,
      handler: (req, res) => handleWorkspaceCost(req, res, ctx, engine, coldCache, routeToken),
    });
    const disposeReconciliation = ctx.webServer.register({
      kind: 'exact',
      path: RECONCILIATION_ROUTE,
      handler: (req, res) => handleCostReconciliation(req, res, ctx, engine, coldCache, routeToken),
    });
    const disposeSession = ctx.webServer.register({
      kind: 'exact',
      path: SESSION_ROUTE,
      handler: (req, res) => handleSessionCost(req, res, ctx, engine, coldCache, routeToken),
    });
    const disposeBreakdown = ctx.webServer.register({
      kind: 'exact',
      path: USAGE_BREAKDOWN_ROUTE,
      handler: (req, res) => handleUsageBreakdown(req, res, ctx, engine, routeToken),
    });
    const disposePricing = ctx.webServer.register({
      kind: 'exact',
      path: PRICING_ROUTE,
      handler: (req, res) => handlePricingInfo(req, res, pricing, holiday),
    });
    const disposeHoliday = ctx.webServer.register({
      kind: 'exact',
      path: HOLIDAY_ROUTE,
      handler: (req, res) => handleHolidayInfo(req, res, holiday),
    });
    return () => {
      disposeWorkspace();
      disposeReconciliation();
      disposeSession();
      disposeBreakdown();
      disposePricing();
      disposeHoliday();
    };
  }, 'dsh-whale-widget: cost routes');

  let pricingInFlight = false;
  let holidayInFlight = false;
  const refreshPricing = () => {
    if (pricingInFlight) return;
    pricingInFlight = true;
    void pricing.refresh()
      .catch((error) => {
        console.warn(`[dsh-whale-widget] pricing refresh failed: ${error.message}`);
      })
      .finally(() => {
        pricingInFlight = false;
      });
  };
  const refreshHolidays = () => {
    if (holidayInFlight) return;
    holidayInFlight = true;
    void holiday.refresh()
      .then(() => engine.setHolidayMap(holiday.map))
      .catch((error) => {
        console.warn(`[dsh-whale-widget] holiday refresh failed: ${error.message}`);
      })
      .finally(() => {
        holidayInFlight = false;
      });
  };

  if (process.env.DSH_WHALE_WIDGET_DISABLE_REFRESH !== '1') {
    refreshPricing();
    refreshHolidays();
  }

  ctx.effect(
    () => ctx.timer.interval(refreshPricing, REFRESH_INTERVAL_MS),
    'dsh-whale-widget: daily pricing refresh',
  );
  ctx.effect(
    () => ctx.timer.interval(refreshHolidays, REFRESH_INTERVAL_MS),
    'dsh-whale-widget: daily holiday refresh',
  );
}

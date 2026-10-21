/**
 * Local DeepSeek CNY pricing and peak/off-peak cost estimation.
 *
 * The bundled price sheet is the official DeepSeek API table in CNY per
 * 1M tokens. No USD conversion is applied. Each model carries separate
 * peak and off-peak prices, matching the official billing page.
 *
 * The engine keeps mutable price and holiday tables: the Host can refresh
 * either from the network without rebuilding the projection.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BEIJING_OFFSET_MS, beijingDateKey, toEpochMs } from './time.js';

const DEFAULT_PRICE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pricing',
  'deepseek.json',
);

function numberOrZero(value) {
  const number = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizePeriod(period) {
  return {
    cacheRead: numberOrZero(period?.cacheRead),
    input: numberOrZero(period?.input),
    output: numberOrZero(period?.output),
  };
}

function inPeakWindow(beijing) {
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60)
    || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * Whether a usage timestamp falls in the Beijing peak windows.
 *
 * `holidayMap` maps `YYYY-MM-DD` to `isOffDay`:
 * - true  -> statutory holiday, all day off-peak
 * - false -> make-up workday, normal peak windows apply even on a weekend
 * - absent -> ordinary weekend/weekday rule
 *
 * All date matching uses UTC+8.
 * @param {number|string|Date} time timestamp or ISO date.
 * @param {Map<string, boolean>} [holidayMap]
 * @returns {boolean}
 */
export function isBeijingPeak(time, holidayMap) {
  const timestamp = toEpochMs(time);
  if (timestamp === null) return false;
  const beijing = new Date(timestamp + BEIJING_OFFSET_MS);
  const holiday = holidayMap instanceof Map
    ? holidayMap.get(beijingDateKey(timestamp))
    : undefined;
  if (holiday === true) return false;
  if (holiday === false) return inPeakWindow(beijing);
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return inPeakWindow(beijing);
}

export function normalizePriceTable(table, options = {}) {
  if (!table || typeof table !== 'object') {
    throw new Error('whale pricing: table must be an object');
  }
  if (table.currency !== 'CNY') {
    throw new Error(`whale pricing: expected CNY table, got ${String(table.currency)}`);
  }
  const models = new Map();
  for (const [id, entry] of Object.entries(table.models ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const peak = normalizePeriod(entry.peak);
    const offPeak = normalizePeriod(entry.offPeak);
    const priced = [peak.cacheRead, peak.input, peak.output, offPeak.cacheRead, offPeak.input, offPeak.output]
      .some((value) => value > 0);
    if (!priced) continue;
    const model = {
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      id,
      aliases: Array.isArray(entry.aliases)
        ? entry.aliases.filter((alias) => typeof alias === 'string' && alias.length > 0)
        : [],
      peak,
      offPeak,
    };
    models.set(id, model);
    for (const alias of model.aliases) models.set(alias, model);
  }
  if (models.size === 0) throw new Error('whale pricing: table contains no models');
  return {
    source: typeof options.source === 'string' && options.source.length > 0
      ? options.source
      : 'bundled-cny',
    currency: 'CNY',
    sourceFile: typeof options.sourceFile === 'string' ? options.sourceFile : null,
    sourceLabel: typeof table.source === 'string' ? table.source : null,
    models,
  };
}

export async function loadCnyPriceTable(options = {}) {
  const priceFile = options.priceFile ?? DEFAULT_PRICE_FILE;
  const raw = await fs.readFile(priceFile, 'utf8');
  return normalizePriceTable(JSON.parse(raw), {
    source: 'bundled-cny',
    sourceFile: priceFile,
  });
}

/**
 * Build the synchronous cost engine used by the Host projection.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function createPricingEngine(options = {}) {
  const initial = options.priceTable
    ? (options.priceTable.models instanceof Map
      ? options.priceTable
      : normalizePriceTable(options.priceTable, options))
    : await loadCnyPriceTable(options);

  let loaded = initial;
  let byModel = new Map();
  let canonical = new Set();
  let priceVersion = 0;
  let holidayVersion = 0;
  const holidayState = {
    map: options.holidayMap instanceof Map ? options.holidayMap : new Map(),
  };

  function rebuild(next) {
    loaded = next;
    byModel = new Map(next.models);
    canonical = new Set();
    for (const model of byModel.values()) canonical.add(model.id);
  }

  function setPriceTable(next) {
    const normalized = next && next.models instanceof Map
      ? next
      : normalizePriceTable(next, { source: 'official-page' });
    rebuild(normalized);
    priceVersion += 1;
  }

  function setHolidayMap(next) {
    holidayState.map = next instanceof Map ? next : new Map();
    holidayVersion += 1;
  }

  function resolvePrice(provider, model) {
    if (typeof model !== 'string' || model.length === 0) return null;
    return byModel.get(model) ?? null;
  }

  function costCnyForUsage(usage, model, time) {
    if (!usage || typeof usage !== 'object') return 0;
    if (toEpochMs(time) === null) return 0;
    const price = resolvePrice(model?.provider, model?.model);
    if (!price) return 0;
    const period = isBeijingPeak(time, holidayState.map) ? price.peak : price.offPeak;
    const uncachedInput = Math.max(0, numberOrZero(usage.inputTokens));
    const output = Math.max(0, numberOrZero(usage.outputTokens));
    const cacheRead = Math.max(0, numberOrZero(usage.cacheReadTokens));
    const cacheWrite = Math.max(0, numberOrZero(usage.cacheWriteTokens));
    const cny = (
      cacheRead * period.cacheRead
      + (uncachedInput + cacheWrite) * period.input
      + output * period.output
    ) / 1_000_000;
    return Number.isFinite(cny) && cny >= 0 ? cny : 0;
  }

  rebuild(initial);

  return {
    get source() { return loaded.source; },
    get currency() { return loaded.currency; },
    get sourceFile() { return loaded.sourceFile; },
    get sourceLabel() { return loaded.sourceLabel; },
    get modelCount() { return canonical.size; },
    get holidayMap() { return holidayState.map; },
    get cacheVersion() { return `${priceVersion}:${holidayVersion}`; },
    setPriceTable,
    setHolidayMap,
    resolvePrice,
    costCnyForUsage,
  };
}

/** Exported for the local verification script and tests. */
export async function loadPriceTableForTest(options = {}) {
  return loadCnyPriceTable(options);
}

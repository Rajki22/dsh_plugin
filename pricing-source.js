/**
 * Daily official pricing refresh with a local cache and bundled fallback.
 *
 * The initial engine is built from the newest valid cache, or the bundled
 * CNY sheet. The network refresh runs in the background and never blocks
 * Host activation. A successful response updates the live price table.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPricingEngine,
  loadCnyPriceTable,
  normalizePriceTable,
} from './pricing.js';
import {
  readJsonFile,
  readJsonFileWithStat,
  resolveCacheRoot,
  writeJsonFile,
} from './cache.js';
import { beijingDateKey } from './time.js';

const OFFICIAL_PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
const FALLBACK_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'pricing',
  'deepseek.json',
);
const FRESH_CACHE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function extractHtmlCells(rowHtml) {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((match) => stripHtml(match[1]).replace(/\s+/g, ' ').trim())
    .filter((cell) => cell.length > 0);
}

function readPriceRow(text, marker) {
  const pattern = new RegExp(
    `百万\\s*tokens?\\s*输入[\\s\\S]{0,80}?${marker}[\\s\\S]*?`
    + '空闲时段\\s*([\\d.]+)\\s*元\\s*([\\d.]+)\\s*元[\\s\\S]*?'
    + '高峰时段\\s*([\\d.]+)\\s*元\\s*([\\d.]+)\\s*元',
  );
  const match = text.match(pattern);
  if (!match) throw new Error(`official pricing: cannot find ${marker} row`);
  return {
    offFlash: Number.parseFloat(match[1]),
    offPro: Number.parseFloat(match[2]),
    peakFlash: Number.parseFloat(match[3]),
    peakPro: Number.parseFloat(match[4]),
  };
}

function readOutputRow(text) {
  const pattern = /百万\s*tokens?\s*输出[\s\S]*?空闲时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元[\s\S]*?高峰时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元/;
  const match = text.match(pattern);
  if (!match) throw new Error('official pricing: cannot find output row');
  return {
    offFlash: Number.parseFloat(match[1]),
    offPro: Number.parseFloat(match[2]),
    peakFlash: Number.parseFloat(match[3]),
    peakPro: Number.parseFloat(match[4]),
  };
}

function finitePrice(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`official pricing: invalid ${label}`);
  }
  return value;
}

/**
 * Parse the current DeepSeek pricing page. It intentionally rejects a page
 * whose model header or price rows have changed, so the caller can keep the
 * last cache/fallback instead of writing a wrong table.
 * @param {string} html
 * @returns {object}
 */
export function parseOfficialPricingHtml(html) {
  const text = stripHtml(html);
  const headerRow = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => match[1])
    .find((row) => row.includes('模型') && row.includes('deepseek-flash'));
  if (!headerRow) throw new Error('official pricing: model header not found');
  const modelCells = extractHtmlCells(headerRow).filter((cell) => /deepseek-/i.test(cell));
  if (modelCells.length !== 2
    || !/deepseek-flash/i.test(modelCells[0])
    || !/deepseek-v4-pro/i.test(modelCells[1])) {
    throw new Error(`official pricing: unexpected model columns ${JSON.stringify(modelCells)}`);
  }

  const cacheHit = readPriceRow(text, '缓存命中');
  const cacheMiss = readPriceRow(text, '缓存未命中');
  const output = readOutputRow(text);

  const flash = {
    provider: 'deepseek',
    aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    peak: {
      cacheRead: finitePrice(cacheHit.peakFlash, 'flash cache-hit peak'),
      input: finitePrice(cacheMiss.peakFlash, 'flash input peak'),
      output: finitePrice(output.peakFlash, 'flash output peak'),
    },
    offPeak: {
      cacheRead: finitePrice(cacheHit.offFlash, 'flash cache-hit off-peak'),
      input: finitePrice(cacheMiss.offFlash, 'flash input off-peak'),
      output: finitePrice(output.offFlash, 'flash output off-peak'),
    },
  };
  const pro = {
    provider: 'deepseek',
    peak: {
      cacheRead: finitePrice(cacheHit.peakPro, 'v4-pro cache-hit peak'),
      input: finitePrice(cacheMiss.peakPro, 'v4-pro input peak'),
      output: finitePrice(output.peakPro, 'v4-pro output peak'),
    },
    offPeak: {
      cacheRead: finitePrice(cacheHit.offPro, 'v4-pro cache-hit off-peak'),
      input: finitePrice(cacheMiss.offPro, 'v4-pro input off-peak'),
      output: finitePrice(output.offPro, 'v4-pro output off-peak'),
    },
  };

  return {
    source: 'official-page: api-docs.deepseek.com',
    currency: 'CNY',
    unit: 'per_million_tokens',
    fetchedAt: new Date().toISOString(),
    models: {
      'deepseek-flash': flash,
      'deepseek-v4-pro': pro,
    },
  };
}

export async function fetchOfficialPricing() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OFFICIAL_PRICING_URL, {
      headers: {
        'user-agent': 'dsh-whale-widget/1.0 (+https://api-docs.deepseek.com)',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return parseOfficialPricingHtml(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

async function loadCache(cacheFile) {
  const entry = await readJsonFileWithStat(cacheFile);
  if (!entry) return undefined;
  try {
    return {
      table: normalizePriceTable(entry.value, {
        source: 'official-cache',
        sourceFile: cacheFile,
      }),
      updatedAt: entry.stat.mtime.toISOString(),
    };
  } catch (error) {
    return undefined;
  }
}

export async function createPricingService(options = {}) {
  const cacheDir = options.cacheDir ?? resolveCacheRoot();
  const cacheFile = path.join(cacheDir, 'pricing.json');
  const metaFile = path.join(cacheDir, 'pricing-meta.json');
  const fallback = await loadCnyPriceTable({ priceFile: FALLBACK_FILE });
  const cached = await loadCache(cacheFile);
  const engine = await createPricingEngine({
    priceTable: cached ? cached.table : fallback,
  });
  let meta = (await readJsonFile(metaFile)) ?? {};
  let cacheUpdatedAt = cached?.updatedAt ?? null;
  if (cached && meta.lastError) {
    const cacheTime = Date.parse(cached.updatedAt);
    const failureTime = Date.parse(meta.lastFailureAt ?? '');
    if (!Number.isFinite(failureTime) || !Number.isFinite(cacheTime) || cacheTime > failureTime) {
      meta = { ...meta, lastError: null };
      try {
        await writeJsonFile(metaFile, meta);
      } catch (error) {
        // A read-only cache directory must not block startup.
      }
    }
  }

  async function refresh() {
    const now = Date.now();
    const today = beijingDateKey(now);
    let cacheStat;
    try {
      cacheStat = (await fs.stat(cacheFile));
    } catch (error) {
      cacheStat = undefined;
    }
    const cacheFresh = Boolean(cached) && cacheStat
      && now - cacheStat.mtimeMs < FRESH_CACHE_MS;
    if (cacheFresh) return { skipped: 'fresh-cache' };
    if (meta.lastAttemptDate === today) return { skipped: 'daily-limit' };

    meta = {
      ...meta,
      lastAttemptDate: today,
      lastAttemptAt: new Date(now).toISOString(),
    };
    try {
      await writeJsonFile(metaFile, meta);
    } catch (error) {
      console.warn(`[dsh-whale-widget] pricing meta write failed: ${error.message}`);
    }

    try {
      const table = await fetchOfficialPricing();
      const cachedTable = normalizePriceTable(table, {
        source: 'official-page',
        sourceFile: cacheFile,
      });
      const cacheValue = {
        ...table,
        source: 'official-page',
        fetchedAt: new Date().toISOString(),
      };
      await writeJsonFile(cacheFile, cacheValue);
      engine.setPriceTable(cachedTable);
      cacheUpdatedAt = new Date().toISOString();
      meta = {
        ...meta,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      };
      await writeJsonFile(metaFile, meta);
      console.log(
        `[dsh-whale-widget] pricing updated source=official-page models=${engine.modelCount} cache=${cacheFile}`,
      );
      return { updated: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      meta = {
        ...meta,
        lastFailureAt: new Date().toISOString(),
        lastError: message,
      };
      try {
        await writeJsonFile(metaFile, meta);
      } catch (writeError) {
        // Keep the in-memory error; a failed cache write must not fail startup.
      }
      console.warn(
        `[dsh-whale-widget] pricing fetch failed; keeping ${engine.source}: ${message}`,
      );
      return { updated: false, error: message };
    }
  }

  return {
    engine,
    cacheDir,
    cacheFile,
    metaFile,
    get status() {
      return {
        pricingSource: engine.source,
        currency: engine.currency,
        modelCount: engine.modelCount,
        cacheFile,
        cacheUpdatedAt,
        lastAttemptDate: meta.lastAttemptDate ?? null,
        lastAttemptAt: meta.lastAttemptAt ?? null,
        lastSuccessAt: meta.lastSuccessAt ?? null,
        lastFailureAt: meta.lastFailureAt ?? null,
        lastError: meta.lastError ?? null,
      };
    },
    refresh,
  };
}

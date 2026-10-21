/**
 * Chinese statutory holiday calendar with a daily, cached refresh.
 *
 * Source: https://github.com/NateScarlet/holiday-cn
 * Format: { year, days: [{ date, isOffDay, name? }] }
 *
 * The initial map is built from bundled 2024-2026 files and any local cache.
 * Network refresh runs in the background at most once per Beijing day, and
 * only fetches a year when its cache is missing (current year) or when the
 * current month is November/December (next year). A 404/failure keeps the
 * bundled/cache data.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beijingDateKey,
  beijingParts,
} from './time.js';
import {
  readJsonFile,
  resolveCacheRoot,
  writeJsonFile,
} from './cache.js';

const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'holidays');
const HOLIDAY_URL = (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`;
const FETCH_TIMEOUT_MS = 15_000;

function parseHolidayYear(data, expectedYear) {
  if (!data || typeof data !== 'object') throw new Error('holiday data is not an object');
  const year = Number(data.year);
  if (Number.isSafeInteger(year) && year !== expectedYear) {
    throw new Error(`holiday year mismatch: expected ${expectedYear}, got ${year}`);
  }
  const days = new Map();
  for (const day of Array.isArray(data.days) ? data.days : []) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day.date)) continue;
    if (typeof day.isOffDay !== 'boolean') continue;
    if (day.date.slice(0, 4) !== String(expectedYear)) continue;
    days.set(day.date, day.isOffDay);
  }
  if (days.size === 0) throw new Error(`holiday data for ${expectedYear} contains no valid days`);
  return days;
}

function daysToArray(days) {
  return [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, isOffDay]) => ({ date, isOffDay }));
}

async function readYearFile(file, expectedYear, source) {
  const data = await readJsonFile(file);
  if (data === undefined) return undefined;
  try {
    return {
      year: expectedYear,
      days: parseHolidayYear(data, expectedYear),
      source,
      file,
    };
  } catch (error) {
    return undefined;
  }
}

async function readYearDirectory(directory, source) {
  const result = new Map();
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    return result;
  }
  for (const file of files) {
    const match = /^(\d{4})\.json$/u.exec(file);
    if (!match) continue;
    const year = Number(match[1]);
    const entry = await readYearFile(path.join(directory, file), year, source);
    if (entry) result.set(year, entry);
  }
  return result;
}

async function fetchHolidayYear(year) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(HOLIDAY_URL(year), {
      headers: {
        'user-agent': 'dsh-whale-widget/1.0 (+https://github.com/NateScarlet/holiday-cn)',
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (response.status === 404) throw new Error(`HTTP 404 (${year} not published)`);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const data = await response.json();
    return { data, days: parseHolidayYear(data, year) };
  } finally {
    clearTimeout(timer);
  }
}

export async function createHolidayService(options = {}) {
  const cacheDir = options.cacheDir ?? resolveCacheRoot();
  const cacheYearDir = path.join(cacheDir, 'holidays');
  const metaFile = path.join(cacheDir, 'holiday-meta.json');
  const builtin = await readYearDirectory(BUILTIN_DIR, 'builtin');
  const cached = await readYearDirectory(cacheYearDir, 'cache');
  const years = new Map([...builtin, ...cached]);
  let meta = (await readJsonFile(metaFile)) ?? {};
  const map = new Map();

  function rebuildMap() {
    map.clear();
    for (const entry of years.values()) {
      for (const [date, isOffDay] of entry.days) map.set(date, isOffDay);
    }
  }

  rebuildMap();

  function status() {
    return {
      cacheDir,
      cacheYearDir,
      metaFile,
      lastCheckDate: meta.lastCheckDate ?? null,
      lastCheckAt: meta.lastCheckAt ?? null,
      lastSuccessAt: meta.lastSuccessAt ?? null,
      lastFailureAt: meta.lastFailureAt ?? null,
      lastError: meta.lastError ?? null,
      holidayDays: map.size,
      years: [...years.entries()]
        .sort(([left], [right]) => left - right)
        .map(([year, entry]) => ({
          year,
          source: entry.source,
          days: entry.days.size,
          file: entry.file,
        })),
    };
  }

  async function refresh() {
    const now = Date.now();
    const today = beijingDateKey(now);
    const parts = beijingParts(now);
    if (meta.lastCheckDate === today) return { skipped: 'daily-limit' };

    const targets = [];
    if (years.get(parts.year)?.source !== 'cache') targets.push(parts.year);
    if (parts.month >= 11 && years.get(parts.year + 1)?.source !== 'cache') {
      targets.push(parts.year + 1);
    }

    meta = {
      ...meta,
      lastCheckDate: today,
      lastCheckAt: new Date(now).toISOString(),
    };
    try {
      await writeJsonFile(metaFile, meta);
    } catch (error) {
      console.warn(`[dsh-whale-widget] holiday meta write failed: ${error.message}`);
    }

    if (targets.length === 0) return { updated: [], skipped: 'cache-complete' };

    let updated = 0;
    let failure = null;
    for (const year of targets) {
      try {
        const result = await fetchHolidayYear(year);
        const file = path.join(cacheYearDir, `${year}.json`);
        await writeJsonFile(file, {
          year,
          source: HOLIDAY_URL(year),
          fetchedAt: new Date().toISOString(),
          days: daysToArray(result.days),
        });
        years.set(year, {
          year,
          days: result.days,
          source: 'network',
          file,
        });
        updated += 1;
        console.log(
          `[dsh-whale-widget] holidays updated year=${year} days=${result.days.size} cache=${file}`,
        );
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        console.warn(`[dsh-whale-widget] holiday fetch failed year=${year}: ${failure}`);
      }
    }

    if (updated > 0) {
      rebuildMap();
      meta = {
        ...meta,
        lastSuccessAt: new Date().toISOString(),
        lastError: failure,
      };
    } else if (failure !== null) {
      meta = {
        ...meta,
        lastFailureAt: new Date().toISOString(),
        lastError: failure,
      };
    }

    try {
      await writeJsonFile(metaFile, meta);
    } catch (error) {
      console.warn(`[dsh-whale-widget] holiday meta write failed: ${error.message}`);
    }

    return { updated, failed: failure, years: status().years };
  }

  return {
    cacheDir,
    cacheYearDir,
    metaFile,
    get map() { return map; },
    get status() { return status(); },
    refresh,
  };
}

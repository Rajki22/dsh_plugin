/**
 * Shared Beijing-time helpers.
 *
 * Session logs may store epoch milliseconds, ISO strings with an offset, or
 * naive ISO strings. All historical classification uses this one conversion
 * so the pricing, holiday and breakdown code cannot drift apart.
 */

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function toEpochMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/iu.test(text);
  const normalized = text.includes('T') ? text : text.replace(/\s+/u, 'T');
  const parsed = Date.parse(hasZone ? normalized : `${normalized}+08:00`);
  if (Number.isFinite(parsed)) return parsed;
  const fallback = Date.parse(normalized);
  return Number.isFinite(fallback) ? fallback : null;
}

export function beijingParts(time = Date.now()) {
  const date = new Date(time + BEIJING_OFFSET_MS);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    hours: date.getUTCHours(),
    minutes: date.getUTCMinutes(),
  };
}

export function beijingDateKey(time = Date.now()) {
  const parts = beijingParts(time);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function toBeijingIso(epochMs) {
  return new Date(epochMs + BEIJING_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

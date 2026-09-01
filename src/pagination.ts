/**
 * Cursor-based pagination (Item 9).
 *
 * Every list endpoint returns `{ items, nextCursor }`. The cursor is an opaque
 * base64url token of the last row's sort key `(sortValue, id)`. Cursor keysets
 * are stable as rows are inserted (unlike OFFSET, which shifts). Callers page by
 * passing `cursor` back; `nextCursor` is null on the last page.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export function clampLimit(n: unknown): number {
  const x = Math.trunc(Number(n));
  return Number.isFinite(x) && x > 0 ? Math.min(x, MAX_LIMIT) : DEFAULT_LIMIT;
}

/** Format a sort value for the cursor: datetimes as 'YYYY-MM-DD HH:MM:SS' (UTC). */
function fmt(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v);
}

export function encodeCursor(sortValue: unknown, id: number | string): string {
  return Buffer.from(`${fmt(sortValue)}|${id}`).toString('base64url');
}

export interface DecodedCursor {
  sortValue: string; // datetime string, or a numeric id as a string
  id: number;
}

export function decodeCursor(cursor?: string | null): DecodedCursor | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i < 0) return null;
    const sortValue = s.slice(0, i);
    const id = Number(s.slice(i + 1));
    if (!sortValue || !Number.isFinite(id)) return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

/**
 * Given rows fetched with LIMIT (limit + 1) and a function that builds a row's
 * cursor, return the page: at most `limit` items and a nextCursor if there were
 * more.
 */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    return { items, nextCursor: cursorOf(items[items.length - 1]) };
  }
  return { items: rows, nextCursor: null };
}

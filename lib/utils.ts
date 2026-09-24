export function isValidYear(year: number | null | undefined): boolean {
  if (year == null) return false;
  return year >= 1900 && year <= new Date().getFullYear() + 1;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeText(s: string, maxLength = 100): string {
  return s
    .replace(/[&<>"']/g, (c) => HTML_ESCAPE[c] ?? c)
    .trim()
    .slice(0, maxLength);
}

const HTML_UNESCAPE = Object.fromEntries(Object.entries(HTML_ESCAPE).map(([c, e]) => [e, c]));

/**
 * Inverse of sanitizeText's escaping, applied until stable (saved playlists can arrive escaped
 * twice). Graders must compare decoded text: normLatin would turn "&#39;" into "39".
 */
export function decodeEntities(s: string): string {
  let t = s;
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(/&(amp|lt|gt|quot|#39);/g, (e) => HTML_UNESCAPE[e]); }
  return t;
}

/** Fisher-Yates shuffle, returns a new array. Was duplicated inline as
 * `.sort(() => Math.random() - 0.5)` in 4 places in party/index.ts (ponytail-audit finding). */
export function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — the "window of
 * Promise.allSettled" concurrency limiter that was hand-rolled independently in
 * ai-metadata.ts, lyrics-resolver.ts, and lyrics-popularity.ts (ponytail-audit finding).
 * `onWindow`, when given, fires after each window settles with just that window's results —
 * needed by callers with progressive/streaming UI updates (onBatchDone-style callbacks) that
 * a single "wait for everything, then return" shape can't support.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onWindow?: (results: PromiseSettledResult<R>[], window: readonly T[]) => void
): Promise<PromiseSettledResult<R>[]> {
  const all: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const window = items.slice(i, i + limit);
    const results = await Promise.allSettled(window.map(fn));
    onWindow?.(results, window);
    all.push(...results);
  }
  return all;
}

/** A YouTube video id: exactly 11 of A-Z a-z 0-9 _ -. Anything else must never reach the player. */
export function isValidVideoId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

export function isValidYear(year: number | null | undefined): boolean {
  if (year == null) return false;
  return year >= 1900 && year <= new Date().getFullYear() + 1;
}

const HTML_ESCAPE: Record<string, string> = { // only for decoding legacy text, see decodeEntities
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Trims and caps host/player text. No HTML escaping: React escapes on render, and escaped text
 * showed on screen as "Don&#39;t". Decodes first, so text stored escaped by older versions comes out clean.
 */
export function sanitizeText(s: string, maxLength = 100): string {
  // Cut before decoding too: decodeEntities loops once per escape layer, so an unbounded hostile string costs O(n²).
  return decodeEntities(s.slice(0, maxLength * 6)).trim().slice(0, maxLength);
}

const HTML_UNESCAPE = Object.fromEntries(Object.entries(HTML_ESCAPE).map(([c, e]) => [e, c]));

/**
 * Undoes the HTML escaping older versions stored, applied until stable (it could be escaped
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
 * `onWindow` fires after each window settles with just that window's results — every caller
 * folds results in progressively (onBatchDone-style callbacks), so nothing is collected or returned.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onWindow: (results: PromiseSettledResult<R>[], window: readonly T[]) => void
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    const window = items.slice(i, i + limit);
    onWindow(await Promise.allSettled(window.map(fn)), window);
  }
}

// Structured outputs (output_config.format): the response is {"items": [...]}, one object per
// item matching `item`. Schemas need an object root, hence the wrapper.
export function itemsSchema(item: Record<string, unknown>) {
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: { items: { type: "array", items: { type: "object", additionalProperties: false, ...item } } },
      required: ["items"],
      additionalProperties: false,
    },
  };
}

/** The items of an itemsSchema response. Untyped: each caller validates its own item shape. Throws on malformed JSON. */
export function parseItems(text: string): unknown[] {
  const items = (JSON.parse(text) as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

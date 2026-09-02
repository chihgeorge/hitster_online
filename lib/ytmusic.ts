// YouTube Music InnerTube API — unofficial, no API key required.
import { isValidYear } from "./utils";
// Uses the WEB_REMIX client that the YouTube Music web app uses.
// Two-step process: search for the track to get an album browseId,
// then browse the album to extract the release year from its subtitle.

const YTM_BASE = "https://music.youtube.com/youtubei/v1";

// Protobuf filter param for "songs only" results in YTM search
const SONGS_FILTER = "EgWKAQIIAWoKEAMQBBAJEAoQBQ==";

function ytmContext() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    client: { clientName: "WEB_REMIX", clientVersion: `1.${date}.01.00` },
    user: {},
  };
}

const YTM_HEADERS = {
  "Content-Type": "application/json",
  "Origin": "https://music.youtube.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0",
};

/**
 * Looks up the release year for a track using YouTube Music's internal search API.
 * Searches for the track by artist+name, finds the album/single browseId,
 * then fetches the album page to read the release year from the subtitle.
 *
 * Returns null if no confident match is found.
 * The year returned is the music release year (from YTM's music catalog metadata),
 * not the YouTube upload date.
 *
 * Note: YTM search always returns a "closest match" — we require the result's
 * artist or title text to share at least one token with the query to avoid
 * returning completely unrelated years for unrecognised tracks.
 */
export async function lookupYearFromYTMusic(
  artist: string,
  track: string
): Promise<number | null> {
  // Try artist+track first, then track alone (handles name format mismatches)
  const queries = [`${track} ${artist}`, track];
  for (const query of queries) {
    const result = await searchForAlbumBrowseId(query);
    if (!result) continue;
    // Confidence guard: require the search result's visible text to share at
    // least one non-trivial token with our query, so a "closest match" for a
    // completely unrecognised track doesn't silently poison the year.
    if (!isConfidentMatch(query, result.resultText)) continue;
    const year = await browseAlbumForYear(result.browseId);
    if (year) return year;
  }
  return null;
}

/** Returns true if result text shares at least one CJK character or Latin word (≥3 chars) with query. */
function isConfidentMatch(query: string, resultText: string): boolean {
  const normalise = (s: string) => s.toLowerCase().replace(/[^\w　-鿿]/g, " ");
  const qTokens = normalise(query).split(/\s+/).filter((t) => t.length >= 3);
  const rTokens = new Set(normalise(resultText).split(/\s+/).filter((t) => t.length >= 2));

  // CJK character overlap: if query has CJK and result has same CJK characters
  const cjkQuery = query.match(/[　-鿿]/g)?.join("") ?? "";
  const cjkResult = resultText.match(/[　-鿿]/g)?.join("") ?? "";
  if (cjkQuery && cjkResult) {
    for (const ch of cjkQuery) {
      if (cjkResult.includes(ch)) return true;
    }
  }

  // Latin token overlap
  for (const token of qTokens) {
    if (rTokens.has(token)) return true;
  }

  return false;
}

async function searchForAlbumBrowseId(
  query: string
): Promise<{ browseId: string; resultText: string } | null> {
  let res: Response;
  try {
    res = await fetch(`${YTM_BASE}/search?alt=json`, {
      method: "POST",
      headers: YTM_HEADERS,
      body: JSON.stringify({
        query,
        params: SONGS_FILTER,
        context: ytmContext(),
      }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json()) as unknown;

  // Walk the response tree looking for the first musicResponsiveListItemRenderer
  // with an album/single browseId (starts with MPRE) in its flex column runs.
  const item = findFirstMrlir(data);
  if (!item) return null;

  const o = item as Record<string, unknown>;
  const cols = (o.flexColumns as unknown[] | undefined) ?? [];
  if (cols.length < 2) return null;

  // col0 has the track title text; col1 has artist/album runs with browseId.
  const titleText = extractColText(cols[0]);

  const col1 = cols[1] as Record<string, unknown>;
  const mrlfc = col1.musicResponsiveListItemFlexColumnRenderer as
    | Record<string, unknown>
    | undefined;
  const textRuns = (mrlfc?.text as Record<string, unknown> | undefined)
    ?.runs as unknown[] | undefined ?? [];

  const artistText = textRuns
    .map((r) => ((r as Record<string, unknown>).text as string | undefined) ?? "")
    .join(" ");

  for (const run of textRuns) {
    const r = run as Record<string, unknown>;
    const id = (
      (r.navigationEndpoint as Record<string, unknown> | undefined)
        ?.browseEndpoint as Record<string, unknown> | undefined
    )?.browseId as string | undefined;
    if (id?.startsWith("MPRE")) {
      return { browseId: id, resultText: `${titleText} ${artistText}`.trim() };
    }
  }

  return null;
}

function extractColText(col: unknown): string {
  const c = col as Record<string, unknown> | undefined;
  const mrlfc = c?.musicResponsiveListItemFlexColumnRenderer as
    | Record<string, unknown>
    | undefined;
  const runs = (mrlfc?.text as Record<string, unknown> | undefined)
    ?.runs as unknown[] | undefined ?? [];
  return runs
    .map((r) => ((r as Record<string, unknown>).text as string | undefined) ?? "")
    .join("");
}

async function browseAlbumForYear(browseId: string): Promise<number | null> {
  let res: Response;
  try {
    res = await fetch(`${YTM_BASE}/browse?alt=json`, {
      method: "POST",
      headers: YTM_HEADERS,
      body: JSON.stringify({ browseId, context: ytmContext() }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json()) as unknown;
  return extractYearFromSubtitle(data);
}

/** Recursively finds the first musicResponsiveListItemRenderer in the tree. */
function findFirstMrlir(
  obj: unknown,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 15 || obj === null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = findFirstMrlir(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  if ("musicResponsiveListItemRenderer" in o) {
    return o.musicResponsiveListItemRenderer as Record<string, unknown>;
  }
  for (const val of Object.values(o)) {
    const r = findFirstMrlir(val, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Recursively searches for a subtitle containing a 4-digit year run. */
function extractYearFromSubtitle(obj: unknown, depth = 0): number | null {
  if (depth > 15 || obj === null || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const y = extractYearFromSubtitle(item, depth + 1);
      if (y) return y;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  if ("subtitle" in o) {
    const subtitle = o.subtitle as Record<string, unknown> | undefined;
    const runs = subtitle?.runs as unknown[] | undefined;
    if (runs) {
      for (const run of runs) {
        const text = ((run as Record<string, unknown>).text as string ?? "").trim();
        if (/^\d{4}$/.test(text)) {
          const y = parseInt(text, 10);
          if (isValidYear(y)) return y;
        }
      }
    }
  }
  for (const val of Object.values(o)) {
    const y = extractYearFromSubtitle(val, depth + 1);
    if (y) return y;
  }
  return null;
}

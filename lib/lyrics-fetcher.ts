// Fetches real lyrics from lrclib.net (free, no API key required).
// Returns plaintext lyrics on hit, null on miss. Used by lyrics-resolver.ts
// to ground Claude in actual song text rather than generated/hallucinated lyrics.

const LRCLIB_BASE = "https://lrclib.net/api";

type LrclibTrack = {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

/**
 * Score how well a lrclib result matches the query title+artist.
 * Higher = better match.
 */
function matchScore(result: LrclibTrack, title: string, artist: string): number {
  const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const rt = norm(result.trackName);
  const ra = norm(result.artistName);
  const qt = norm(title);
  const qa = norm(artist);

  // Require at minimum a partial title match — prevents wrong-artist tracks from
  // scoring via lyrics bonus alone (e.g. score=3: partial artist +1, lyrics +2).
  if (rt !== qt && !rt.includes(qt) && !qt.includes(rt)) return 0;

  let score = 0;
  if (rt === qt) score += 4;
  else score += 2;

  if (ra === qa) score += 3;
  else if (ra.includes(qa) || qa.includes(ra)) score += 1;

  // Prefer entries that have actual lyrics
  if (result.plainLyrics && result.plainLyrics.length > 100) score += 2;

  return score;
}

/**
 * Fetch lyrics for a single song. Returns the plain-text lyrics string, or
 * null if nothing useful was found (no hit, or hit with empty lyrics).
 */
export async function fetchLyrics(title: string, artist: string): Promise<string | null> {
  const timeout = () =>
    typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(4000) : undefined;

  // Try exact-ish get first (faster, uses internal matching)
  try {
    const getUrl = `${LRCLIB_BASE}/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
    const getRes = await fetch(getUrl, { signal: timeout() });
    if (getRes.ok) {
      const data = (await getRes.json()) as LrclibTrack;
      if (data.plainLyrics && data.plainLyrics.length > 100) {
        return data.plainLyrics;
      }
    }
  } catch {
    // timeout or parse error — fall through to search
  }

  // Fall back to search (handles name variations, CJK alternate spellings)
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const searchRes = await fetch(`${LRCLIB_BASE}/search?q=${q}`, { signal: timeout() });
    if (!searchRes.ok) return null;

    const results = (await searchRes.json()) as LrclibTrack[];
    if (!Array.isArray(results) || results.length === 0) return null;

    const scored = results
      .map((r) => ({ r, score: matchScore(r, title, artist) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (best.score >= 3 && best.r.plainLyrics && best.r.plainLyrics.length > 100) {
      return best.r.plainLyrics;
    }
  } catch {
    // network error or timeout
  }

  return null;
}

/**
 * Batch-fetch lyrics for up to `concurrency` tracks in parallel.
 * Returns a map of videoId → lyrics string (only hits are included).
 */
export async function fetchLyricsBatch(
  tracks: { videoId: string; title: string; artist: string }[],
  concurrency = 5
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (tracks.length === 0) return result;

  for (let i = 0; i < tracks.length; i += concurrency) {
    const window = tracks.slice(i, i + concurrency);
    const fetched = await Promise.allSettled(
      window.map(async (t) => {
        const lyrics = await fetchLyrics(t.title, t.artist);
        return { videoId: t.videoId, lyrics };
      })
    );
    for (const r of fetched) {
      if (r.status === "fulfilled" && r.value.lyrics) {
        result.set(r.value.videoId, r.value.lyrics);
      }
    }
  }

  return result;
}

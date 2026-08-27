// Spotify Web API client — server-side only (client credentials flow).
// Used exclusively to look up song release years. No user login required.

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";

// Thrown when Spotify returns 429 on both the original request AND the retry.
// Callers can catch this to skip all remaining Spotify lookups for the session.
export class SpotifyRateLimitedError extends Error {
  constructor() { super("SPOTIFY_RATE_LIMITED"); }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(clientId?: string, clientSecret?: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const id = clientId ?? process.env.SPOTIFY_CLIENT_ID;
  const secret = clientSecret ?? process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set");
  // reassign for use below
  clientId = id;
  clientSecret = secret;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) throw new Error(`Spotify token error: ${res.status}`);

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

/**
 * Strips common YouTube title suffixes that confuse Spotify search.
 * E.g. "Blinding Lights (Official Video)" → "Blinding Lights"
 */
function normalizeForSpotify(title: string): string {
  return title
    // remove parenthetical/bracketed suffixes: (Official Video), [Lyrics], (feat. X), etc.
    .replace(/\s*[\[(][^\])]*[\])]/gi, "")
    // remove "- Official Video", "- Live at X", "- Remastered 2015" style suffixes
    .replace(/\s*[-–]\s*(official|audio|video|lyric|lyrics|live|remaster|remastered|hd|4k|mv|feat\.?|ft\.?)(\s+.*)?$/gi, "")
    .trim();
}

/**
 * Looks up the release year for a song using the Spotify search API.
 * Tries multiple query strategies from most to least specific.
 * Prefers singles/albums over compilations to get the original release year.
 * Returns null if no match is found.
 */
export async function lookupReleaseYear(
  artist: string,
  track: string,
  clientId?: string,
  clientSecret?: string
): Promise<number | null> {
  const token = await getAccessToken(clientId, clientSecret);
  const normalizedTrack = normalizeForSpotify(track);

  return (
    // 1. Field-filtered: most precise
    (await searchSpotify(token, `artist:${artist} track:${normalizedTrack}`)) ??
    // 2. Free-text artist + normalized track: handles slight name mismatches
    (await searchSpotify(token, `${normalizedTrack} ${artist}`)) ??
    // 3. Original track name + artist (in case normalization stripped something useful)
    (await searchSpotify(token, `${track} artist:${artist}`)) ??
    // 4. Normalized track only: best for unknown/mismatched artists
    (await searchSpotify(token, normalizedTrack)) ??
    // 5. Original track only: last resort
    (await searchSpotify(token, track))
  );
}

async function searchSpotify(token: string, query: string): Promise<number | null> {
  const params = new URLSearchParams({ q: query, type: "track", limit: "10" });

  let res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) {
    // Cap the Retry-After wait at 3 s. If Spotify is heavily throttled a longer
    // wait won't help — we'll detect the persistent 429 and bail the whole session.
    const retryAfterSecs = Math.min(parseInt(res.headers.get("Retry-After") ?? "2", 10), 3);
    await new Promise((r) => setTimeout(r, retryAfterSecs * 1000));
    res = await fetch(`${SEARCH_URL}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // Retry is still rate-limited — Spotify has banned this app temporarily.
    // Throw so callers can skip all further Spotify lookups for this session.
    if (res.status === 429) throw new SpotifyRateLimitedError();
  }

  if (!res.ok) return null;

  const data = (await res.json()) as {
    tracks: {
      items: {
        album: {
          release_date: string;
          album_type: string;
        };
      }[];
    };
  };

  const items = data.tracks?.items ?? [];
  if (items.length === 0) return null;

  // From singles/albums pick the earliest release year — most likely the original.
  // Fall back to compilations only if nothing else matches.
  const nonCompilation = items.filter(
    (t) => t.album.album_type === "single" || t.album.album_type === "album"
  );
  const candidates = nonCompilation.length > 0 ? nonCompilation : items;

  let earliest: number | null = null;
  for (const item of candidates) {
    const y = parseInt(item.album.release_date.slice(0, 4), 10);
    if (!isNaN(y) && (earliest === null || y < earliest)) earliest = y;
  }
  return earliest;
}


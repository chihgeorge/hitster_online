// Spotify Web API client — server-side only (client credentials flow).
// Used exclusively to look up song release years. No user login required.

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set");

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
 * Looks up the release year for a song using the Spotify search API.
 * Tries artist+track query first; falls back to track-only for non-English titles.
 * Prefers singles/albums over compilations to get the original release year.
 * Returns null if no match is found.
 */
export async function lookupReleaseYear(
  artist: string,
  track: string
): Promise<number | null> {
  const token = await getAccessToken();
  return (
    (await searchSpotify(token, `${track} artist:${artist}`)) ??
    (await searchSpotify(token, track))
  );
}

async function searchSpotify(token: string, query: string): Promise<number | null> {
  const params = new URLSearchParams({ q: query, type: "track", limit: "5" });

  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 429) throw new Error("RATE_LIMITED");
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

  // Prefer singles/albums over compilations — more likely to be the original release
  const preferred = items.find(
    (t) => t.album.album_type === "single" || t.album.album_type === "album"
  ) ?? items[0];

  const yearStr = preferred.album.release_date.slice(0, 4);
  const year = parseInt(yearStr, 10);
  return isNaN(year) ? null : year;
}


// iTunes Search API — used to look up song release years.
// No API key required. Free with generous rate limits.
// Docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/

const SEARCH_URL = "https://itunes.apple.com/search";

/**
 * Looks up the release year for a song via the iTunes Search API.
 * Tries two queries: "track artist", then "track" alone.
 */
export async function lookupYearFromItunes(
  artist: string,
  track: string
): Promise<number | null> {
  return (
    (await searchItunes(`${track} ${artist}`)) ??
    (await searchItunes(track))
  );
}

async function searchItunes(query: string): Promise<number | null> {
  const params = new URLSearchParams({
    term: query,
    entity: "musicTrack",
    limit: "10",
  });

  let res: Response;
  try {
    res = await fetch(`${SEARCH_URL}?${params}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = (await res.json()) as {
    resultCount: number;
    results: {
      wrapperType?: string;
      kind?: string;
      releaseDate?: string;
    }[];
  };

  const tracks = (data.results ?? []).filter(
    (t) => t.kind === "song" && t.releaseDate
  );
  if (tracks.length === 0) return null;

  // Pick the earliest release year — most likely the original, not a remaster.
  let earliest: number | null = null;
  for (const item of tracks) {
    const y = parseInt((item.releaseDate ?? "").slice(0, 4), 10);
    if (!isNaN(y) && y >= 1900 && (earliest === null || y < earliest)) {
      earliest = y;
    }
  }
  return earliest;
}

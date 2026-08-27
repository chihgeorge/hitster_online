// Google Knowledge Graph Search API — used to look up song release years.
// Reuses the same Google API key as the YouTube Data API.
// Enable "Knowledge Graph Search API" in the same Google Cloud project.

const KG_URL = "https://kgsearch.googleapis.com/v1/entities:search";

// Thrown when the KG API responds 403 (API not enabled in Google Cloud).
// Callers can catch this to skip all remaining KG lookups for the session.
export class KnowledgeGraphBlockedError extends Error {
  constructor() { super("KG_BLOCKED"); }
}

/**
 * Looks up the release year for a song via the Google Knowledge Graph.
 * The KG description field often contains "2016 single by G.E.M." which we parse.
 * Tries two queries: artist+track, then track alone.
 */
export async function lookupYearFromKnowledgeGraph(
  artist: string,
  track: string,
  apiKey: string
): Promise<number | null> {
  return (
    (await searchKG(`${track} ${artist}`, apiKey)) ??
    (await searchKG(track, apiKey))
  );
}

async function searchKG(query: string, apiKey: string): Promise<number | null> {
  const params = new URLSearchParams({
    query,
    key: apiKey,
    types: "MusicRecording",
    limit: "5",
    indent: "false",
  });

  const res = await fetch(`${KG_URL}?${params}`);
  if (!res.ok) {
    if (res.status === 403) throw new KnowledgeGraphBlockedError();
    return null;
  }

  const data = (await res.json()) as {
    itemListElement?: {
      result?: {
        description?: string;
        detailedDescription?: { articleBody?: string };
      };
      resultScore?: number;
    }[];
  };

  const items = data.itemListElement ?? [];
  const now = new Date().getFullYear() + 1;

  for (const item of items) {
    const desc = item.result?.description ?? "";
    // Most common KG format: "2016 single by G.E.M." or "1976 song by ABBA"
    const leadYear = desc.match(/^((?:19|20)\d{2})\b/);
    if (leadYear) {
      const year = parseInt(leadYear[1], 10);
      if (year >= 1900 && year <= now) return year;
    }

    // Fallback: year anywhere in the description or article body
    const body = item.result?.detailedDescription?.articleBody ?? "";
    const bodyYear = body.match(/\b((?:19|20)\d{2})\b/);
    if (bodyYear) {
      const year = parseInt(bodyYear[1], 10);
      if (year >= 1900 && year <= now) return year;
    }
  }

  return null;
}

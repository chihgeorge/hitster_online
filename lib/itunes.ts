// iTunes Search API — used to look up song release years.
import { isValidYear } from "./utils";
// No API key required. Free with generous rate limits.
// Docs: https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/

const SEARCH_URL = "https://itunes.apple.com/search";

const CJK_RE = /[一-鿿぀-ヿ가-힯㐀-䶿豈-﫿]/;

/**
 * Looks up the release year for a song via the iTunes Search API.
 * Tries multiple artist name variants (full, Latin-only, CJK-only) to handle
 * mixed-script names like "田馥甄 Hebe Tien" where iTunes may store just one script.
 * For CJK content, queries the Taiwan store (country=TW) first — it has much
 * better Mandarin/Cantonese pop coverage than the default US store, which often
 * returns wrong older songs with the same title.
 */
export interface ItunesTrackResult {
  year: number;
  title: string;
  artist: string;
}

export async function lookupYearFromItunes(
  artist: string,
  track: string
): Promise<ItunesTrackResult | null> {
  const variants = artistNameVariants(artist);
  // CJK content: try Taiwan store first (better Mandarin/Cantonese pop coverage),
  // then US store as fallback. Run all variant searches in parallel per store so
  // we don't serialize 12 sequential fetch calls (~3.6 s) into one song slot.
  const countries: (string | undefined)[] = CJK_RE.test(artist + track)
    ? ["TW", undefined]
    : [undefined];

  for (const country of countries) {
    const searches = variants.flatMap((v) => [
      searchItunes(`${track} ${v}`, v, country).catch(() => null),
      searchItunes(track, v, country).catch(() => null),
    ]);
    const results = await Promise.all(searches);
    const found = results.find((r) => r !== null) ?? null;
    if (found !== null) return found;
  }

  return null;
}



/**
 * Returns search variants for an artist name.
 * For mixed CJK/Latin names (e.g. "田馥甄 Hebe Tien"), also tries the
 * Latin-only ("Hebe Tien") and CJK-only ("田馥甄") parts separately.
 */
function artistNameVariants(name: string): string[] {
  const variants: string[] = [name];

  // Latin-only part (strip CJK characters)
  const latin = name
    .replace(/[一-鿿぀-ヿ가-힯㐀-䶿豈-﫿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (latin && latin !== name && latin.length >= 2) variants.push(latin);

  // CJK-only part (strip Latin/ASCII)
  const cjk = name.replace(/[a-zA-Z0-9\s.\-'!?,]/g, "").trim();
  if (cjk && cjk !== name && cjk.length >= 2) variants.push(cjk);

  // Deduplicate while preserving order
  return [...new Set(variants)];
}

async function searchItunes(query: string, artistHint: string, country?: string): Promise<ItunesTrackResult | null> {
  const paramsObj: Record<string, string> = {
    term: query,
    entity: "musicTrack",
    limit: "25",
  };
  if (country) paramsObj.country = country;
  const params = new URLSearchParams(paramsObj);

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
      trackName?: string;
      artistName?: string;
      releaseDate?: string;
    }[];
  };

  const tracks = (data.results ?? []).filter(
    (t) => t.kind === "song" && t.releaseDate
  );
  if (tracks.length === 0) return null;

  // Normalise for fuzzy artist matching — strips punctuation, lowercases, keeps CJK.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9一-鿿぀-ヿ가-힯]/g, "");

  const artistKey = norm(artistHint);

  // Prefer tracks whose artist name matches the input artist.
  // Ratio guard: the shorter name must cover ≥60% of the longer to avoid
  // "may" matching "mayday" or "jackson" matching "michaeljackson".
  const artistMatched = artistKey
    ? tracks.filter((t) => {
        const a = norm(t.artistName ?? "");
        if (!a) return false;
        const longer = Math.max(a.length, artistKey.length);
        const shorter = Math.min(a.length, artistKey.length);
        if (shorter / longer < 0.6) return false;
        return a.includes(artistKey) || artistKey.includes(a);
      })
    : [];
  const candidates = artistMatched.length > 0 ? artistMatched : tracks;

  // Count occurrences of each release year across candidates; track a representative item per year.
  const votes = new Map<number, number>();
  const repItem = new Map<number, (typeof tracks)[0]>();
  for (const item of candidates) {
    const y = parseInt((item.releaseDate ?? "").slice(0, 4), 10);
    if (!isNaN(y) && isValidYear(y)) {
      votes.set(y, (votes.get(y) ?? 0) + 1);
      if (!repItem.has(y)) repItem.set(y, item);
    }
  }
  if (votes.size === 0) return null;

  // Prefer the earliest year that appears in at least 2 tracks —
  // this skips single-occurrence mislabelled compilations without
  // over-correcting toward a later re-release edition.
  const sortedYears = [...votes.keys()].sort((a, b) => a - b);
  const confirmedEarliest = sortedYears.find((y) => (votes.get(y) ?? 0) >= 2);
  // When we got an artist match, a single-vote year is trustworthy (it's that
  // exact artist's song). Without an artist match we're working with noisy
  // unfiltered results — require ≥2 votes to avoid wrong years from unrelated
  // songs that share the same title (common with short CJK track names).
  const chosenYear = confirmedEarliest ?? (artistMatched.length > 0 ? sortedYears[0] : null);
  if (chosenYear === null) return null;

  const rep = repItem.get(chosenYear);
  return {
    year: chosenYear,
    title: rep?.trackName ?? query,
    artist: rep?.artistName ?? artistHint,
  };
}

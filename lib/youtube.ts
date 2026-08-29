// YouTube Data API v3 client — server-side only (uses YOUTUBE_API_KEY env var).
// Fetches playlist items and returns video metadata.

export interface YouTubeTrack {
  videoId: string;
  title: string;
  description: string;
  channelTitle: string;
}

const BASE = "https://www.googleapis.com/youtube/v3";

/**
 * Fetches all video items from a YouTube playlist.
 * Handles pagination automatically (up to 200 items).
 */
export async function fetchPlaylistItems(
  playlistId: string,
  apiKey?: string
): Promise<YouTubeTrack[]> {
  const key = apiKey ?? process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error("YOUTUBE_API_KEY is not set");

  const tracks: YouTubeTrack[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      part: "snippet",
      playlistId,
      maxResults: "50",
      key,
      ...(pageToken ? { pageToken } : {}),
    });

    const res = await fetch(`${BASE}/playlistItems?${params}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Quota exhausted
      if ((err as { error?: { errors?: { reason?: string }[] } }).error?.errors?.[0]?.reason === "quotaExceeded") {
        throw new Error("QUOTA_EXCEEDED");
      }
      throw new Error(`YouTube API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      nextPageToken?: string;
      items: {
        snippet: {
          resourceId: { videoId: string };
          title: string;
          description: string;
          videoOwnerChannelTitle?: string;
        };
      }[];
    };

    for (const item of data.items) {
      const { videoId } = item.snippet.resourceId;
      if (videoId && item.snippet.title !== "Deleted video" && item.snippet.title !== "Private video") {
        tracks.push({
          videoId,
          title: item.snippet.title,
          description: item.snippet.description ?? "",
          channelTitle: item.snippet.videoOwnerChannelTitle ?? "",
        });
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken && tracks.length < 200);

  return tracks;
}

/**
 * Parses "Artist - Track" format from a YouTube video title.
 * Returns null if the format can't be detected.
 */
export function parseArtistAndTrack(
  title: string
): { artist: string; track: string } | null {
  // Strip trailing year like "(1980)" or "[1980]"
  const s = title.replace(/\s*[\[(]\d{4}[\])]\s*$/, "").trim();

  // 1. Non-leading 【Track】 — artist precedes the bracket.
  //    Only used when 【 appears BEFORE any 《 (otherwise 《》 is the song title
  //    and 【】 is a trailing movie/show context marker).
  //    "G.E.M.【光年之外 LIGHT YEARS AWAY】MV" → artist=G.E.M., track=光年之外…
  //    "周杰倫 Jay Chou (特別演出…)【告白氣球 Love Confession】Official MV"
  //    "高爾宣 OSN -【Without You】沒了妳"
  const fullBracketStart = s.indexOf("【");
  const chevronCheck = s.indexOf("《");
  if (fullBracketStart > 0 && (chevronCheck === -1 || chevronCheck > fullBracketStart)) {
    const fullBracketEnd = s.indexOf("】", fullBracketStart);
    if (fullBracketEnd !== -1) {
      const track = s.slice(fullBracketStart + 1, fullBracketEnd).trim();
      const artistRaw = s
        .slice(0, fullBracketStart)
        .replace(/\s*[-–—]\s*$/, "") // strip trailing dash connector
        .trim();
      const artist = cleanArtistName(artistRaw);
      if (artist && track) return { artist, track: cleanTrackSuffixes(track) };
    }
  }

  // 2. Leading 【movie/show context】 — strip it and reparse the remainder
  //    "【我的少女時代 Our Times】Movie Theme Song - 田馥甄 Hebe Tien《小幸運》Official MV"
  if (s.startsWith("【")) {
    const contextEnd = s.indexOf("】");
    if (contextEnd !== -1) {
      const rest = s
        .slice(contextEnd + 1)
        .replace(/^[^《【]*[-–—]\s*/, "") // strip "Movie Theme Song - " connectors
        .trim();
      if (rest) return parseArtistAndTrack(rest);
    }
  }

  // 3. 《Track》 — artist precedes the bracket
  //    "于文文《體面》動態歌詞版" → artist=于文文, track=體面
  //    "Eric周興哲《你，好不好？ How Have You Been?》Official Music Video"
  const chevronStart = s.indexOf("《");
  if (chevronStart !== -1) {
    const chevronEnd = s.indexOf("》", chevronStart);
    if (chevronEnd !== -1) {
      const track = s.slice(chevronStart + 1, chevronEnd).trim();
      const artistRaw = s.slice(0, chevronStart).trim();
      const artist = cleanArtistName(artistRaw);
      if (artist && track) return { artist, track: cleanTrackSuffixes(track) };
    }
  }

  // 4. Artist [ Track ] with spaced English brackets
  //    "MP魔幻力量 [ 我還是愛著你 I still love you ] Official Music Video"
  const spaceBracket = s.match(/^(.*?)\s+\[\s+(.+?)\s+\]/);
  if (spaceBracket) {
    const artist = cleanArtistName(spaceBracket[1]);
    const track = cleanTrackSuffixes(spaceBracket[2]);
    if (artist && track) return { artist, track };
  }

  // 5. Standard "Artist - Track" dash format
  const dashMatch = s.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    const artist = cleanArtistName(dashMatch[1]);
    const track = cleanTrackSuffixes(dashMatch[2]);
    if (artist && track) return { artist, track };
  }

  return null;
}

function cleanArtistName(raw: string): string {
  return raw
    .replace(/\s*[\(（][^)）]*[\)）]\s*$/g, "") // strip trailing (featuring info)
    .replace(/\s*（[^）]*）\s*$/g, "")
    .replace(/\s+(?:Ft\.|Feat\.|ft\.|feat\.|X|x)\s+.*$/i, "") // strip "X feat. Y" → "X"
    .trim();
}

function cleanTrackSuffixes(raw: string): string {
  return raw
    .replace(/\s*[\[(](?:official|video|audio|lyric|lyrics|hd|4k|mv|feat|ft\.?)[^\])]*[\])]?/gi, "")
    .trim();
}

/**
 * Parses metadata from a YouTube Music description.
 * YouTube Music descriptions contain structured lines like:
 *   "Provided to YouTube by ..."
 *   "Artist: Name"
 *   "Released on: YYYY-MM-DD"
 *   "℗ YYYY Label"
 */
export function parseYouTubeMusicDescription(description: string): {
  artist?: string;
  year?: number;
} {
  const result: { artist?: string; year?: number } = {};

  const MAX_YEAR = new Date().getFullYear() + 1;
  const releasedMatch = description.match(/Released on:\s*(\d{4})/);
  if (releasedMatch) {
    const y = parseInt(releasedMatch[1], 10);
    if (y >= 1900 && y <= MAX_YEAR) result.year = y;
  }

  if (!result.year) {
    const copyrightMatch = description.match(/℗\s*(\d{4})/);
    if (copyrightMatch) {
      const y = parseInt(copyrightMatch[1], 10);
      if (y >= 1900 && y <= MAX_YEAR) result.year = y;
    }
  }

  const artistLineMatch = description.match(/^Artist:\s*(.+)$/m);
  if (artistLineMatch) result.artist = artistLineMatch[1].trim();

  if (!result.artist) {
    // "Song · Artist" dot-separated format
    const dotMatch = description.match(/^.+\s·\s(.+)$/m);
    if (dotMatch) {
      const parts = dotMatch[0].split("·").map((s) => s.trim());
      if (parts.length >= 2) result.artist = parts.slice(1).join(", ");
    }
  }

  return result;
}

/**
 * Extracts the first continuous run of ≥2 CJK characters from a title.
 * Used as a fallback track name when parseArtistAndTrack returns null for
 * C-pop YouTube titles like "光年之外 G.E.M. 鄧紫棋 (LIGHT YEARS AWAY) Official MV"
 * where the song name is the leading CJK phrase.
 * Returns null if no CJK run of ≥2 chars exists.
 */
export function extractCjkTrackName(title: string): string | null {
  const m = title.match(/[⺀-鿿豈-﫿가-힯]{2,}/);
  return m ? m[0] : null;
}

/**
 * Strips "Artist - Topic" suffix from YouTube auto-generated channel names.
 * e.g. "Frank Mills - Topic" → "Frank Mills"
 */
export function channelToArtist(channelTitle: string): string {
  return channelTitle.replace(/\s*-\s*Topic\s*$/i, "").trim();
}

/**
 * Extracts a 4-digit release year from a video title.
 * Matches patterns like "(1980)", "[1980]", or a bare year at the end.
 * Returns null if no plausible year found.
 */
export function extractYearFromTitle(title: string): number | null {
  // Prefer year in parens/brackets: "song name (1980)" or "song [1980]"
  const bracketed = title.match(/[\[(]((?:19|20)\d{2})[\])]/);
  if (bracketed) {
    const year = parseInt(bracketed[1], 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) return year;
  }

  // Fall back to bare year at end of title: "song name - artist 1980"
  const trailing = title.match(/\b((?:19|20)\d{2})\s*$/);
  if (trailing) {
    const year = parseInt(trailing[1], 10);
    if (year >= 1900 && year <= new Date().getFullYear() + 1) return year;
  }

  return null;
}

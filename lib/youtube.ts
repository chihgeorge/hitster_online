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
  playlistId: string
): Promise<YouTubeTrack[]> {
  const key = process.env.YOUTUBE_API_KEY;
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
  // Strip trailing year like "(1980)" or "[1980]" before splitting
  const stripped = title.replace(/\s*[\[(]\d{4}[\])]\s*$/, "").trim();

  // Common YouTube Music format: "Artist - Track"
  const match = stripped.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (!match) return null;

  let artist = match[1].trim();
  let track = match[2].trim();

  // Strip common suffixes like "(Official Video)", "[Lyrics]", "ft. X"
  track = track.replace(/\s*[\[(](?:official|video|audio|lyric|lyrics|hd|4k|mv|feat|ft\.?)[^\])]*/gi, "").trim();

  return { artist, track };
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

  const releasedMatch = description.match(/Released on:\s*(\d{4})/);
  if (releasedMatch) result.year = parseInt(releasedMatch[1], 10);

  if (!result.year) {
    const copyrightMatch = description.match(/℗\s*(\d{4})/);
    if (copyrightMatch) result.year = parseInt(copyrightMatch[1], 10);
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

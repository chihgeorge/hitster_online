// YouTube Data API v3 client — server-side only (uses YOUTUBE_API_KEY env var).
// Fetches playlist items and returns video metadata.

export interface YouTubeTrack {
  videoId: string;
  title: string;
  description: string;
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
  // Common YouTube Music format: "Artist - Track"
  const match = title.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (!match) return null;

  let artist = match[1].trim();
  let track = match[2].trim();

  // Strip common suffixes like "(Official Video)", "[Lyrics]", "ft. X"
  track = track.replace(/\s*[\[(](?:official|video|audio|lyric|lyrics|hd|4k|mv|feat|ft\.?)[^\])]*/gi, "").trim();

  return { artist, track };
}

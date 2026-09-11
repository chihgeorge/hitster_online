// AI-powered music metadata resolver using the Anthropic Messages API.
// Replaces the YTM + Spotify + iTunes + KG multi-pass pipeline.
// Uses claude-haiku-4-5 (fast, cheap) with no web-search for v1 — training data
// covers essentially all catalog music through mid-2025.
// Falls back gracefully: returns an empty Map on any API or parse failure.

export interface AITrackMeta {
  title: string;
  artist: string;
  year: number | null;
}

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 10;
// Max parallel batches — keeps total concurrent Anthropic connections low.
const MAX_CONCURRENT = 4;

const SYSTEM_PROMPT = `You are a music metadata expert. Given YouTube video metadata, identify the song's original title, primary artist, and release year.

Return ONLY a valid JSON array — no prose, no markdown fences — one element per video, in the same order as input:
[{"videoId":"ID","title":"Song Title","artist":"Artist Name","year":2019},...]

Rules:
- title: clean song name only. Remove suffixes like "Official MV", "(Audio)", "MV", "Official Video", "Lyric Video", "Live", "(4K)", "HD", "HQ", etc.
- artist: primary artist only. No "ft.", "feat.", or collaborators.
- year: original studio/single release year as an integer. Use your best estimate — prefer a year over null. Only use null for truly unidentifiable tracks (no artist, no recognizable song name, pure noise/ambient, etc.).
- Preserve non-Latin characters (Chinese, Japanese, Korean) exactly as they appear.
- For well-known songs you recognise, always provide the year even if the video title is messy.`;

function formatBatch(
  tracks: { videoId: string; title: string; description: string; channelTitle: string }[]
): string {
  return tracks
    .map(
      (t, i) =>
        `${i + 1}. id=${t.videoId} | "${t.title}" | channel: "${t.channelTitle}"` +
        (t.description ? ` | desc: "${t.description.slice(0, 120).replace(/\n/g, " ")}"` : "")
    )
    .join("\n");
}

type RawResult = { videoId: string; title?: unknown; artist?: unknown; year?: unknown };

function parseResponse(text: string): RawResult[] {
  // Strip optional markdown fences the model might add despite instructions.
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  // Find the outermost JSON array.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  return JSON.parse(cleaned.slice(start, end + 1)) as RawResult[];
}

async function resolveBatch(
  tracks: { videoId: string; title: string; description: string; channelTitle: string }[],
  apiKey: string
): Promise<Map<string, AITrackMeta>> {
  const result = new Map<string, AITrackMeta>();
  if (tracks.length === 0) return result;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: formatBatch(tracks) }],
    }),
  });

  if (!res.ok) return result; // fail-open: return empty, caller falls back to title parsing

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  let parsed: RawResult[] = [];
  try {
    parsed = parseResponse(text);
  } catch {
    return result;
  }

  for (const item of parsed) {
    if (typeof item.videoId !== "string") continue;
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : null;
    const artist = typeof item.artist === "string" && item.artist.trim() ? item.artist.trim() : null;
    const year = typeof item.year === "number" && item.year >= 1900 && item.year <= new Date().getFullYear() + 1
      ? item.year
      : null;
    if (title && artist) {
      result.set(item.videoId, { title, artist, year });
    }
  }

  return result;
}

/**
 * Resolves title, artist, and release year for a list of YouTube tracks using AI.
 * Batches requests (up to BATCH_SIZE tracks per call) and runs up to MAX_CONCURRENT
 * batches in parallel.
 *
 * @param onBatchDone  Called after each batch resolves — use for progressive DIAGNOSTIC updates.
 * @returns Map<videoId, AITrackMeta>. Missing entries mean the batch failed; fall back to parsing.
 */
export async function resolveTracksWithAI(
  tracks: { videoId: string; title: string; description: string; channelTitle: string }[],
  apiKey: string,
  onBatchDone?: (partial: Map<string, AITrackMeta>) => void
): Promise<Map<string, AITrackMeta>> {
  const combined = new Map<string, AITrackMeta>();
  if (!apiKey || tracks.length === 0) return combined;

  // Split into batches.
  const batches: typeof tracks[] = [];
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    batches.push(tracks.slice(i, i + BATCH_SIZE));
  }

  // Run in windows of MAX_CONCURRENT to stay within API rate limits.
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const window = batches.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      window.map((batch) => resolveBatch(batch, apiKey))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        r.value.forEach((meta, id) => combined.set(id, meta));
        onBatchDone?.(combined);
      }
    }
  }

  return combined;
}

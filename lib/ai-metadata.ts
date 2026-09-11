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

const SYSTEM_PROMPT = `Music metadata expert. For each YouTube track, return clean title, primary artist, and release year.

Return ONLY a JSON array, one object per input track, same order:
[{"v":"VIDEO_ID","t":"Song Title","a":"Artist","y":2019},...]

Rules:
- t: clean song name, strip suffixes (Official MV, Audio, Lyric Video, Live, HD, 4K, etc.)
- a: primary artist only, no ft./feat.
- y: original studio/single release year as integer. Best estimate — prefer a number over null. null only for truly unidentifiable tracks.
- Preserve CJK characters exactly.`;

function formatBatch(
  tracks: { videoId: string; title: string; description: string; channelTitle: string }[]
): string {
  return tracks
    .map(
      (t, i) =>
        `${i + 1}. ${t.videoId} | "${t.title}" | ch:"${t.channelTitle}"` +
        (t.description ? ` | "${t.description.slice(0, 60).replace(/\n/g, " ")}"` : "")
    )
    .join("\n");
}

// Compact field names: v=videoId, t=title, a=artist, y=year
type RawResult = { v?: unknown; t?: unknown; a?: unknown; y?: unknown };

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
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: formatBatch(tracks) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[ai-metadata] Anthropic API error ${res.status}: ${body.slice(0, 300)}`);
    return result;
  }

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  let parsed: RawResult[] = [];
  try {
    parsed = parseResponse(text);
  } catch (e) {
    console.error(`[ai-metadata] parse error: ${e}`);
    return result;
  }

  for (const item of parsed) {
    const videoId = typeof item.v === "string" ? item.v : null;
    if (!videoId) continue;
    const title = typeof item.t === "string" && item.t.trim() ? item.t.trim() : null;
    const artist = typeof item.a === "string" && item.a.trim() ? item.a.trim() : null;
    const year = typeof item.y === "number" && item.y >= 1900 && item.y <= new Date().getFullYear() + 1
      ? item.y
      : null;
    if (title && artist) {
      result.set(videoId, { title, artist, year });
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

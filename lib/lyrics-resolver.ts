// AI-powered lyrics resolver for Lyrics Mode.
// Returns a famous chorus sentence + context for fill-in-the-blank gameplay.
// Uses Claude Haiku (same API key as ai-metadata.ts). Output is always in the
// original language of the song — Traditional Chinese for zh songs, never simplified.

import type { LyricsRound } from "./game";

export type LyricsResult = Omit<LyricsRound, "videoId">;

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL_BULK = "claude-haiku-4-5-20251001";  // fast, for previewing all songs
const MODEL_GAME = "claude-sonnet-5";             // accurate, for the actual game deck
const BATCH_SIZE = 10;
const MAX_CONCURRENT = 4;

export function detectLanguageHint(title: string, artist: string): string {
  const text = title + " " + artist;
  if (/[ぁ-ん゛゜ァ-ヴーｦ-ﾟ]/.test(text)) return "Japanese";
  if (/[가-힯]/.test(text)) return "Korean";
  if (/[一-鿿]/.test(text)) return "Chinese (output Traditional Chinese 繁體中文 only, never simplified)";
  return "English";
}

type TrackInput = { videoId: string; title: string; artist: string; year: number };

type RawLyricsResult = {
  v?: unknown;
  language?: unknown;
  lyricContext?: unknown;
  blankSentence?: unknown;
  acceptableVariants?: unknown;
};

async function resolveLyricsBatch(
  tracks: TrackInput[],
  apiKey: string,
  model: string = MODEL_BULK
): Promise<Map<string, LyricsResult>> {
  const result = new Map<string, LyricsResult>();
  if (tracks.length === 0) return result;

  const prompt = tracks
    .map(
      (t) =>
        `${t.videoId} | "${t.title}" by ${t.artist} (${t.year}) | language: ${detectLanguageHint(t.title, t.artist)}`
    )
    .join("\n");

  const systemPrompt = `Lyrics expert. For each song, create a fill-in-the-blank question from the chorus that a fan would instantly recognise.

Return ONLY a JSON array, one object per input, same order:
[{"v":"VIDEO_ID","language":"zh-TW"|"en"|"ja"|"ko","lyricContext":"couplet line with ___ then next line","blankSentence":"the blanked phrase","acceptableVariants":["variant1","variant2"]},...]

Rules:
1. Pick a COUPLET from the chorus (two lines that go together).
2. Choose ONE memorable phrase within one of those lines to blank out — replace it with ___ in lyricContext. Keep the rest of both lines intact so the player sees the full couplet with one gap.
   - Good: "我要送你___\n我要唱心內的話乎你聽"  →  blankSentence: "九十九朵玫瑰花"
   - Bad: blank an entire line; bad: blank a single word if a phrase is more recognisable.
3. blankSentence MUST NOT be the same as (or nearly the same as) the song title. If the most iconic phrase IS the title, blank a different phrase from the same couplet.
4. blankSentence: the exact blanked phrase as a fan would type it — no punctuation at start/end unless essential.
5. acceptableVariants: 1-3 alternate forms fans commonly type (typos, shorter forms, punctuation variants). [] is fine.
6. Output in the ORIGINAL language of the song. For Chinese: Traditional Chinese (繁體中文) ONLY — never simplified.
7. CRITICAL: Only output lyrics you know VERBATIM from memory. If you are not 100% certain the exact words are correct, return {"v":"VIDEO_ID","blankSentence":""} — it is far better to skip a song than to fabricate lyrics that don't exist.
8. Preserve CJK characters exactly. Never translate.`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error(`[lyrics-resolver] Anthropic API error ${res.status}`);
    return result;
  }

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  let parsed: RawLyricsResult[] = [];
  try {
    const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1) return result;
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as RawLyricsResult[];
  } catch {
    console.error("[lyrics-resolver] parse error");
    return result;
  }

  for (const item of parsed) {
    const videoId = typeof item.v === "string" ? item.v.trim() : null;
    if (!videoId) continue;
    const track = tracks.find((t) => t.videoId === videoId);
    if (!track) continue;

    const blankSentence = typeof item.blankSentence === "string" ? item.blankSentence.trim() : "";
    if (!blankSentence) continue; // model signalled low confidence

    const language = (["zh-TW", "en", "ja", "ko"].includes(item.language as string)
      ? (item.language as LyricsResult["language"])
      : "zh-TW");
    const lyricContext = typeof item.lyricContext === "string" ? item.lyricContext.trim() : "___";
    const acceptableVariants = Array.isArray(item.acceptableVariants)
      ? (item.acceptableVariants as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    result.set(videoId, {
      title: track.title,
      artist: track.artist,
      language,
      lyricContext,
      blankSentence,
      acceptableVariants,
    });
  }

  return result;
}

/**
 * Resolves lyrics for a list of tracks. Batches up to BATCH_SIZE per call,
 * MAX_CONCURRENT batches in parallel. Entries with empty blankSentence (low AI
 * confidence) are excluded from the result — callers handle the skip path.
 *
 * @param onBatchDone  Called after each batch resolves (progressive preview screen).
 */
export async function resolveLyricsForTracks(
  tracks: TrackInput[],
  apiKey: string,
  onBatchDone?: (partial: Map<string, LyricsResult>) => void,
  model: string = MODEL_BULK
): Promise<Map<string, LyricsResult>> {
  const combined = new Map<string, LyricsResult>();
  if (!apiKey || tracks.length === 0) return combined;

  const batches: TrackInput[][] = [];
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    batches.push(tracks.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const window = batches.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(window.map((b) => resolveLyricsBatch(b, apiKey, model)));
    for (const r of results) {
      if (r.status === "fulfilled") {
        r.value.forEach((meta, id) => combined.set(id, meta));
        onBatchDone?.(combined);
      }
    }
  }

  return combined;
}

export { MODEL_GAME };

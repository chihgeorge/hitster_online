// AI-powered lyrics resolver for Lyrics Mode.
// Returns a famous chorus sentence + context for fill-in-the-blank gameplay.
// Uses Claude Haiku (same API key as ai-metadata.ts). Output is always in the
// original language of the song — Traditional Chinese for zh songs, never simplified.
//
// When real lyrics are available (fetched from lrclib.net), they are passed to
// Claude as ground truth. Claude then selects and blanks a memorable phrase rather
// than generating lyrics from memory, significantly improving accuracy and fun.

import type { LyricsRound } from "./game";
import { fetchLyricsBatch } from "./lyrics-fetcher";

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
  model: string = MODEL_BULK,
  fetchedLyrics: Map<string, string> = new Map()
): Promise<Map<string, LyricsResult>> {
  const result = new Map<string, LyricsResult>();
  if (tracks.length === 0) return result;

  // Build per-track prompt lines. Tracks with real lyrics get the full text;
  // tracks without fall back to Claude's memory (with low-confidence escape hatch).
  const promptLines = tracks.map((t) => {
    const lyrics = fetchedLyrics.get(t.videoId);
    const lang = detectLanguageHint(t.title, t.artist);
    if (lyrics) {
      // Truncate to ~1500 chars to stay within token budget while keeping the chorus.
      // Sanitize bare `---` lines so they don't break the per-track block separator.
      const truncated = (lyrics.length > 1500 ? lyrics.slice(0, 1500) + "\n[…]" : lyrics)
        .replace(/^-{3,}$/gm, "- - -");
      return `${t.videoId} | "${t.title}" by ${t.artist} (${t.year}) | language: ${lang}\nLYRICS:\n${truncated}\n---`;
    }
    return `${t.videoId} | "${t.title}" by ${t.artist} (${t.year}) | language: ${lang} | NO_LYRICS`;
  });

  const prompt = promptLines.join("\n\n");

  const systemPrompt = `Lyrics expert. For each song, create a fill-in-the-blank question that a fan would instantly recognise.

When LYRICS are provided: use ONLY the actual lyrics text supplied. Do NOT add, change, or invent words.
When NO_LYRICS: only output lyrics you know VERBATIM from memory. If uncertain, return {"v":"VIDEO_ID","blankSentence":""}.

Return ONLY a JSON array, one object per input, same order:
[{"v":"VIDEO_ID","language":"zh-TW"|"en"|"ja"|"ko","lyricContext":"couplet line with ___ then next line","blankSentence":"the blanked phrase","acceptableVariants":["variant1","variant2"]},...]

Rules:
1. Pick a COUPLET from the chorus (two consecutive lines that go together naturally).
2. Choose ONE memorable phrase within one of those lines to blank out — replace it with ___ in lyricContext. Keep the rest of both lines intact.
   - Good: "我要送你___\n我要唱心內的話乎你聽"  →  blankSentence: "九十九朵玫瑰花"
   - Bad: blank an entire line; bad: blank a single common word.
3. blankSentence MUST NOT be the same as (or nearly the same as) the song title.
4. blankSentence: the exact blanked phrase as a fan would type it — no punctuation at start/end unless essential.
5. acceptableVariants: 1-3 alternate forms fans commonly type (typos, shorter forms). [] is fine.
6. Output in the ORIGINAL language of the song. For Chinese: Traditional Chinese (繁體中文) ONLY.
7. Preserve CJK characters exactly. Never translate.`;

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
      : "en");
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
 * Resolves lyrics for a list of tracks. Pre-fetches real lyrics from lrclib.net
 * in parallel, then passes them to Claude as ground truth. Tracks without a lyrics
 * hit fall back to Claude's memory (with low-confidence escape hatch).
 *
 * Batches up to BATCH_SIZE per AI call, MAX_CONCURRENT batches in parallel.
 * Entries with empty blankSentence (low AI confidence) are excluded from the result.
 *
 * @param onBatchDone  Called after each AI batch resolves (progressive preview screen).
 */
export async function resolveLyricsForTracks(
  tracks: TrackInput[],
  apiKey: string,
  onBatchDone?: (partial: Map<string, LyricsResult>) => void,
  model: string = MODEL_BULK
): Promise<Map<string, LyricsResult>> {
  const combined = new Map<string, LyricsResult>();
  if (!apiKey || tracks.length === 0) return combined;

  // Pre-fetch real lyrics for all tracks concurrently before batching AI calls.
  // This is best-effort — misses are silently ignored and fall back to AI memory.
  const fetchedLyrics = await fetchLyricsBatch(tracks, 8);
  const hitRate = fetchedLyrics.size;
  console.log(`[lyrics-resolver] lrclib hits: ${hitRate}/${tracks.length}`);

  const batches: TrackInput[][] = [];
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    batches.push(tracks.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT) {
    const window = batches.slice(i, i + MAX_CONCURRENT);
    const results = await Promise.allSettled(
      window.map((b) => resolveLyricsBatch(b, apiKey, model, fetchedLyrics))
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

export { MODEL_GAME };

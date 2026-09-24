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
import { mapWithConcurrency } from "./utils";

export type LyricsResult = Omit<LyricsRound, "videoId">;

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL_BULK = "claude-haiku-4-5-20251001";  // fast, for previewing all songs
const MODEL_GAME = "claude-sonnet-5";             // accurate, for the actual game deck
const BATCH_SIZE = 10;
const MAX_CONCURRENT = 4;

// Common Simplified-only characters (none are valid Traditional). Used to reject zh-TW output that slipped through.
const SIMPLIFIED_ONLY = /[这们说么还对给爱时间会点见开关无为过来长应该谁难听记忆终涩风让门问头样现实发话请从边东车马鱼鸟龙书买读写认识泪梦厌国乐]/;

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
  fetchedLyrics: Map<string, string> = new Map(),
  popularitySummaries: Map<string, string> = new Map()
): Promise<Map<string, LyricsResult>> {
  const result = new Map<string, LyricsResult>();
  if (tracks.length === 0) return result;

  // Build per-track prompt lines. Tracks with real lyrics get the full text;
  // tracks without fall back to Claude's memory (with low-confidence escape hatch).
  // A popularity summary (docs/designs/lyrics-question-search-grounding.md), when present,
  // is appended as plain grounding text — never a tool the model can invoke here. Fetched
  // deterministically beforehand (lib/lyrics-popularity.ts); missing for a song (search
  // failure, timeout, nothing found) just means that song falls back to this prompt's
  // existing unguided "pick a memorable couplet" behavior — same as today, no error, no gap.
  const promptLines = tracks.map((t) => {
    const lyrics = fetchedLyrics.get(t.videoId);
    const lang = detectLanguageHint(t.title, t.artist);
    const popularity = popularitySummaries.get(t.videoId);
    const popularityLine = popularity ? `\nPOPULARITY: ${popularity}` : "";
    if (lyrics) {
      // Truncate to ~1500 chars to stay within token budget while keeping the chorus.
      // Sanitize bare `---` lines so they don't break the per-track block separator.
      const truncated = (lyrics.length > 1500 ? lyrics.slice(0, 1500) + "\n[…]" : lyrics)
        .replace(/^-{3,}$/gm, "- - -");
      return `${t.videoId} | "${t.title}" by ${t.artist} (${t.year}) | language: ${lang}${popularityLine}\nLYRICS:\n${truncated}\n---`;
    }
    return `${t.videoId} | "${t.title}" by ${t.artist} (${t.year}) | language: ${lang}${popularityLine} | NO_LYRICS`;
  });

  const prompt = promptLines.join("\n\n");

  const systemPrompt = `Lyrics expert. For each song, create a fill-in-the-blank question that a fan would instantly recognise.

When LYRICS are provided: use ONLY the actual lyrics text supplied. Do NOT add, change, or invent words.
When NO_LYRICS: only output lyrics you know VERBATIM from memory. If uncertain, return {"v":"VIDEO_ID","blankSentence":""}.
When a POPULARITY line is present: it was pre-fetched from a real web search about which line real listeners actually cite/quote for this song. Prefer the couplet it points to — matched against the real LYRICS text, never inventing wording the POPULARITY line implies but LYRICS doesn't contain — over your own guess at what's memorable. No POPULARITY line just means none was found; pick as you do today.

Return ONLY a JSON array, one object per input, same order:
[{"v":"VIDEO_ID","language":"zh-TW"|"en"|"ja"|"ko","lyricContext":"couplet line with ___ then next line","blankSentence":"the blanked phrase","acceptableVariants":["variant1","variant2"]},...]

Rules:
1. Pick a COUPLET from the chorus (two consecutive lines that go together naturally).
2. Choose ONE memorable phrase within one of those lines to blank out — replace it with ___ in lyricContext. Keep the rest of both lines intact.
   - Good: "我要送你九十九朵___\n我要唱心內的話乎你聽"  →  blankSentence: "玫瑰花"
   - Bad: blank an entire line; bad: blank a single common word.
   - For Chinese, Japanese and Korean the blank MUST be 2 to 6 characters long (never longer).
3. blankSentence MUST NOT be the same as (or nearly the same as) the song title.
4. blankSentence: the exact blanked phrase as a fan would type it — no punctuation at start/end unless essential.
5. acceptableVariants: 1-3 alternate forms fans commonly type (typos, shorter forms). [] is fine.
6. Output in the ORIGINAL language of the song. For Chinese: Traditional Chinese (繁體中文) ONLY.
7. Preserve CJK characters exactly. Never translate.
8. If supplied lyrics are Simplified Chinese, convert them to Traditional (繁體) character by character — same words, only the character forms change. lyricContext and blankSentence must contain no Simplified characters.`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      // Sonnet 5 thinks by default and hidden thinking can eat the whole budget, returning no text.
      thinking: { type: "disabled" },
      // Deliberately NO tools param here — Approach C's core property. Whatever popularity
      // grounding this call gets was fetched by a separate, dedicated call before this one
      // (lib/lyrics-popularity.ts); the model never decides mid-generation whether to search.
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
    let lyricContext = typeof item.lyricContext === "string" ? item.lyricContext.trim() : "";
    // Players see lyricContext verbatim: without a ___ it leaks the answer. Repair by
    // blanking the answer in place, or drop the song if it isn't in the context at all.
    if (!lyricContext.includes("___")) {
      if (!lyricContext.includes(blankSentence)) continue;
      lyricContext = lyricContext.replace(blankSentence, "___");
    }
    if (language === "zh-TW" && SIMPLIFIED_ONLY.test(lyricContext + blankSentence)) continue;
    // Size the blank to the answer: one _ per letter/character, spaces kept, punctuation ignored.
    const blank = blankSentence.replace(/[\p{L}\p{N}]/gu, "_").replace(/[^_\s]/g, "").trim();
    if (!blank) continue;
    // CJK blanks must be 2-6 characters (English is left alone: words are long).
    const blankChars = blank.replace(/\s/g, "").length;
    if (language !== "en" && (blankChars < 2 || blankChars > 6)) continue;
    lyricContext = lyricContext.replace(/_{3,}(?:[ \t]+_{3,})*/, () => blank);
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
 * @param popularitySummaries  Optional, pre-fetched (docs/designs/lyrics-question-search-grounding.md,
 *   lib/lyrics-popularity.ts) — the caller owns fetching and DO-caching these (same convention
 *   as the lyrics-sonnet:/lyrics: cache prefixes), since they cost real Anthropic calls and
 *   shouldn't be silently re-fetched here on every resolve. A song missing from this map just
 *   falls back to the existing ungrounded prompt for that song — never an error.
 */
export async function resolveLyricsForTracks(
  tracks: TrackInput[],
  apiKey: string,
  onBatchDone?: (partial: Map<string, LyricsResult>) => void,
  model: string = MODEL_BULK,
  popularitySummaries: Map<string, string> = new Map()
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

  await mapWithConcurrency(batches, MAX_CONCURRENT, (b) => resolveLyricsBatch(b, apiKey, model, fetchedLyrics, popularitySummaries), (results) => {
    for (const r of results) {
      if (r.status === "fulfilled") {
        r.value.forEach((meta, id) => combined.set(id, meta));
        onBatchDone?.(combined);
      }
    }
  });

  return combined;
}

export { MODEL_GAME };

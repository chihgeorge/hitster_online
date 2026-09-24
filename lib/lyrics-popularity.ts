// Popularity-grounding for Lyrics Mode question generation (T1 of
// docs/designs/lyrics-question-search-grounding.md, Approach C).
//
// A dedicated, single-purpose Anthropic call per song whose ONLY job is to search the web
// and summarize which line of the song is most commonly cited/quoted by real listeners —
// it never picks the blank itself. That's `lyrics-resolver.ts`'s job, unchanged, except it
// now receives this summary as extra plain-text grounding alongside the real lyrics, the
// same shape lrclib.net lyrics are already injected in. The main generation call never gets
// tool access — deterministic fetch-then-inject, not the model deciding mid-generation
// whether to search (see the design doc's Approach C rationale and its two confirming spikes).
//
// Storage-agnostic like lyrics-resolver.ts's resolveLyricsForTracks — the caller
// (party/index.ts) owns DO caching, same lyrics-sonnet:/lyrics: prefix convention.

import { mapWithConcurrency } from "./utils";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_CONCURRENT = 4;

type TrackInput = { videoId: string; title: string; artist: string };

const SYSTEM_PROMPT = `You have a web_search tool. Search for which single line/couplet of this song's chorus is most commonly quoted or referenced by real fans — blog posts, forum discussion, quiz sites, social media. Try a query like "<title> <artist> 最有名一句歌詞" or "<title> most iconic lyric".

Return ONLY a JSON object, nothing else:
{"summary":"one or two sentences in Traditional Chinese naming the specific line found and where it was cited, or empty string if search found nothing useful"}

Do not invent a quote if search doesn't surface one — return an empty summary instead. Never guess from your own memory of the song; this is about real citation evidence, not your own opinion of what's memorable.`;

/**
 * Fetches a plain-text popularity summary per track via one isolated Anthropic call each
 * (never batched — batching this together with N other songs' search decisions in one call
 * is the exact reliability gap the design doc's outside-voice pass flagged and this
 * deliberately avoids). Fails open per-song: a search failure, timeout, or empty result for
 * one song never blocks the others, and the caller (resolveLyricsBatch) already falls back to
 * its ungrounded prompt for any song missing from the returned map.
 */
export async function fetchPopularitySummaries(
  tracks: TrackInput[],
  apiKey: string
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!apiKey || tracks.length === 0) return result;

  await mapWithConcurrency(tracks, MAX_CONCURRENT, (t) => fetchOne(t, apiKey), (results, window) => {
    results.forEach((r, idx) => {
      if (r.status === "fulfilled" && r.value) result.set(window[idx].videoId, r.value);
    });
  });

  return result;
}

async function fetchOne(track: TrackInput, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        thinking: { type: "disabled" },
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: `${track.videoId} | "${track.title}" by ${track.artist}` }],
      }),
    });

    if (!res.ok) {
      console.error(`[lyrics-popularity] Anthropic API error ${res.status} for ${track.videoId}`);
      return null;
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    // Take the LAST text block — with tool use, earlier blocks are the model's search
    // narration ("I'll search for..."), the real answer comes after the tool result.
    const textBlocks = (data.content ?? []).filter((b) => b.type === "text");
    const raw = textBlocks[textBlocks.length - 1]?.text ?? "{}";
    // Schema has no nested braces — match simple {...} objects, take the last one (stray
    // braces can appear in the model's prose before the real JSON).
    const matches = raw.match(/\{[^{}]*\}/g);
    const parsed = JSON.parse(matches ? matches[matches.length - 1] : raw) as { summary?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return summary.length > 0 ? summary : null;
  } catch (e) {
    console.error(`[lyrics-popularity] fetch failed for ${track.videoId}: ${e}`);
    return null;
  }
}

// AI-powered music metadata resolver using the Anthropic Messages API.
// Resolves title, artist and release year for a batch of tracks in one Claude call.
// Uses claude-haiku-4-5 (fast, cheap) with no web-search for v1 — training data
// covers essentially all catalog music through mid-2025.
// Falls back gracefully: returns an empty Map on any API or parse failure.

import type { EditableSong, SongEditDiff, EditableLyricRound, LyricEditDiff } from "./game";
import { mapWithConcurrency } from "./utils";

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

// Untyped on purpose — shared by resolveBatch (RawResult[]) and proposeEdits (RawEditDiff[]),
// which parse differently-shaped arrays from the same "strip fences, find the outer []" logic.
function parseResponse(text: string): unknown[] {
  // Strip optional markdown fences the model might add despite instructions.
  const cleaned = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  // Find the outermost JSON array.
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  return JSON.parse(cleaned.slice(start, end + 1)) as unknown[];
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
    parsed = parseResponse(text) as RawResult[];
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
  await mapWithConcurrency(batches, MAX_CONCURRENT, (batch) => resolveBatch(batch, apiKey), (results) => {
    for (const r of results) {
      if (r.status === "fulfilled") {
        r.value.forEach((meta, id) => combined.set(id, meta));
        onBatchDone?.(combined);
      }
    }
  });

  return combined;
}

const PROPOSE_EDITS_SYSTEM_PROMPT = `You edit a music quiz's song list based on a host's plain-language instruction.

Given the current song list and an instruction, return ONLY a JSON array of field-level changes:
[{"v":"VIDEO_ID","f":"title"|"artist"|"year","n":"new value, or an integer for year"},...]

Rules:
- v: the videoId of the song being changed — must match one from the input list exactly.
- f: which field changes — "title", "artist", or "year".
- n: the new value. For "year", a 4-digit integer. For "title"/"artist", the corrected string.
- Only include entries for fields that actually need to change per the instruction — never restate unchanged songs.
- If the instruction doesn't clearly map to any song in the list, return an empty array [].
- Preserve CJK characters exactly.`;

type RawEditDiff = { v?: unknown; f?: unknown; n?: unknown };

/**
 * Proposes field-level edits to a song list from a host's natural-language instruction
 * (e.g. "the 3rd song's year is wrong, it's 1998"). Never applies anything itself — the
 * caller renders the returned diff as a reviewable change (PlaylistEditor's existing
 * dirty-row state) before the host explicitly saves it.
 *
 * Old values are computed from the passed-in `songs`, not trusted from the model's
 * response, so a round-tripping error in the AI's echo of the old value can't corrupt
 * the diff. A no-op "change" (new value equals current value) is dropped, not proposed.
 *
 * @returns [] on empty input, missing instruction, or any API/parse failure — same
 *          fail-open contract as resolveTracksWithAI.
 */
export async function proposeEdits(
  instruction: string,
  songs: EditableSong[],
  apiKey: string
): Promise<SongEditDiff[]> {
  if (!apiKey || songs.length === 0 || !instruction.trim()) return [];

  const songList = songs
    .map((s) => `${s.videoId} | "${s.title}" | ${s.artist} | ${s.year ?? "?"}`)
    .join("\n");

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
      system: PROPOSE_EDITS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Song list:\n${songList}\n\nInstruction: ${instruction}` }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[ai-metadata] proposeEdits API error ${res.status}: ${body.slice(0, 300)}`);
    return [];
  }

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  let parsed: RawEditDiff[] = [];
  try {
    parsed = parseResponse(text) as RawEditDiff[];
  } catch (e) {
    console.error(`[ai-metadata] proposeEdits parse error: ${e}`);
    return [];
  }

  const byId = new Map(songs.map((s) => [s.videoId, s]));
  const diffs: SongEditDiff[] = [];
  for (const item of parsed) {
    const videoId = typeof item.v === "string" ? item.v : null;
    const field = item.f === "title" || item.f === "artist" || item.f === "year" ? item.f : null;
    if (!videoId || !field) continue;
    const song = byId.get(videoId);
    if (!song) continue; // AI must reference a song actually in the list — never invent one

    if (field === "year") {
      const n = typeof item.n === "number" ? item.n : parseInt(String(item.n), 10);
      if (isNaN(n) || n < 1900 || n > new Date().getFullYear() + 1) continue;
      if (n === song.year) continue;
      diffs.push({ videoId, field, oldValue: song.year, newValue: n });
    } else {
      const n = typeof item.n === "string" ? item.n.trim() : "";
      if (!n || n === song[field]) continue;
      diffs.push({ videoId, field, oldValue: song[field], newValue: n });
    }
  }
  return diffs;
}

const PROPOSE_LYRIC_EDITS_SYSTEM_PROMPT = `You edit a Lyrics-mode music quiz's rounds based on a host's plain-language instruction.

Each round shows a lyric snippet with one line blanked out (lyricContext, using ___ for the blank) and the blanked line itself (blankSentence, the correct answer players must type). A round with empty context/answer means the bulk generator couldn't confidently produce one — the host may be asking you to fill it in from scratch (e.g. "give me the chorus for this song").

Given the current rounds and an instruction, return ONLY a JSON array of field-level changes:
[{"v":"VIDEO_ID","f":"lyricContext"|"blankSentence","n":"new value"},...]

Rules:
- v: the videoId of the round being changed — must match one from the input list exactly.
- f: which field changes — "lyricContext" (the surrounding lines, with ___ marking the blank) or "blankSentence" (the actual blanked line).
- n: the new value as a string.
- lyricContext must still contain a "___" placeholder marking exactly where blankSentence fits.
- Only include entries for fields that actually need to change per the instruction — never restate unchanged rounds.
- If the instruction doesn't clearly map to any round in the list, return an empty array [].
- Filling in an empty round: only output lyrics you know VERBATIM and with high confidence. If you're not sure, leave that round out of the response entirely — never guess or invent lyrics, even when explicitly asked for "the chorus" or "any lyrics you know". Wrong lyrics are worse than no question.
- Preserve CJK characters exactly.`;

type RawLyricEditDiff = { v?: unknown; f?: unknown; n?: unknown };

/**
 * Proposes field-level edits to Lyrics-mode rounds from a host's natural-language instruction
 * (e.g. "the 2nd round's answer has a typo, it should be 愛你"). Mirrors proposeEdits' contract:
 * never applies anything itself, computes oldValue from the passed-in `rounds` (never trusts the
 * model's echo), drops no-op changes, and fails open (returns []) on any error.
 */
export async function proposeLyricEdits(
  instruction: string,
  rounds: EditableLyricRound[],
  apiKey: string
): Promise<LyricEditDiff[]> {
  if (!apiKey || rounds.length === 0 || !instruction.trim()) return [];

  const roundList = rounds
    .map((r) => `${r.videoId} | "${r.title}" | ${r.artist} | context: "${r.lyricContext}" | answer: "${r.blankSentence}"`)
    .join("\n");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: PROPOSE_LYRIC_EDITS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Rounds:\n${roundList}\n\nInstruction: ${instruction}` }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[ai-metadata] proposeLyricEdits API error ${res.status}: ${body.slice(0, 300)}`);
    return [];
  }

  const data = (await res.json()) as { content?: { type: string; text: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";

  let parsed: RawLyricEditDiff[] = [];
  try {
    parsed = parseResponse(text) as RawLyricEditDiff[];
  } catch (e) {
    console.error(`[ai-metadata] proposeLyricEdits parse error: ${e}`);
    return [];
  }

  const byId = new Map(rounds.map((r) => [r.videoId, r]));
  const diffs: LyricEditDiff[] = [];
  for (const item of parsed) {
    const videoId = typeof item.v === "string" ? item.v : null;
    const field = item.f === "lyricContext" || item.f === "blankSentence" ? item.f : null;
    if (!videoId || !field) continue;
    const round = byId.get(videoId);
    if (!round) continue; // AI must reference a round actually in the list — never invent one

    const n = typeof item.n === "string" ? item.n.trim() : "";
    if (!n || n === round[field]) continue;
    diffs.push({ videoId, field, oldValue: round[field], newValue: n });
  }
  return diffs;
}

// Shared "resolve a YouTube playlist into playable songs" pipeline — the core the room
// (party/index.ts) and the room-less playlist party (party/playlist.ts) both need.
// Platform-agnostic on purpose (same split discipline as party/playlist.ts's own header
// comment): takes a PartyKit Storage binding as a plain parameter rather than reading
// `this.room.storage`, so any Durable Object can call it without inheriting room-specific
// state (pendingPlaylist, abortLoad, broadcastState, ...) that only makes sense inside a room.
//
// Extracted from party/index.ts, where this pipeline was duplicated 3x (handleLoadPlaylist,
// handleStartGame's fallback, handleStartLyricsGame's direct-fetch branch) — a prior TODO to
// extract this only partially stuck (resolveAIWithCache's caching logic got shared via a
// private method; the YouTube-fetch/filter/card-build steps around it didn't). See
// docs/designs/decouple-quiz-bank.md, decision D1.
//
// Always filters non-embeddable videos before AI resolution (see D3 in the same doc):
// party/index.ts's handleStartGame fallback used to skip this filter while handleLoadPlaylist
// applied it — an inconsistency, not a deliberate design point. One pipeline, one behavior.

import type { Storage as PartyStorage, Room as PartyRoom } from "partykit/server";
import type { Card, EditableSong, SongDiagnostic } from "./game";
import {
  fetchPlaylistItems,
  fetchEmbeddableVideoIds,
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
  stripTitleNoise,
} from "./youtube";
import { resolveTracksWithAI, type AITrackMeta } from "./ai-metadata";

/** Same lookup order every party (room, playlist, library) uses to find the YouTube/Anthropic
 * keys — `pkvar-` prefix (PartyKit's --var flag), then a plain env var, then process.env as a
 * local-dev fallback. Was a private method on HitsterRoom; extracted so party/playlist.ts's
 * new RESOLVE_FROM_URL action (docs/designs/decouple-quiz-bank.md, D1) doesn't need its own copy. */
export function resolveEnv(env: PartyRoom["env"] | undefined): { youtubeKey?: string; anthropicKey?: string } {
  return {
    youtubeKey:
      (env?.["pkvar-YOUTUBE_API_KEY"] as string | undefined) ??
      (env?.YOUTUBE_API_KEY as string | undefined) ??
      process.env.YOUTUBE_API_KEY,
    anthropicKey:
      (env?.["pkvar-ANTHROPIC_API_KEY"] as string | undefined) ??
      (env?.ANTHROPIC_API_KEY as string | undefined) ??
      process.env.ANTHROPIC_API_KEY,
  };
}

export const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{5,64}$/;

/** Maps a thrown resolution error into a stable client-facing error code — shared so the
 * room and the standalone playlist party report the same codes for the same failures. */
export function parseResolveErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : "unknown_error";
  if (msg === "QUOTA_EXCEEDED") return "quota_exceeded";
  if (msg.includes("API_KEY") || msg.includes("not set")) return "api_key_missing";
  if (msg.includes("403")) return "playlist_forbidden";
  if (msg.includes("404")) return "playlist_not_found";
  if (msg.includes("YouTube API error")) return `youtube_error:${msg.match(/\d{3}/)?.[0] ?? "unknown"}`;
  return "playlist_load_failed";
}

export type TrackItem = { videoId: string; title: string; description: string; channelTitle: string };
/** `title` is the song title parsed from the video title, used when AI metadata is missing. */
type TrackMeta = { artist: string; title?: string; descYear: number | null; titleYear: number | null };

export function parseTrackMetas(tracks: TrackItem[]): TrackMeta[] {
  return tracks.map((track) => {
    const descMeta = parseYouTubeMusicDescription(track.description);
    const titleYear = extractYearFromTitle(track.title);
    const titleParsed = parseArtistAndTrack(track.title);
    const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
    // A YouTube Music upload (artist in the description) is already titled with just the song —
    // splitting "Yesterday - Remastered 2009" on its dash would make "Remastered 2009" the answer.
    const title = descMeta.artist ? stripTitleNoise(track.title) : stripTitleNoise(titleParsed?.track ?? track.title);
    return { artist, title, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
  });
}

export function buildCardsFromAI(
  tracks: TrackItem[],
  metas: TrackMeta[],
  aiResults: Map<string, AITrackMeta>
): { songs: Card[]; allSongs: EditableSong[]; diagnostics: SongDiagnostic[] } {
  const songs: Card[] = [];
  const allSongs: EditableSong[] = [];
  const diagnostics: SongDiagnostic[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const { descYear, titleYear, artist, title } = metas[i];
    const ai = aiResults.get(t.videoId);
    const year = descYear ?? titleYear ?? ai?.year ?? null;
    const yearSource: SongDiagnostic["yearSource"] =
      descYear ? "description" : titleYear ? "title" : ai?.year ? "ai" : null;
    // Without AI metadata this is the parsed title, never the raw video title: Guess mode's
    // answer is this string, and "Artist - Song (Official MV)" is unguessable.
    const cleanTitle = ai?.title ?? title ?? t.title;
    const cleanArtist = ai?.artist ?? artist;
    diagnostics.push({ title: cleanTitle, artist: cleanArtist, year, yearSource });
    allSongs.push({ videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year });
    if (year) {
      songs.push({ id: t.videoId, videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year });
    }
  }
  return { songs, allSongs, diagnostics };
}

/** PartyKit storage get/put accept at most 128 keys per call. */
const STORAGE_BATCH = 128;

/** Batched storage.get — PartyKit's Storage.get caps out around 128 keys per call. Shared by
 * the AI-metadata cache below and by any lyrics-cache read a caller does on the side. */
export async function storageBatchGet<T>(storage: PartyStorage, keys: string[]): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  for (let i = 0; i < keys.length; i += STORAGE_BATCH) {
    const chunk = keys.slice(i, i + STORAGE_BATCH);
    const partial = (await storage.get<T>(chunk)) as Map<string, T>;
    for (const [k, v] of partial) result.set(k, v);
  }
  return result;
}

/** Fire-and-forget put of `prefix + id → value`, STORAGE_BATCH keys per call. */
export function storageBatchPut(storage: PartyStorage, prefix: string, entries: Iterable<readonly [string, unknown]>) {
  const all = [...entries].map(([id, v]) => [prefix + id, v] as const);
  for (let i = 0; i < all.length; i += STORAGE_BATCH) storage.put(Object.fromEntries(all.slice(i, i + STORAGE_BATCH))).catch(() => {});
}

/**
 * "The AI answered but gave nothing usable" markers, so those songs aren't re-sent on every load
 * (TODOS.md P2). Each kind has its own key prefix with a version: bump the version when the
 * prompt changes so every song is retried. Only songs the model actually answered get a marker —
 * a failed call or unparseable reply is retried next time. Markers expire after NO_RESULT_TTL_MS
 * too, so a song whose lyrics show up on lrclib later gets another chance.
 */
export const NO_RESULT = {
  aiMeta: "noResult:aiMeta:v1:",
  lyrics: "noResult:lyrics:v1:",
  lyricsSonnet: "noResult:lyrics-sonnet:v1:",
} as const;
export const NO_RESULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Video ids with a live "no usable result" marker under `prefix`. */
export async function getNoResult(storage: PartyStorage, prefix: string, videoIds: string[], now = Date.now()): Promise<Set<string>> {
  const raw = await storageBatchGet<number>(storage, videoIds.map((id) => prefix + id));
  return new Set([...raw]
    .filter(([, at]) => typeof at === "number" && now - at < NO_RESULT_TTL_MS)
    .map(([k]) => k.slice(prefix.length)));
}

/** Records "no usable result" for these video ids (value: when, for the TTL). Fire-and-forget. */
export function putNoResult(storage: PartyStorage, prefix: string, videoIds: Iterable<string>, now = Date.now()) {
  storageBatchPut(storage, prefix, [...videoIds].map((id) => [id, now] as const));
}

/** Exported for callers that already have `tracks` (e.g. handleStartLyricsGame's
 * branches that reuse a pending/test-seed track list) and just need AI metadata
 * without re-running the fetch+filter steps resolvePlaylistFromUrl also does. */
export async function resolveAIWithCache(
  storage: PartyStorage,
  tracks: TrackItem[],
  anthropicKey: string | undefined,
  onBatchDone?: (accumulated: Map<string, AITrackMeta>) => void
): Promise<Map<string, AITrackMeta>> {
  const cacheRaw = await storageBatchGet<AITrackMeta>(storage, tracks.map((t) => `aiMeta:${t.videoId}`));
  const cachedAI = new Map<string, AITrackMeta>([...cacheRaw].map(([k, v]) => [k.slice(7), v]));
  const noResult = await getNoResult(storage, NO_RESULT.aiMeta, tracks.filter((t) => !cachedAI.has(t.videoId)).map((t) => t.videoId));
  const uncachedTracks = tracks.filter((t) => !cachedAI.has(t.videoId) && !noResult.has(t.videoId));
  const unusable = new Set<string>();
  const freshAI = anthropicKey && uncachedTracks.length > 0
    ? await resolveTracksWithAI(uncachedTracks, anthropicKey, onBatchDone
        ? (partial) => onBatchDone(new Map([...cachedAI, ...partial]))
        : undefined, unusable)
    : new Map<string, AITrackMeta>();
  if (unusable.size > 0) putNoResult(storage, NO_RESULT.aiMeta, unusable);
  storageBatchPut(storage, "aiMeta:", freshAI);
  return new Map([...cachedAI, ...freshAI]);
}

interface ResolvedPlaylist {
  tracks: TrackItem[];
  metas: TrackMeta[];
  aiResults: Map<string, AITrackMeta>;
  songs: Card[];
  allSongs: EditableSong[];
  diagnostics: SongDiagnostic[];
  skippedEmbeddingCount: number;
}

/**
 * Fetches a YouTube playlist by id and filters out non-embeddable videos — the one
 * fetch step every entry point should share, so this filter is never accidentally
 * skipped on one call site and not another again (see D3 in the file header).
 */
export async function fetchAndFilterTracks(
  playlistId: string,
  youtubeKey: string | undefined
): Promise<{ tracks: TrackItem[]; skippedEmbeddingCount: number }> {
  const fetched = await fetchPlaylistItems(playlistId, youtubeKey);
  const embeddable = await fetchEmbeddableVideoIds(fetched.map((t) => t.videoId), youtubeKey);
  const skippedEmbeddingCount = fetched.length - embeddable.size;
  return { tracks: fetched.filter((t) => embeddable.has(t.videoId)), skippedEmbeddingCount };
}

/**
 * Fetches a YouTube playlist by id, filters out non-embeddable videos, resolves AI
 * metadata (cached per-DO via `storage`), and builds playable cards. The one pipeline
 * every "load a playlist from a URL" entry point should call — see the file header.
 *
 * @param onFetched  Fired once, right after fetch+embeddability-filter+meta-parse, before
 *   AI resolution starts — lets a caller show the raw song list immediately instead of
 *   waiting on AI (the room's DIAGNOSTIC-before-AI behavior). Omit for a blocking caller
 *   that only wants the final result.
 * @param onAIBatch  Progress callback fired after each AI-resolution batch completes —
 *   pass this from a caller that wants to broadcast partial results (the room does);
 *   omit it for a blocking, single-result caller (the standalone playlist party does).
 */
export async function resolvePlaylistFromUrl(
  playlistId: string,
  keys: { youtubeKey?: string; anthropicKey?: string },
  storage: PartyStorage,
  onFetched?: (tracks: TrackItem[], metas: TrackMeta[], skippedEmbeddingCount: number) => void,
  onAIBatch?: (accumulated: Map<string, AITrackMeta>, tracks: TrackItem[], metas: TrackMeta[]) => void
): Promise<ResolvedPlaylist> {
  const { tracks, skippedEmbeddingCount } = await fetchAndFilterTracks(playlistId, keys.youtubeKey);

  const metas = parseTrackMetas(tracks);
  onFetched?.(tracks, metas, skippedEmbeddingCount);

  const aiResults = await resolveAIWithCache(storage, tracks, keys.anthropicKey, onAIBatch
    ? (accumulated) => onAIBatch(accumulated, tracks, metas)
    : undefined);

  const { songs, allSongs, diagnostics } = buildCardsFromAI(tracks, metas, aiResults);

  return { tracks, metas, aiResults, songs, allSongs, diagnostics, skippedEmbeddingCount };
}

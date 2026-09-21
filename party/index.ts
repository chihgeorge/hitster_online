import type * as Party from "partykit/server";
import {
  evaluateRound,
  checkWinner,
  extractPlaylistId,
  type GameState,
  type ClientMessage,
  type ServerMessage,
  type SongDiagnostic,
  type Card,
  type EditableSong,
  type LyricsGameState,
  type LyricsGameConfig,
  type LyricsRound,
  type PublicLyricsGameState,
  type PublicLyricsRound,
} from "../lib/game";
import { isValidYear, sanitizeText } from "../lib/utils";
import {
  fetchPlaylistItems,
  fetchEmbeddableVideoIds,
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
} from "../lib/youtube";
import { resolveTracksWithAI, type AITrackMeta } from "../lib/ai-metadata";
import { resolveLyricsForTracks, MODEL_GAME, type LyricsResult } from "../lib/lyrics-resolver";
import { isCorrect, computePoints } from "../lib/fuzzy";

const DEFAULT_TARGET_CARD_COUNT = 10;
const MAX_TARGET_CARD_COUNT = 20;
const MAX_PLAYERS_SOFT = 8;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{5,64}$/;

// Real C-pop seed for hitster://cpop-test (used by both classic and Lyrics Mode).
const CPOP_SEED = [
  { videoId: "KqjgLbKZ1h0", title: "那些年", artist: "胡夏", year: 2012 },
  { videoId: "vsBf_0gDxSM", title: "可惜沒如果", artist: "林俊傑 JJ Lin", year: 2014 },
  { videoId: "_sQSXwdtxlY", title: "小幸運", artist: "田馥甄 Hebe Tien", year: 2015 },
  { videoId: "bu7nU9Mhpyo", title: "告白氣球", artist: "周杰倫 Jay Chou", year: 2016 },
  { videoId: "T4SimnaiktU", title: "光年之外", artist: "G.E.M. 鄧紫棋", year: 2016 },
  { videoId: "wSBXfzgqHtE", title: "你，好不好？", artist: "周興哲 Eric Chou", year: 2016 },
  { videoId: "sg_WE0ToJjM", title: "體面", artist: "于文文", year: 2017 },
  { videoId: "Dnj5Tcpev0Q", title: "年少有為", artist: "李榮浩 Ronghao Li", year: 2018 },
];

// Lyrics Mode defaults
const LYRICS_DEFAULT_TIMER = 60;
const LYRICS_DEFAULT_ROUNDS = 10;
const LYRICS_ANSWER_GRACE_MS = 500;
const LYRICS_MAX_CONSECUTIVE_SKIPS = 3;

// Player name constraints
const MAX_NAME_LENGTH = 20;
function sanitizeName(name: string): string {
  return name
    .replace(/[<>&"']/g, "") // strip HTML special chars
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidPlayerId(id: string): boolean {
  return UUID_RE.test(id);
}

type PendingPlaylist = {
  playlistId: string;
  songs: Card[];
  allSongs: EditableSong[];
  diagnostics: SongDiagnostic[];
  spotifyRateLimited: boolean;
  kgBlocked: boolean;
};

// ── Shared playlist resolution helpers ──────────────────────────────────────

type TrackItem = { videoId: string; title: string; description: string; channelTitle: string };
type TrackMeta = { artist: string; descYear: number | null; titleYear: number | null };

function parseTrackMetas(tracks: TrackItem[]): TrackMeta[] {
  return tracks.map((track) => {
    const descMeta = parseYouTubeMusicDescription(track.description);
    const titleYear = extractYearFromTitle(track.title);
    const titleParsed = parseArtistAndTrack(track.title);
    const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
    return { artist, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
  });
}

function buildCardsFromAI(
  tracks: TrackItem[],
  metas: TrackMeta[],
  aiResults: Map<string, AITrackMeta>
): { songs: Card[]; allSongs: EditableSong[]; diagnostics: SongDiagnostic[] } {
  const songs: Card[] = [];
  const allSongs: EditableSong[] = [];
  const diagnostics: SongDiagnostic[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    const { descYear, titleYear, artist } = metas[i];
    const ai = aiResults.get(t.videoId);
    const year = descYear ?? titleYear ?? ai?.year ?? null;
    const yearSource: SongDiagnostic["yearSource"] =
      descYear ? "description" : titleYear ? "title" : ai?.year ? "ai" : null;
    const cleanTitle = ai?.title ?? t.title;
    const cleanArtist = ai?.artist ?? artist;
    diagnostics.push({ title: cleanTitle, artist: cleanArtist, year, yearSource });
    allSongs.push({ videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year });
    if (year) {
      songs.push({ id: t.videoId, videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year, yearSource: yearSource as Card["yearSource"] });
    }
  }
  return { songs, allSongs, diagnostics };
}

export default class HitsterRoom implements Party.Server {
  state: GameState;
  lyricsState: LyricsGameState | null = null;
  private lyricsConfig: LyricsGameConfig = { timerSeconds: LYRICS_DEFAULT_TIMER, totalRounds: LYRICS_DEFAULT_ROUNDS, fuzzyEnabled: false };
  private lyricsDeck: (LyricsRound & { failed?: boolean })[] = [];
  private pendingPlaylist: PendingPlaylist | null = null;
  private lyricsPreviewMap: Map<string, LyricsResult> = new Map();
  private abortLoad = false;
  private loadSeq = 0;
  private hostConnId = "";

  constructor(readonly room: Party.Room) {
    this.state = this.emptyState();
  }

  private emptyState(): GameState {
    return {
      phase: "lobby",
      players: {},
      targetCardCount: DEFAULT_TARGET_CARD_COUNT,
      currentRound: 0,
      playlistId: "",
      songs: [],
      currentSong: null,
      placements: {},
      activePlayerId: null,
      hostId: "",
      winner: null,
    };
  }

  private broadcast(msg: ServerMessage) {
    this.room.broadcast(JSON.stringify(msg));
  }

  private sanitizedState(): GameState {
    const { hostId: _h, ...rest } = this.state;
    return {
      ...rest,
      hostId: "",
      // Strip year from deck — future answers must not be visible to clients
      songs: rest.songs.map((s) => ({ ...s, year: 0 })),
      // Strip year from currentSong during guessing — answer not yet revealed
      currentSong:
        rest.currentSong && rest.phase === "guessing"
          ? { ...rest.currentSong, year: 0 }
          : rest.currentSong,
    };
  }

  private broadcastState() {
    this.broadcast({ type: "STATE", state: this.sanitizedState() });
  }

  private sendTo(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }

  onConnect(conn: Party.Connection) {
    if (!this.hostConnId) this.hostConnId = conn.id;
    this.sendTo(conn, { type: "STATE", state: this.sanitizedState() });
    const ls = this.sanitizedLyricsState();
    if (ls) this.sendTo(conn, { type: "LYRICS_STATE", state: ls });
  }

  async onMessage(message: string, sender: Party.Connection) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "JOIN":
        this.handleJoin(sender, msg.playerId, msg.name);
        break;
      case "REJOIN":
        this.handleRejoin(sender, msg.playerId, msg.name);
        break;
      case "PLACE":
        this.handlePlace(sender, msg.playerId, msg.position);
        break;
      case "LOAD_PLAYLIST":
        await this.handleLoadPlaylist(sender, msg.hostId, msg.playlistUrl);
        break;
      case "ABORT_LOAD":
        if (this.isValidHostId(msg.hostId)) this.abortLoad = true;
        break;
      case "LOAD_SAVED_PLAYLIST":
        this.handleLoadSavedPlaylist(sender, msg.hostId, msg.playlistId, msg.songs);
        break;
      case "START_GAME":
        await this.handleStartGame(sender, msg.hostId, msg.playlistUrl, msg.targetCardCount, msg.songs);
        break;
      case "REVEAL":
        this.handleReveal(sender, msg.hostId);
        break;
      case "NEXT_ROUND":
        this.handleNextRound(sender, msg.hostId);
        break;
      case "RESET_GAME":
        this.handleResetGame(sender, msg.hostId);
        break;
      // ── Lyrics Mode ──────────────────────────────────────────────────────
      case "START_LYRICS_GAME":
        await this.handleStartLyricsGame(sender, msg.hostId, msg.playlistUrl, msg.config, msg.lyricOverrides);
        break;
      case "CONFIRM_LYRICS_PREVIEW":
        this.handleConfirmLyricsPreview(sender, msg.hostId);
        break;
      case "START_LYRICS_ROUND":
        this.handleStartLyricsRound(sender, msg.hostId);
        break;
      case "SUBMIT_LYRICS_ANSWER":
        this.handleSubmitLyricsAnswer(sender, msg.playerId, msg.text, msg.ts);
        break;
      case "SHOW_LYRICS_RESULTS":
        this.handleShowLyricsResults(sender, msg.hostId);
        break;
      case "NEXT_LYRICS_ROUND":
        this.handleNextLyricsRound(sender, msg.hostId);
        break;
      case "RESET_LYRICS_GAME":
        this.handleResetLyricsGame(sender, msg.hostId);
        break;
    }
  }

  onClose(_conn: Party.Connection) {
    // No connection→playerId map in v1; players reconnect via REJOIN with their stored playerId.
  }

  private handleJoin(conn: Party.Connection, playerId: string, rawName: string) {
    if (!isValidPlayerId(playerId)) return;
    const name = sanitizeName(rawName);
    if (!name) {
      this.sendTo(conn, { type: "ERROR", error: "invalid_name" });
      return;
    }
    if (Object.keys(this.state.players).length >= MAX_PLAYERS_SOFT) {
      this.sendTo(conn, { type: "ERROR", error: "room_full" });
      return;
    }

    // Deal a starting card if songs are loaded (shouldn't happen in lobby, but defensive)
    const startingCard = this.pickStartingCard(playerId);
    this.state.players[playerId] = {
      name,
      cardCount: startingCard ? 1 : 0,
      timeline: startingCard ? [startingCard] : [],
      connected: true,
    };

    this.broadcastState();
  }

  private handleRejoin(conn: Party.Connection, playerId: string, rawName: string) {
    if (!isValidPlayerId(playerId)) return;
    const name = sanitizeName(rawName);
    if (this.state.players[playerId]) {
      this.state.players[playerId].connected = true;
      this.state.players[playerId].name = name || this.state.players[playerId].name;
    } else {
      // Unknown player — treat as new join
      this.handleJoin(conn, playerId, rawName);
      return;
    }
    this.sendTo(conn, { type: "STATE", state: this.sanitizedState() });
    this.broadcastState();
  }

  private handlePlace(conn: Party.Connection, playerId: string, position: number) {
    if (!isValidPlayerId(playerId)) return;
    if (this.state.phase !== "guessing") {
      this.sendTo(conn, { type: "TOO_LATE" });
      return;
    }
    if (playerId !== this.state.activePlayerId) return;
    if (!this.state.players[playerId]) return;

    // Validate position is a non-negative integer within range of the player's timeline
    const player = this.state.players[playerId];
    const maxPosition = player.timeline.length; // can insert after last card
    if (!Number.isInteger(position) || position < 0 || position > maxPosition) {
      this.sendTo(conn, { type: "ERROR", error: "invalid_position" });
      return;
    }

    this.state.placements[playerId] = position;
    this.sendTo(conn, { type: "PLACEMENT_ACK", playerId });
    this.broadcastState();
  }

  private async storageBatchGet<T>(keys: string[]): Promise<Map<string, T>> {
    const result = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 128) {
      const chunk = keys.slice(i, i + 128);
      const partial = await this.room.storage.get<T>(chunk) as Map<string, T>;
      for (const [k, v] of partial) result.set(k, v);
    }
    return result;
  }

  private async resolveAIWithCache(
    tracks: TrackItem[],
    anthropicKey: string | undefined,
    onBatchDone?: (accumulated: Map<string, AITrackMeta>) => void
  ): Promise<Map<string, AITrackMeta>> {
    const cacheRaw = await this.storageBatchGet<AITrackMeta>(
      tracks.map(t => `aiMeta:${t.videoId}`)
    );
    const cachedAI = new Map<string, AITrackMeta>(
      [...cacheRaw].map(([k, v]) => [k.slice(7), v])
    );
    const uncachedTracks = tracks.filter(t => !cachedAI.has(t.videoId));
    const freshAI = anthropicKey && uncachedTracks.length > 0
      ? await resolveTracksWithAI(uncachedTracks, anthropicKey, onBatchDone
          ? (partial) => onBatchDone(new Map([...cachedAI, ...partial]))
          : undefined)
      : new Map<string, AITrackMeta>();
    if (freshAI.size > 0) {
      const entries = [...freshAI].map(([id, meta]) => [`aiMeta:${id}`, meta] as const);
      for (let i = 0; i < entries.length; i += 128) {
        const chunk = Object.fromEntries(entries.slice(i, i + 128));
        this.room.storage.put(chunk).catch(() => {});
      }
    }
    return new Map([...cachedAI, ...freshAI]);
  }

  private isValidHostId(hostId: string): boolean {
    return this.state.hostId !== "" && hostId === this.state.hostId;
  }

  private resolveEnv() {
    return {
      youtubeKey:
        (this.room.env?.["pkvar-YOUTUBE_API_KEY"] as string | undefined) ??
        (this.room.env?.YOUTUBE_API_KEY as string | undefined) ??
        process.env.YOUTUBE_API_KEY,
      anthropicKey:
        (this.room.env?.["pkvar-ANTHROPIC_API_KEY"] as string | undefined) ??
        (this.room.env?.ANTHROPIC_API_KEY as string | undefined) ??
        process.env.ANTHROPIC_API_KEY,
    };
  }

  private parseErrorCode(err: unknown): string {
    const msg = err instanceof Error ? err.message : "unknown_error";
    if (msg === "QUOTA_EXCEEDED") return "quota_exceeded";
    if (msg.includes("API_KEY") || msg.includes("not set")) return "api_key_missing";
    if (msg.includes("403")) return "playlist_forbidden";
    if (msg.includes("404")) return "playlist_not_found";
    if (msg.includes("YouTube API error")) return `youtube_error:${msg.match(/\d{3}/)?.[0] ?? "unknown"}`;
    if (msg.includes("Spotify")) return "spotify_error";
    return "playlist_load_failed";
  }

  private async handleLoadPlaylist(conn: Party.Connection, hostId: string, playlistUrl: string) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
      return;
    }
    if (this.state.hostId === "") {
      if (this.hostConnId !== "" && conn.id !== this.hostConnId) {
        this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "unauthorized" });
        return;
      }
      this.state.hostId = hostId;
      this.hostConnId = conn.id;
    } else if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "unauthorized" });
      return;
    }

    const playlistId = extractPlaylistId(playlistUrl);

    // Test seeds: signal ready immediately.
    if (playlistUrl === "hitster://test" || playlistUrl === "hitster://cpop-test") {
      const testSongs = playlistUrl === "hitster://cpop-test"
        ? CPOP_SEED
        : Array.from({ length: 20 }, (_, i) => ({
            videoId: `dQw4w9WgXcQ_${i}`, title: `Test Song ${1960 + i * 3}`,
            artist: "Test Artist", year: 1960 + i * 3,
          }));
      this.pendingPlaylist = { playlistId, songs: testSongs, allSongs: testSongs, diagnostics: [], spotifyRateLimited: false, kgBlocked: false };
      this.sendTo(conn, { type: "PLAYLIST_READY", songCount: testSongs.length, songs: testSongs });
      return;
    }

    if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "playlist_load_failed" });
      return;
    }

    // Reset abort flag and clear any previous cached result.
    this.abortLoad = false;
    const mySeq = ++this.loadSeq;
    this.pendingPlaylist = null;

    // Tracks and metas declared outside the try so the abort handler can reference them.
    let tracks: TrackItem[] = [];
    let metas: TrackMeta[] = [];

    try {
      const { youtubeKey, anthropicKey } = this.resolveEnv();

      tracks = await fetchPlaylistItems(playlistId, youtubeKey);

      // Filter out videos with embedding disabled before year resolution.
      const embeddable = await fetchEmbeddableVideoIds(tracks.map((t) => t.videoId), youtubeKey);
      const skippedCount = tracks.length - embeddable.size;
      tracks = tracks.filter((t) => embeddable.has(t.videoId));

      metas = parseTrackMetas(tracks);

      // Send initial DIAGNOSTIC immediately so the host sees the song list.
      this.sendTo(conn, {
        type: "DIAGNOSTIC",
        songs: tracks.map((t, i) => ({ title: t.title, artist: metas[i].artist, year: null, yearSource: null })),
        status: { spotifyRateLimited: false, kgBlocked: false },
        ...(skippedCount > 0 ? { skippedEmbeddingCount: skippedCount } : {}),
      });

      // ── AI metadata resolution (cache-backed, progressive diagnostics) ───────
      const aiResults = await this.resolveAIWithCache(tracks, anthropicKey, (accumulated) => {
        if (this.abortLoad || mySeq !== this.loadSeq) return;
        const { songs: partialSongs, allSongs: partialAll, diagnostics: diagSongs } = buildCardsFromAI(tracks, metas, accumulated);
        this.pendingPlaylist = { playlistId, songs: partialSongs, allSongs: partialAll, diagnostics: diagSongs, spotifyRateLimited: false, kgBlocked: false };
        this.sendTo(conn, { type: "DIAGNOSTIC", songs: diagSongs, status: { spotifyRateLimited: false, kgBlocked: false } });
      });

      // Abort checkpoint after AI pass.
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          const { allSongs: abortAll } = buildCardsFromAI(tracks, metas, aiResults);
          this.sendTo(conn, abortAll.length >= 2
            ? { type: "PLAYLIST_READY", songCount: abortAll.length, songs: abortAll }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      const { songs, allSongs, diagnostics } = buildCardsFromAI(tracks, metas, aiResults);
      this.pendingPlaylist = { playlistId, songs, allSongs, diagnostics, spotifyRateLimited: false, kgBlocked: false };

      if (allSongs.length < 2) {
        this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        return;
      }

      this.sendTo(conn, {
        type: "PLAYLIST_READY",
        songCount: allSongs.length,
        songs: allSongs,
      });

      // Kick off lyrics generation in background immediately after playlist is ready.
      // Results are broadcast via LYRICS_PREVIEW and cached in DO storage for fast START_LYRICS_GAME.
      const { anthropicKey: lyricsKey } = this.resolveEnv();
      void this.generateLyricsPreview(allSongs, aiResults, lyricsKey);
    } catch (err) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: this.parseErrorCode(err) });
    }
  }

  private buildPreviewRounds(
    enrichedTracks: { videoId: string; title: string; artist: string; year: number }[],
    lyrics: Map<string, LyricsResult>
  ): PublicLyricsRound[] {
    return enrichedTracks.flatMap((t) => {
      const lyric = lyrics.get(t.videoId);
      if (!lyric) return [];
      const r: PublicLyricsRound = {
        videoId: t.videoId,
        title: lyric.title || t.title,
        artist: lyric.artist || t.artist,
        language: lyric.language,
        lyricContext: lyric.lyricContext,
        blankSentence: lyric.blankSentence,
      };
      return [r];
    });
  }

  private async generateLyricsPreview(
    allSongs: EditableSong[],
    aiResults: Map<string, AITrackMeta>,
    anthropicKey: string | undefined
  ) {
    // Signal loading so the host table shows a spinner instead of dashes.
    this.broadcast({ type: "LYRICS_PREVIEW", rounds: [], loading: true });

    const enrichedTracks = allSongs.map((s) => {
      const meta = aiResults.get(s.videoId);
      return {
        videoId: s.videoId,
        title: meta?.title ?? s.title,
        artist: meta?.artist ?? s.artist,
        year: meta?.year ?? 0,
      };
    });

    // Check DO lyrics cache first.
    const lyricsCacheRaw = await this.storageBatchGet<LyricsResult>(
      enrichedTracks.map((t) => `lyrics:${t.videoId}`)
    );
    const cachedLyrics = new Map<string, LyricsResult>(
      [...lyricsCacheRaw].map(([k, v]) => [k.slice(7), v])
    );
    const uncachedTracks = enrichedTracks.filter((t) => !cachedLyrics.has(t.videoId));

    // If we have cached results, broadcast them immediately so the table is not empty.
    if (cachedLyrics.size > 0) {
      const cachedRounds = this.buildPreviewRounds(enrichedTracks, cachedLyrics);
      this.broadcast({ type: "LYRICS_PREVIEW", rounds: cachedRounds, loading: uncachedTracks.length > 0 });
    }

    if (anthropicKey && uncachedTracks.length > 0) {
      // Accumulate fresh lyrics progressively, broadcasting after each batch.
      const accumulated = new Map<string, LyricsResult>(cachedLyrics);
      await resolveLyricsForTracks(uncachedTracks, anthropicKey, (partial) => {
        partial.forEach((v, k) => accumulated.set(k, v));
        const progressRounds = this.buildPreviewRounds(enrichedTracks, accumulated);
        this.broadcast({ type: "LYRICS_PREVIEW", rounds: progressRounds, loading: true });
      });

      // Cache only the newly generated entries.
      const freshEntries = [...accumulated].filter(([id]) => !cachedLyrics.has(id));
      if (freshEntries.length > 0) {
        const storageEntries = freshEntries.map(([id, l]) => [`lyrics:${id}`, l] as const);
        for (let i = 0; i < storageEntries.length; i += 128) {
          this.room.storage.put(Object.fromEntries(storageEntries.slice(i, i + 128))).catch(() => {});
        }
      }

      const allLyrics = accumulated;
      this.lyricsPreviewMap = allLyrics;
      this.broadcast({ type: "LYRICS_PREVIEW", rounds: this.buildPreviewRounds(enrichedTracks, allLyrics), loading: false });
    } else {
      this.lyricsPreviewMap = cachedLyrics;
      this.broadcast({ type: "LYRICS_PREVIEW", rounds: this.buildPreviewRounds(enrichedTracks, cachedLyrics), loading: false });
    }
  }

  private handleLoadSavedPlaylist(
    conn: Party.Connection,
    hostId: string,
    playlistId: string,
    songs: EditableSong[]
  ) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
      return;
    }
    if (this.state.hostId === "") {
      if (this.hostConnId !== "" && conn.id !== this.hostConnId) {
        this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "unauthorized" });
        return;
      }
      this.state.hostId = hostId;
      this.hostConnId = conn.id;
    } else if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "unauthorized" });
      return;
    }

    if (!Array.isArray(songs) || songs.length < 2) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
      return;
    }

    const validSongs = songs.filter(
      (s) =>
        typeof s.videoId === "string" &&
        s.videoId.length > 0 &&
        typeof s.title === "string" &&
        s.title.trim().length > 0
    );
    const cards: Card[] = validSongs
      .filter((s) => typeof s.year === "number" && isValidYear(s.year))
      .map((s) => ({
        id: s.videoId,
        videoId: s.videoId,
        title: sanitizeText(s.title, 200),
        artist: sanitizeText(s.artist ?? "", 100),
        year: s.year as number,
        yearSource: "manual" as const,
      }));
    const allSongs: EditableSong[] = validSongs.map((s) => ({
      videoId: s.videoId,
      title: sanitizeText(s.title, 200),
      artist: sanitizeText(s.artist ?? "", 100),
      year: typeof s.year === "number" && isValidYear(s.year) ? s.year : null,
    }));

    if (allSongs.length < 2) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
      return;
    }

    this.pendingPlaylist = {
      playlistId,
      songs: cards,
      allSongs,
      diagnostics: allSongs.map((s) => ({
        title: s.title,
        artist: s.artist,
        year: s.year,
        yearSource: null,
      })),
      spotifyRateLimited: false,
      kgBlocked: false,
    };

    this.sendTo(conn, {
      type: "PLAYLIST_READY",
      songCount: allSongs.length,
      songs: allSongs,
    });
  }

  private async handleStartGame(
    conn: Party.Connection,
    hostId: string,
    playlistUrl: string,
    targetCardCount?: number,
    songOverrides?: EditableSong[]
  ) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (this.state.hostId === "") {
      if (this.hostConnId !== "" && conn.id !== this.hostConnId) {
        this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
        return;
      }
      this.state.hostId = hostId;
      this.hostConnId = conn.id;
    } else if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (typeof targetCardCount === "number") {
      this.state.targetCardCount = Math.max(1, Math.min(targetCardCount, MAX_TARGET_CARD_COUNT));
    }

    const playlistId = extractPlaylistId(playlistUrl);
    this.state.playlistId = playlistId;
    this.broadcastState();

    // ── Test seeds ───────────────────────────────────────────────────────────
    if (playlistUrl === "hitster://cpop-test") {
      this.state.targetCardCount = 3;
      const cpopSongs: Card[] = CPOP_SEED.map((c, i) => ({ id: `cpop-${i}`, ...c, yearSource: "ytmusic" as const }));
      this.state.songs = cpopSongs;
      this.broadcast({ type: "DIAGNOSTIC", songs: cpopSongs.map((s) => ({ title: s.title, artist: s.artist, year: s.year, yearSource: "ytmusic" as const })), status: { spotifyRateLimited: false, kgBlocked: false } });
      this.dealStartingCardsAndStart();
      return;
    }

    if (playlistUrl === "hitster://test") {
      this.state.targetCardCount = 3;
      this.state.songs = Array.from({ length: 20 }, (_, i) => ({
        id: `test-${i}`, videoId: "dQw4w9WgXcQ", title: `Test Song ${1960 + i * 3}`,
        artist: "Test Artist", year: 1960 + i * 3, yearSource: "manual" as const,
      } satisfies Card));
      this.dealStartingCardsAndStart();
      return;
    }

    // ── Use cached playlist (loaded via LOAD_PLAYLIST) ───────────────────────
    const pending = this.pendingPlaylist;
    if (pending && pending.playlistId === playlistId) {
      // Build gameplay deck from allSongs, applying host overrides, then keep only year-resolved songs.
      const overrideMap = songOverrides && songOverrides.length > 0
        ? new Map(songOverrides.map((s) => [s.videoId, s]))
        : new Map<string, EditableSong>();
      const resolvedCards: Card[] = [];
      for (const s of pending.allSongs) {
        const ov = overrideMap.get(s.videoId);
        const title = sanitizeText(ov?.title || s.title, 200) || s.title;
        const artist = sanitizeText(ov?.artist || s.artist, 100) || s.artist;
        const rawYear = (ov?.year != null && isValidYear(ov.year)) ? ov.year : s.year;
        if (rawYear != null && isValidYear(rawYear)) {
          resolvedCards.push({ id: s.videoId, videoId: s.videoId, title, artist, year: rawYear, yearSource: "manual" });
        }
      }
      if (resolvedCards.length < 2) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        return;
      }
      this.state.songs = [...resolvedCards].sort(() => Math.random() - 0.5);
      this.broadcast({ type: "DIAGNOSTIC", songs: pending.diagnostics, status: { spotifyRateLimited: pending.spotifyRateLimited, kgBlocked: pending.kgBlocked } });
      this.pendingPlaylist = null;
      this.dealStartingCardsAndStart();
      return;
    }

    // ── Fallback: load on the fly (LOAD_PLAYLIST wasn't called first) ────────
    if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
      this.sendTo(conn, { type: "ERROR", error: "playlist_load_failed" });
      return;
    }
    try {
      const { youtubeKey, anthropicKey } = this.resolveEnv();
      const tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      const metas = parseTrackMetas(tracks);
      const aiResults = await this.resolveAIWithCache(tracks, anthropicKey);
      const { songs } = buildCardsFromAI(tracks, metas, aiResults);
      if (songs.length < 2) { this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" }); return; }
      this.state.songs = songs.sort(() => Math.random() - 0.5);
      this.dealStartingCardsAndStart();
    } catch (err) {
      this.sendTo(conn, { type: "ERROR", error: this.parseErrorCode(err) });
    }
  }

  private dealStartingCardsAndStart() {
    for (const [playerId, player] of Object.entries(this.state.players)) {
      if (player.timeline.length === 0) {
        const startingCard = this.pickStartingCard(playerId);
        if (startingCard) { player.timeline = [startingCard]; player.cardCount = 1; }
      }
    }
    this.startNextRound();
  }

  private handleReveal(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.state.phase !== "guessing") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }

    this.state.phase = "reveal";

    // Evaluate all placements inline (it's a synchronous event, not a phase)
    if (this.state.currentSong) {
      this.state.players = evaluateRound(
        this.state.placements,
        this.state.currentSong,
        this.state.players
      );
    }

    // Check for winner
    const winner = checkWinner(this.state.players, this.state.targetCardCount);
    if (winner) {
      this.state.phase = "ended";
      this.state.winner = winner;
    }

    this.broadcastState();
  }

  private handleNextRound(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.state.phase !== "reveal") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.startNextRound();
  }

  private startNextRound() {
    if (this.state.songs.length === 0) {
      // Playlist exhausted — end game, most cards wins
      this.state.phase = "ended";
      let topPlayer = "";
      let topCount = 0;
      for (const [playerId, player] of Object.entries(this.state.players)) {
        if (player.cardCount > topCount) {
          topCount = player.cardCount;
          topPlayer = playerId;
        }
      }
      this.state.winner = topPlayer || null;
      this.broadcastState();
      return;
    }

    // Rotate active player (round-robin over joined players)
    const playerIds = Object.keys(this.state.players);
    const currentIdx = this.state.activePlayerId
      ? playerIds.indexOf(this.state.activePlayerId)
      : -1;
    this.state.activePlayerId = playerIds[(currentIdx + 1) % playerIds.length] ?? null;

    // Prefer a song whose year doesn't collide with the active player's timeline.
    const activeTimeline = this.state.activePlayerId
      ? (this.state.players[this.state.activePlayerId]?.timeline ?? [])
      : [];
    const usedYears = new Set(activeTimeline.map((c) => c.year));
    const preferredIdx =
      usedYears.size > 0
        ? this.state.songs.findIndex((s) => !usedYears.has(s.year))
        : 0;
    const songIdx = preferredIdx !== -1 ? preferredIdx : 0;
    const [nextSong] = this.state.songs.splice(songIdx, 1);
    this.state.currentSong = nextSong;
    this.state.placements = {};
    this.state.phase = "guessing";
    this.state.currentRound += 1;

    this.broadcastState();
  }

  // ── Lyrics Mode ─────────────────────────────────────────────────────────────

  private sanitizedLyricsState(): PublicLyricsGameState | null {
    if (!this.lyricsState) return null;
    const ls = this.lyricsState;
    const round = ls.currentRound;
    const publicRound = round
      ? {
          videoId: round.videoId,
          title: round.title,
          artist: round.artist,
          language: round.language,
          lyricContext: round.lyricContext,
          // blankSentence revealed only after guessing phase ends
          blankSentence: ls.phase === "guessing" || ls.phase === "loading" || ls.phase === "playing" ? null : round.blankSentence,
        }
      : null;
    // In preview, send all rounds with answers revealed so the host can review them.
    const publicRounds: PublicLyricsRound[] = ls.phase === "preview"
      ? ls.rounds.map((r) => ({ videoId: r.videoId, title: r.title, artist: r.artist, language: r.language, lyricContext: r.lyricContext, blankSentence: r.blankSentence }))
      : [];
    return { ...ls, currentRound: publicRound, rounds: publicRounds };
  }

  private broadcastLyricsState() {
    const state = this.sanitizedLyricsState();
    if (state) this.broadcast({ type: "LYRICS_STATE", state });
  }

  private async handleStartLyricsGame(
    conn: Party.Connection,
    hostId: string,
    playlistUrl: string,
    config: LyricsGameConfig,
    lyricOverrides?: { videoId: string; lyricContext?: string; blankSentence?: string; acceptableVariants?: string[]; skip?: boolean }[]
  ) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (this.state.hostId === "") {
      if (this.hostConnId !== "" && conn.id !== this.hostConnId) {
        this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
        return;
      }
      this.state.hostId = hostId;
      this.hostConnId = conn.id;
    } else if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }

    this.lyricsConfig = {
      timerSeconds: Math.max(10, Math.min(config.timerSeconds ?? LYRICS_DEFAULT_TIMER, 300)),
      totalRounds: Math.max(1, Math.min(config.totalRounds ?? LYRICS_DEFAULT_ROUNDS, 30)),
      fuzzyEnabled: config.fuzzyEnabled === true,
    };

    const playlistId = extractPlaylistId(playlistUrl);
    const players: LyricsGameState["players"] = {};
    for (const [pid, p] of Object.entries(this.state.players)) {
      players[pid] = { name: p.name, score: 0, connected: p.connected };
    }

    this.lyricsState = {
      mode: "lyrics",
      phase: "loading",
      players,
      rounds: [],
      currentRound: null,
      roundStart: null,
      timerSeconds: this.lyricsConfig.timerSeconds,
      answers: {},
      totalRounds: this.lyricsConfig.totalRounds,
      currentRoundIndex: 0,
      consecutiveSkips: 0,
    };
    this.broadcastLyricsState();

    try {
      const { anthropicKey, youtubeKey } = this.resolveEnv();

      // Resolve playlist songs (reuse cached AI metadata)
      let tracks: TrackItem[] = [];
      if (playlistUrl === "hitster://test" || playlistUrl === "hitster://cpop-test") {
        const pending = this.pendingPlaylist;
        tracks = (pending?.allSongs ?? []).map((s) => ({ videoId: s.videoId, title: s.title, description: "", channelTitle: s.artist }));
      } else if (this.pendingPlaylist?.playlistId === playlistId) {
        tracks = this.pendingPlaylist.allSongs.map((s) => ({ videoId: s.videoId, title: s.title, description: "", channelTitle: s.artist }));
      } else if (PLAYLIST_ID_PATTERN.test(playlistId)) {
        tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      } else {
        this.sendTo(conn, { type: "ERROR", error: "playlist_load_failed" });
        this.abortLyricsStart();
        return;
      }

      if (tracks.length === 0) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        this.abortLyricsStart();
        return;
      }

      // Resolve AI metadata for title/artist cleanup (needed for lyrics prompt quality)
      const aiMeta = await this.resolveAIWithCache(tracks, anthropicKey);
      const enrichedTracks = tracks.map((t) => {
        const meta = aiMeta.get(t.videoId);
        return {
          videoId: t.videoId,
          title: meta?.title ?? t.title,
          artist: meta?.artist ?? t.channelTitle,
          year: meta?.year ?? 0,
        };
      });

      // Check DO lyrics cache
      const lyricsCacheRaw = await this.storageBatchGet<LyricsResult>(
        enrichedTracks.map((t) => `lyrics:${t.videoId}`)
      );
      const cachedLyrics = new Map<string, LyricsResult>(
        [...lyricsCacheRaw].map(([k, v]) => [k.slice(7), v])
      );
      const uncachedTracks = enrichedTracks.filter((t) => !cachedLyrics.has(t.videoId));

      // Use preloaded Haiku preview as the candidate pool.
      // Then re-resolve the actual game deck songs with Sonnet for higher quality.
      const candidatePool = this.lyricsPreviewMap.size > 0
        ? this.lyricsPreviewMap
        : new Map([...cachedLyrics]);

      // Pick which tracks will be in the deck (shuffle, take totalRounds).
      const candidateTracks = enrichedTracks.filter((t) => {
        const ov = (lyricOverrides ?? []).find((o) => o.videoId === t.videoId);
        return !ov?.skip;
      });
      const deckCandidates = candidateTracks
        .sort(() => Math.random() - 0.5)
        .slice(0, this.lyricsConfig.totalRounds * 3); // oversample to handle Sonnet skips

      // Re-resolve deck candidates with Sonnet for accuracy. Cache keyed with model suffix.
      const sonnetCacheRaw = await this.storageBatchGet<LyricsResult>(
        deckCandidates.map((t) => `lyrics-sonnet:${t.videoId}`)
      );
      const sonnetCached = new Map<string, LyricsResult>(
        [...sonnetCacheRaw].map(([k, v]) => [k.slice(14), v])
      );
      const sonnetUncached = deckCandidates.filter((t) => !sonnetCached.has(t.videoId));

      const sonnetFresh = anthropicKey && sonnetUncached.length > 0
        ? await resolveLyricsForTracks(sonnetUncached, anthropicKey, undefined, MODEL_GAME)
        : new Map<string, LyricsResult>();

      if (sonnetFresh.size > 0) {
        const entries = [...sonnetFresh].map(([id, l]) => [`lyrics-sonnet:${id}`, l] as const);
        for (let i = 0; i < entries.length; i += 128) {
          this.room.storage.put(Object.fromEntries(entries.slice(i, i + 128))).catch(() => {});
        }
      }

      // For the deck: prefer Sonnet result, fall back to Haiku preview, then raw cache.
      const sonnetAll = new Map([...sonnetCached, ...sonnetFresh]);
      const allLyrics = new Map<string, LyricsResult>();
      for (const t of enrichedTracks) {
        const best = sonnetAll.get(t.videoId) ?? candidatePool.get(t.videoId) ?? cachedLyrics.get(t.videoId);
        if (best) allLyrics.set(t.videoId, best);
      }

      // Build deck: apply lyricOverrides, filter skipped songs
      const overrideMap = new Map((lyricOverrides ?? []).map((o) => [o.videoId, o]));
      const deck: LyricsRound[] = [];
      for (const t of enrichedTracks) {
        const ov = overrideMap.get(t.videoId);
        if (ov?.skip) continue;
        const base = allLyrics.get(t.videoId);
        if (!base) continue;
        deck.push({
          videoId: t.videoId,
          title: base.title,
          artist: base.artist,
          language: base.language,
          lyricContext: ov?.lyricContext ?? base.lyricContext,
          blankSentence: ov?.blankSentence ?? base.blankSentence,
          acceptableVariants: ov?.acceptableVariants ?? base.acceptableVariants,
        });
      }

      if (deck.length === 0) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        this.abortLyricsStart();
        return;
      }

      this.lyricsDeck = deck.sort(() => Math.random() - 0.5).slice(0, this.lyricsConfig.totalRounds);
      this.lyricsState.totalRounds = this.lyricsDeck.length;
      this.lyricsState.phase = "preview";
      this.lyricsState.rounds = this.lyricsDeck;
      this.lyricsState.currentRound = null;
      this.lyricsState.answers = {};
      this.broadcastLyricsState();
    } catch (err) {
      this.sendTo(conn, { type: "ERROR", error: this.parseErrorCode(err) });
      this.abortLyricsStart();
    }
  }

  // Clears lyrics state and tells all clients, so the "preparing lyrics" spinner
  // doesn't hang forever (broadcastLyricsState skips a null state).
  private abortLyricsStart() {
    this.lyricsState = null;
    this.broadcast({ type: "LYRICS_ABORTED" });
  }

  private handleConfirmLyricsPreview(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.lyricsState.phase !== "preview") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.lyricsState.phase = "playing";
    this.lyricsState.currentRound = this.lyricsDeck[0] ?? null;
    this.lyricsState.answers = {};
    this.broadcastLyricsState();
  }

  private handleStartLyricsRound(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.lyricsState.phase !== "playing") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.lyricsState.phase = "guessing";
    this.lyricsState.roundStart = Date.now();
    this.lyricsState.answers = {};
    this.broadcastLyricsState();
  }

  private handleSubmitLyricsAnswer(conn: Party.Connection, playerId: string, text: string, ts: number) {
    if (!isValidPlayerId(playerId)) return;
    const ls = this.lyricsState;
    if (!ls || ls.phase !== "guessing" || !ls.currentRound || ls.roundStart === null) return;
    if (!ls.players[playerId]) return;
    if (ls.answers[playerId]) return; // already answered

    const deadline = ls.roundStart + ls.timerSeconds * 1000 + LYRICS_ANSWER_GRACE_MS;
    if (ts > deadline) {
      this.sendTo(conn, { type: "TOO_LATE" });
      return;
    }

    // Store answer — correctness computed at SHOW_LYRICS_RESULTS time
    ls.answers[playerId] = { text: sanitizeText(text, 200), ts, correct: false, points: 0 };
    this.broadcastLyricsState();
  }

  private handleShowLyricsResults(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.lyricsState.phase !== "guessing") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    const ls = this.lyricsState;
    const round = ls.currentRound!;

    // Evaluate all submitted answers
    for (const [pid, ans] of Object.entries(ls.answers)) {
      const correct = isCorrect(ans.text, round, this.lyricsConfig);
      const points = correct ? computePoints(ls.roundStart!, ans.ts, ls.timerSeconds) : 0;
      ls.answers[pid] = { ...ans, correct, points };
      if (correct && ls.players[pid]) {
        ls.players[pid].score += points;
      }
    }

    ls.phase = "results";
    ls.consecutiveSkips = 0;
    this.broadcastLyricsState();
  }

  private handleNextLyricsRound(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.lyricsState.phase !== "results") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    const ls = this.lyricsState;
    ls.currentRoundIndex += 1;

    if (ls.currentRoundIndex >= this.lyricsDeck.length) {
      ls.phase = "ended";
      ls.currentRound = null;
    } else {
      ls.phase = "playing";
      ls.currentRound = this.lyricsDeck[ls.currentRoundIndex];
      ls.roundStart = null;
      ls.answers = {};
    }
    this.broadcastLyricsState();
  }

  private handleResetLyricsGame(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!this.lyricsState || this.lyricsState.phase !== "ended") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.lyricsDeck = [];
    // Clients keep their own lyricsState; tell them it is gone so players leave the winner screen.
    this.abortLyricsStart();
    this.broadcastState();
  }

  private handleResetGame(conn: Party.Connection, hostId: string) {
    if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (this.state.phase !== "ended") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    // Keep the same players but reset game state to lobby
    const players = this.state.players;
    this.state = this.emptyState();
    this.state.hostId = hostId;
    // Reconnect all previously joined players (clear their timelines)
    for (const [playerId, player] of Object.entries(players)) {
      this.state.players[playerId] = {
        name: player.name,
        cardCount: 0,
        timeline: [],
        connected: player.connected,
      };
    }
    this.broadcastState();
  }

  /** Picks and removes a starting card from the songs pool for a player. */
  private pickStartingCard(playerId: string): Card | null {
    if (this.state.songs.length === 0) return null;
    // Use a deterministic offset per player to avoid all players getting the same card
    const idx = Object.keys(this.state.players).indexOf(playerId) % this.state.songs.length;
    const [card] = this.state.songs.splice(idx, 1);
    return card ?? null;
  }
}

HitsterRoom satisfies Party.Worker;

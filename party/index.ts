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
} from "../lib/game";
import { isValidYear, sanitizeText } from "../lib/utils";
import {
  fetchPlaylistItems,
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
  extractCjkTrackName,
} from "../lib/youtube";
import { lookupReleaseYear, SpotifyRateLimitedError, type SpotifyTrackResult } from "../lib/spotify";
import { lookupYearFromItunes, type ItunesTrackResult } from "../lib/itunes";
import { lookupYearFromKnowledgeGraph, KnowledgeGraphBlockedError } from "../lib/googlekg";
import { lookupYearFromYTMusic } from "../lib/ytmusic";

const DEFAULT_TARGET_CARD_COUNT = 10;
const MAX_TARGET_CARD_COUNT = 20;
const SPOTIFY_BATCH_SIZE = 5;
const MAX_PLAYERS_SOFT = 8;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{5,64}$/;

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
  diagnostics: SongDiagnostic[];
  spotifyRateLimited: boolean;
  kgBlocked: boolean;
};

export default class HitsterRoom implements Party.Server {
  state: GameState;
  private pendingPlaylist: PendingPlaylist | null = null;
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

  private isValidHostId(hostId: string): boolean {
    return this.state.hostId !== "" && hostId === this.state.hostId;
  }

  private resolveEnv() {
    return {
      youtubeKey:
        (this.room.env?.["pkvar-YOUTUBE_API_KEY"] as string | undefined) ??
        (this.room.env?.YOUTUBE_API_KEY as string | undefined) ??
        process.env.YOUTUBE_API_KEY,
      spotifyClientId:
        (this.room.env?.["pkvar-SPOTIFY_CLIENT_ID"] as string | undefined) ??
        (this.room.env?.SPOTIFY_CLIENT_ID as string | undefined) ??
        process.env.SPOTIFY_CLIENT_ID,
      spotifyClientSecret:
        (this.room.env?.["pkvar-SPOTIFY_CLIENT_SECRET"] as string | undefined) ??
        (this.room.env?.SPOTIFY_CLIENT_SECRET as string | undefined) ??
        process.env.SPOTIFY_CLIENT_SECRET,
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
      this.pendingPlaylist = { playlistId, songs: [], diagnostics: [], spotifyRateLimited: false, kgBlocked: false };
      this.sendTo(conn, { type: "PLAYLIST_READY", songCount: 20, songs: [] });
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

    // Helper: build a partial playlist snapshot from whatever year sources have resolved so far.
    const buildSnapshot = (spotifyRateLimited: boolean, kgBlocked: boolean) => {
      const songs: Card[] = [];
      const diagnostics: SongDiagnostic[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const { descYear, titleYear, artist } = metas[i];
        const ytmYear = ytmYears.get(i) ?? null;
        const spotify = spotifyResults.get(i) ?? null;
        const spotifyYear = spotify?.year ?? null;
        const year = descYear ?? titleYear ?? ytmYear ?? spotifyYear ?? null;
        const src: Card["yearSource"] = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : "spotify";
        const cleanTitle = spotify?.title ?? tracks[i].title;
        const cleanArtist = spotify?.artist ?? artist;
        diagnostics.push({ title: cleanTitle, artist: cleanArtist, year, yearSource: year ? src : null });
        if (year) songs.push({ id: tracks[i].videoId, videoId: tracks[i].videoId, title: cleanTitle, artist: cleanArtist, year, yearSource: src });
      }
      return { songs, diagnostics, spotifyRateLimited, kgBlocked };
    };

    // Declare outside try so buildSnapshot can close over them.
    let tracks: Awaited<ReturnType<typeof fetchPlaylistItems>> = [];
    type TrackMeta = { artist: string; trackName: string; descYear: number | null; titleYear: number | null };
    let metas: TrackMeta[] = [];
    const ytmYears = new Map<number, number>();
    const spotifyResults = new Map<number, SpotifyTrackResult>();

    try {
      const { youtubeKey, spotifyClientId, spotifyClientSecret } = this.resolveEnv();

      tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      let kgBlocked = false;

      metas = tracks.map((track) => {
        const descMeta = parseYouTubeMusicDescription(track.description);
        const titleYear = extractYearFromTitle(track.title);
        const titleParsed = parseArtistAndTrack(track.title);
        const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
        const trackName = titleParsed?.track ?? extractCjkTrackName(track.title) ?? track.title;
        return { artist, trackName, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
      });

      // Send initial status so host sees the song list immediately.
      this.sendTo(conn, {
        type: "DIAGNOSTIC",
        songs: tracks.map((t, i) => ({ title: t.title, artist: metas[i].artist, year: null, yearSource: null })),
        status: { spotifyRateLimited: false, kgBlocked: false },
      });

      // ── Pass 1: YouTube Music ────────────────────────────────────────────────
      const YTM_BATCH = 5;
      for (let i = 0; i < tracks.length; i += YTM_BATCH) {
        if (this.abortLoad || mySeq !== this.loadSeq) break;
        const batch = Array.from({ length: Math.min(YTM_BATCH, tracks.length - i) }, (_, j) => i + j);
        await Promise.all(
          batch.map(async (idx) => {
            const { descYear, titleYear, artist, trackName } = metas[idx];
            if (descYear ?? titleYear) return;
            const y = await lookupYearFromYTMusic(artist, trackName).catch(() => null);
            if (y) ytmYears.set(idx, y);
          })
        );
        // Push YTM progress after each batch.
        this.sendTo(conn, {
          type: "DIAGNOSTIC",
          songs: tracks.map((t, i) => {
            const { descYear, titleYear, artist } = metas[i];
            const ytmYear = ytmYears.get(i) ?? null;
            const year = descYear ?? titleYear ?? ytmYear ?? null;
            const yearSource = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : null;
            return { title: t.title, artist, year, yearSource };
          }),
          status: { spotifyRateLimited: false, kgBlocked },
        });
        // Cache partial results so an abort between batches has something to use.
        this.pendingPlaylist = { playlistId, ...buildSnapshot(false, kgBlocked) };
      }

      // Abort checkpoint after YTM pass.
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          const snap = buildSnapshot(false, kgBlocked);
          this.pendingPlaylist = { playlistId, ...snap };
          this.sendTo(conn, snap.songs.length >= 2
            ? { type: "PLAYLIST_READY", songCount: snap.songs.length, songs: snap.songs.map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, year: s.year })) }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      // ── Pass 2: Spotify (paired batches, 200 ms between pairs) ──────────────
      // Running 2 songs concurrently at 5 req/s is the same throughput limit as
      // the old single-at-a-time approach but halves wall-clock time per song.
      // The previous burst (25 simultaneous calls) reliably triggered 429s; 2
      // concurrent calls never will.
      let spotifyRateLimited = false;
      if (spotifyClientId && spotifyClientSecret) {
        const toQuery = tracks.map((_, i) => i).filter(
          (i) => !(metas[i].descYear ?? metas[i].titleYear ?? ytmYears.get(i))
        );
        for (let b = 0; b < toQuery.length && !spotifyRateLimited && !this.abortLoad && mySeq === this.loadSeq; b += 2) {
          const pair = toQuery.slice(b, b + 2);
          await Promise.allSettled(
            pair.map(async (idx) => {
              if (spotifyRateLimited) return;
              const { artist, trackName } = metas[idx];
              try {
                const result = await lookupReleaseYear(artist, trackName, spotifyClientId, spotifyClientSecret);
                if (result) spotifyResults.set(idx, result);
              } catch (err) {
                if (err instanceof SpotifyRateLimitedError) spotifyRateLimited = true;
              }
            })
          );
          if (b + 2 < toQuery.length) await new Promise((r) => setTimeout(r, 200));
        }
        this.sendTo(conn, {
          type: "DIAGNOSTIC",
          songs: tracks.map((t, i) => {
            const { descYear, titleYear, artist } = metas[i];
            const ytmYear = ytmYears.get(i) ?? null;
            const spotify = spotifyResults.get(i) ?? null;
            const spotifyYear = spotify?.year ?? null;
            const year = descYear ?? titleYear ?? ytmYear ?? spotifyYear ?? null;
            const yearSource = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : spotifyYear ? "spotify" : null;
            return { title: spotify?.title ?? t.title, artist: spotify?.artist ?? artist, year, yearSource };
          }),
          status: { spotifyRateLimited, kgBlocked },
        });
        // Update cached snapshot after Spotify pass.
        this.pendingPlaylist = { playlistId, ...buildSnapshot(spotifyRateLimited, kgBlocked) };
      }

      // Abort checkpoint after Spotify pass.
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          const snap = buildSnapshot(spotifyRateLimited, kgBlocked);
          this.pendingPlaylist = { playlistId, ...snap };
          this.sendTo(conn, snap.songs.length >= 2
            ? { type: "PLAYLIST_READY", songCount: snap.songs.length, songs: snap.songs.map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, year: s.year })) }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      // ── Pass 3: iTunes + KG ──────────────────────────────────────────────────
      const BATCH = SPOTIFY_BATCH_SIZE;
      const songs: Card[] = [];
      const diagnostics: SongDiagnostic[] = [];
      for (let i = 0; i < tracks.length; i += BATCH) {
        if (this.abortLoad || mySeq !== this.loadSeq) break;
        const batch = tracks.slice(i, i + BATCH);
        const batchKgBlocked = kgBlocked;
        const results = await Promise.allSettled(
          batch.map(async (track, j) => {
            const idx = i + j;
            const { descYear, titleYear, artist, trackName } = metas[idx];
            const ytmYear = ytmYears.get(idx) ?? null;
            const spotify = spotifyResults.get(idx) ?? null;
            const spotifyYear = spotify?.year ?? null;
            let year: number | null = descYear ?? titleYear ?? ytmYear ?? spotifyYear;
            let yearSource: Card["yearSource"] = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : spotifyYear ? "spotify" : "itunes";
            let cleanTitle = spotify?.title ?? track.title;
            let cleanArtist = spotify?.artist ?? artist;
            let itunesResult: ItunesTrackResult | null = null;
            if (!year) {
              itunesResult = await lookupYearFromItunes(artist, trackName).catch(() => null);
              if (itunesResult) {
                year = itunesResult.year;
                yearSource = "itunes";
                cleanTitle = itunesResult.title;
                cleanArtist = itunesResult.artist;
              }
            }
            if (!year && youtubeKey && !batchKgBlocked) {
              try {
                year = await lookupYearFromKnowledgeGraph(artist, trackName, youtubeKey);
                if (year) yearSource = "google";
              } catch (err) {
                if (err instanceof KnowledgeGraphBlockedError) kgBlocked = true;
              }
            }
            return { track, cleanTitle, cleanArtist, year, yearSource };
          })
        );

        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { track, cleanTitle, cleanArtist, year, yearSource } = result.value;
          diagnostics.push({ title: cleanTitle, artist: cleanArtist, year, yearSource: year ? yearSource : null });
          if (year) {
            songs.push({ id: track.videoId, videoId: track.videoId, title: cleanTitle, artist: cleanArtist, year, yearSource } satisfies Card);
          }
        }

        this.sendTo(conn, {
          type: "DIAGNOSTIC",
          songs: [...diagnostics],
          status: { spotifyRateLimited, kgBlocked },
        });
        // Keep partial cached result current throughout this pass.
        this.pendingPlaylist = { playlistId, songs: [...songs], diagnostics: [...diagnostics], spotifyRateLimited, kgBlocked };
      }

      // Abort checkpoint after iTunes/KG pass (or mid-pass).
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          const count = songs.length;
          this.sendTo(conn, count >= 2
            ? { type: "PLAYLIST_READY", songCount: count, songs: songs.map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, year: s.year })) }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      this.pendingPlaylist = { playlistId, songs, diagnostics, spotifyRateLimited, kgBlocked };

      if (songs.length < 2) {
        this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        return;
      }

      this.sendTo(conn, {
        type: "PLAYLIST_READY",
        songCount: songs.length,
        songs: songs.map((s) => ({ videoId: s.videoId, title: s.title, artist: s.artist, year: s.year })),
      });
    } catch (err) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: this.parseErrorCode(err) });
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

    const cards: Card[] = songs
      .filter(
        (s) =>
          typeof s.videoId === "string" &&
          s.videoId.length > 0 &&
          typeof s.title === "string" &&
          s.title.trim().length > 0 &&
          typeof s.year === "number" &&
          isValidYear(s.year)
      )
      .map((s) => ({
        id: s.videoId,
        videoId: s.videoId,
        title: sanitizeText(s.title, 200),
        artist: sanitizeText(s.artist ?? "", 100),
        year: s.year,
        yearSource: "manual" as const,
      }));

    if (cards.length < 2) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
      return;
    }

    this.pendingPlaylist = {
      playlistId,
      songs: cards,
      diagnostics: cards.map((c) => ({
        title: c.title,
        artist: c.artist,
        year: c.year,
        yearSource: null,
      })),
      spotifyRateLimited: false,
      kgBlocked: false,
    };

    this.sendTo(conn, {
      type: "PLAYLIST_READY",
      songCount: cards.length,
      songs: cards.map((c) => ({ videoId: c.videoId, title: c.title, artist: c.artist, year: c.year })),
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
      const cpopSongs: Card[] = [
        { id: "cpop-0", videoId: "KqjgLbKZ1h0", title: "那些年", artist: "胡夏", year: 2012, yearSource: "ytmusic" },
        { id: "cpop-1", videoId: "vsBf_0gDxSM", title: "可惜沒如果", artist: "林俊傑 JJ Lin", year: 2014, yearSource: "ytmusic" },
        { id: "cpop-2", videoId: "_sQSXwdtxlY", title: "小幸運", artist: "田馥甄 Hebe Tien", year: 2015, yearSource: "ytmusic" },
        { id: "cpop-3", videoId: "bu7nU9Mhpyo", title: "告白氣球", artist: "周杰倫 Jay Chou", year: 2016, yearSource: "ytmusic" },
        { id: "cpop-4", videoId: "T4SimnaiktU", title: "光年之外", artist: "G.E.M. 鄧紫棋", year: 2016, yearSource: "ytmusic" },
        { id: "cpop-5", videoId: "wSBXfzgqHtE", title: "你，好不好？", artist: "周興哲 Eric Chou", year: 2016, yearSource: "ytmusic" },
        { id: "cpop-6", videoId: "sg_WE0ToJjM", title: "體面", artist: "于文文", year: 2017, yearSource: "ytmusic" },
        { id: "cpop-7", videoId: "Dnj5Tcpev0Q", title: "年少有為", artist: "李榮浩 Ronghao Li", year: 2018, yearSource: "ytmusic" },
      ];
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
      if (pending.songs.length < 2) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        return;
      }
      // Apply host-side edits (year/title/artist overrides from PlaylistEditor).
      if (songOverrides && songOverrides.length > 0) {
        const overrideMap = new Map(songOverrides.map((s) => [s.videoId, s]));
        pending.songs = pending.songs.map((card) => {
          const ov = overrideMap.get(card.videoId);
          if (!ov) return card;
          return {
            ...card,
            title: sanitizeText(ov.title) || card.title,
            artist: sanitizeText(ov.artist) || card.artist,
            year: isValidYear(ov.year) ? ov.year : card.year,
          };
        });
      }
      this.state.songs = [...pending.songs].sort(() => Math.random() - 0.5);
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
      const { youtubeKey, spotifyClientId, spotifyClientSecret } = this.resolveEnv();
      const tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      const songs: Card[] = [];
      const diagnostics: SongDiagnostic[] = [];
      let kgBlocked = false;
      type TrackMeta = { artist: string; trackName: string; descYear: number | null; titleYear: number | null };
      const metas: TrackMeta[] = tracks.map((track) => {
        const descMeta = parseYouTubeMusicDescription(track.description);
        const titleYear = extractYearFromTitle(track.title);
        const titleParsed = parseArtistAndTrack(track.title);
        const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
        const trackName = titleParsed?.track ?? extractCjkTrackName(track.title) ?? track.title;
        return { artist, trackName, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
      });
      const YTM_BATCH = 5;
      const ytmYears = new Map<number, number>();
      for (let i = 0; i < tracks.length; i += YTM_BATCH) {
        const batch = Array.from({ length: Math.min(YTM_BATCH, tracks.length - i) }, (_, j) => i + j);
        await Promise.all(batch.map(async (idx) => {
          const { descYear, titleYear, artist, trackName } = metas[idx];
          if (descYear ?? titleYear) return;
          const y = await lookupYearFromYTMusic(artist, trackName).catch(() => null);
          if (y) ytmYears.set(idx, y);
        }));
      }
      let spotifyRateLimited = false;
      const spotifyResultsFallback = new Map<number, SpotifyTrackResult>();
      if (spotifyClientId && spotifyClientSecret) {
        for (let i = 0; i < tracks.length; i++) {
          const { descYear, titleYear, artist, trackName } = metas[i];
          if (descYear ?? titleYear ?? ytmYears.get(i)) continue;
          if (spotifyRateLimited) break;
          try {
            const result = await lookupReleaseYear(artist, trackName, spotifyClientId, spotifyClientSecret);
            if (result) spotifyResultsFallback.set(i, result);
          } catch (err) {
            if (err instanceof SpotifyRateLimitedError) spotifyRateLimited = true;
          }
          if (i < tracks.length - 1) await new Promise((r) => setTimeout(r, 200));
        }
      }
      this.sendTo(conn, {
        type: "DIAGNOSTIC",
        songs: tracks.map((t, i) => {
          const { descYear, titleYear, artist } = metas[i];
          const ytmYear = ytmYears.get(i) ?? null;
          const spotify = spotifyResultsFallback.get(i) ?? null;
          const spotifyYear = spotify?.year ?? null;
          const year = descYear ?? titleYear ?? ytmYear ?? spotifyYear ?? null;
          const yearSource = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : year ? "spotify" : null;
          return { title: spotify?.title ?? t.title, artist: spotify?.artist ?? artist, year, yearSource };
        }),
        status: { spotifyRateLimited, kgBlocked },
      });
      const BATCH = SPOTIFY_BATCH_SIZE;
      for (let i = 0; i < tracks.length; i += BATCH) {
        const batch = tracks.slice(i, i + BATCH);
        const batchKgBlocked = kgBlocked;
        const results = await Promise.allSettled(batch.map(async (track, j) => {
          const idx = i + j;
          const { descYear, titleYear, artist, trackName } = metas[idx];
          const ytmYear = ytmYears.get(idx) ?? null;
          const spotify = spotifyResultsFallback.get(idx) ?? null;
          const spotifyYear = spotify?.year ?? null;
          let year: number | null = descYear ?? titleYear ?? ytmYear ?? spotifyYear;
          let yearSource: Card["yearSource"] = descYear ? "description" : titleYear ? "title" : ytmYear ? "ytmusic" : spotifyYear ? "spotify" : "itunes";
          let cleanTitle = spotify?.title ?? track.title;
          let cleanArtist = spotify?.artist ?? artist;
          if (!year) {
            const itunesResult = await lookupYearFromItunes(artist, trackName).catch(() => null);
            if (itunesResult) {
              year = itunesResult.year;
              yearSource = "itunes";
              cleanTitle = itunesResult.title;
              cleanArtist = itunesResult.artist;
            }
          }
          if (!year && youtubeKey && !batchKgBlocked) {
            try { year = await lookupYearFromKnowledgeGraph(artist, trackName, youtubeKey); if (year) yearSource = "google"; }
            catch (err) { if (err instanceof KnowledgeGraphBlockedError) kgBlocked = true; }
          }
          return { track, cleanTitle, cleanArtist, year, yearSource };
        }));
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { track, cleanTitle, cleanArtist, year, yearSource } = result.value;
          diagnostics.push({ title: cleanTitle, artist: cleanArtist, year, yearSource: year ? yearSource : null });
          if (year) songs.push({ id: track.videoId, videoId: track.videoId, title: cleanTitle, artist: cleanArtist, year, yearSource } satisfies Card);
        }
        this.sendTo(conn, { type: "DIAGNOSTIC", songs: [...diagnostics], status: { spotifyRateLimited, kgBlocked } });
      }
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

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
  fetchEmbeddableVideoIds,
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
} from "../lib/youtube";
import { resolveTracksWithAI } from "../lib/ai-metadata";

const DEFAULT_TARGET_CARD_COUNT = 10;
const MAX_TARGET_CARD_COUNT = 20;
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

    // Tracks and metas declared outside the try so the abort handler can reference them.
    let tracks: Awaited<ReturnType<typeof fetchPlaylistItems>> = [];
    type TrackMeta = { artist: string; descYear: number | null; titleYear: number | null };
    let metas: TrackMeta[] = [];

    try {
      const { youtubeKey, anthropicKey } = this.resolveEnv();

      tracks = await fetchPlaylistItems(playlistId, youtubeKey);

      // Filter out videos with embedding disabled before year resolution.
      const embeddable = await fetchEmbeddableVideoIds(tracks.map((t) => t.videoId), youtubeKey);
      const skippedCount = tracks.length - embeddable.size;
      tracks = tracks.filter((t) => embeddable.has(t.videoId));

      // Fast pre-parse: extract artist/year from structured descriptions and title brackets.
      // Description year (YouTube Music "Released on: YYYY") is highly reliable — we keep
      // it as the authoritative source and don't ask the AI to re-derive it.
      metas = tracks.map((track) => {
        const descMeta = parseYouTubeMusicDescription(track.description);
        const titleYear = extractYearFromTitle(track.title);
        const titleParsed = parseArtistAndTrack(track.title);
        const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
        return { artist, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
      });

      // Send initial DIAGNOSTIC immediately so the host sees the song list.
      this.sendTo(conn, {
        type: "DIAGNOSTIC",
        songs: tracks.map((t, i) => ({ title: t.title, artist: metas[i].artist, year: null, yearSource: null })),
        status: { spotifyRateLimited: false, kgBlocked: false },
        ...(skippedCount > 0 ? { skippedEmbeddingCount: skippedCount } : {}),
      });

      // ── AI metadata resolution ───────────────────────────────────────────────
      // Only send tracks that don't already have a year from description/title —
      // no point paying the AI to re-derive what we already know.
      const tracksNeedingAI = tracks.filter((_, i) => !metas[i].descYear && !metas[i].titleYear);
      const aiResults = anthropicKey && tracksNeedingAI.length > 0
        ? await resolveTracksWithAI(tracksNeedingAI, anthropicKey, (partial) => {
            if (this.abortLoad || mySeq !== this.loadSeq) return;
            const diagSongs: SongDiagnostic[] = tracks.map((t, i) => {
              const { descYear, titleYear, artist } = metas[i];
              const ai = partial.get(t.videoId);
              const year = descYear ?? titleYear ?? ai?.year ?? null;
              const yearSource: SongDiagnostic["yearSource"] =
                descYear ? "description" : titleYear ? "title" : ai?.year ? "ai" : null;
              return { title: ai?.title ?? t.title, artist: ai?.artist ?? artist, year, yearSource };
            });
            const partialSongs: Card[] = tracks
              .map((t, i) => {
                const d = diagSongs[i];
                if (d.year == null) return null;
                return { id: t.videoId, videoId: t.videoId, title: d.title, artist: d.artist, year: d.year, yearSource: d.yearSource as Card["yearSource"] };
              })
              .filter((s): s is Card => s !== null);
            this.pendingPlaylist = { playlistId, songs: partialSongs, diagnostics: diagSongs, spotifyRateLimited: false, kgBlocked: false };
            this.sendTo(conn, { type: "DIAGNOSTIC", songs: diagSongs, status: { spotifyRateLimited: false, kgBlocked: false } });
          })
        : new Map();

      // Abort checkpoint after AI pass.
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          // Cast via unknown to break TS 5.x class-field narrowing (pendingPlaylist
          // was set to null earlier; TS doesn't see the callback assignment).
          const abortPending = this.pendingPlaylist as unknown as PendingPlaylist | null;
          const abortSongs = abortPending?.songs ?? [];
          this.sendTo(conn, abortSongs.length >= 2
            ? { type: "PLAYLIST_READY", songCount: abortSongs.length, songs: abortSongs.map((s: Card) => ({ videoId: s.videoId, title: s.title, artist: s.artist, year: s.year })) }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      // ── Final merge ──────────────────────────────────────────────────────────
      // Priority: description year > title-embedded year > AI year
      // For title/artist: AI wins over raw YouTube title (cleaner names).
      const songs: Card[] = [];
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
        if (year) {
          songs.push({ id: t.videoId, videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year, yearSource: yearSource as Card["yearSource"] } satisfies Card);
        }
      }

      this.pendingPlaylist = { playlistId, songs, diagnostics, spotifyRateLimited: false, kgBlocked: false };

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
      const { youtubeKey, anthropicKey } = this.resolveEnv();
      const tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      const metas = tracks.map((track) => {
        const descMeta = parseYouTubeMusicDescription(track.description);
        const titleYear = extractYearFromTitle(track.title);
        const titleParsed = parseArtistAndTrack(track.title);
        const artist = descMeta.artist ?? titleParsed?.artist ?? channelToArtist(track.channelTitle);
        return { artist, descYear: descMeta.year ?? null, titleYear: titleYear ?? null };
      });

      const tracksNeedingAI = tracks.filter((_, i) => !metas[i].descYear && !metas[i].titleYear);
      const aiResults = anthropicKey && tracksNeedingAI.length > 0
        ? await resolveTracksWithAI(tracksNeedingAI, anthropicKey)
        : new Map();

      const songs: Card[] = [];
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
        if (year) {
          songs.push({ id: t.videoId, videoId: t.videoId, title: cleanTitle, artist: cleanArtist, year, yearSource: yearSource as Card["yearSource"] } satisfies Card);
        }
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

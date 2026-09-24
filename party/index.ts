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
  type GuessGameState,
  type GuessGameConfig,
  type GuessRound,
  type PublicGuessGameState,
  type EditableLyricRound,
  type GameMode,
  type LyricOverride,
} from "../lib/game";
import { isValidYear, sanitizeText, shuffle } from "../lib/utils";
import { proposeEdits, proposeLyricEdits, type AITrackMeta } from "../lib/ai-metadata";
import { resolveLyricsForTracks, MODEL_GAME, type LyricsResult } from "../lib/lyrics-resolver";
import { fetchPopularitySummaries } from "../lib/lyrics-popularity";
import * as timedRound from "./timed-round";
import { scoreGuess, decodeEntities, normGuess } from "../lib/guess-scoring";
import { isCorrect, computePoints } from "../lib/fuzzy";
import {
  resolvePlaylistFromUrl,
  fetchAndFilterTracks,
  resolveAIWithCache,
  resolveEnv,
  parseResolveErrorCode,
  storageBatchGet,
  buildCardsFromAI,
  PLAYLIST_ID_PATTERN,
  type TrackItem,
} from "../lib/playlist-resolver";

const DEFAULT_TARGET_CARD_COUNT = 10;
const MAX_TARGET_CARD_COUNT = 20;
const MAX_PLAYERS_SOFT = 8;

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
};

export default class HitsterRoom implements Party.Server {
  state: GameState;
  lyricsState: LyricsGameState | null = null;
  private lyricsConfig: LyricsGameConfig = timedRound.clampConfig({});
  private lyricsDeck: LyricsRound[] = [];
  private pendingPlaylist: PendingPlaylist | null = null;
  private lyricsPreviewMap: Map<string, LyricsResult> = new Map();
  guessState: GuessGameState | null = null;
  private guessConfig: GuessGameConfig = timedRound.clampConfig({});
  private abortLoad = false;
  // True while the newest LOAD_PLAYLIST is still resolving (pendingPlaylist may hold partial,
  // not-yet-AI-cleaned titles). Guess mode refuses to start then: its answers ARE those titles.
  private playlistLoading = false;
  private loadSeq = 0;
  // hostId and screenId (state.hostId / this.screenId below) both claim through the same
  // first-non-empty-value-wins model — see claimOrValidateFirstClaim. Neither depends on
  // connection order any more: a room's very first WebSocket connection is now always /screen
  // (it's what creates the room, see app/screen/page.tsx), so a connection-order gate would
  // permanently lock the real host out. Whoever sends the right value first, from any
  // connection, claims it.
  //
  // KNOWN GAP (TODOS.md, P3, accepted 2026-09-22): "whichever connection asks first" is not
  // "actually the TV / actually the host" — a player would have to deliberately open devtools
  // and send a WS message by hand to squat either slot. Low realistic risk for a house game
  // with friends; real fix (a minted token) deferred, not built here. Host's real mitigation is
  // that its hostId is never transmitted anywhere but the host's own device (see
  // app/room/[code]/screen/page.tsx's private, same-device-only "manage as host" link) — unlike
  // screenId, there's no QR/URL carrying it for a player to intercept in the first place.
  private screenId = "";
  // Connections that have proven themselves host or screen (see markPrivileged) — the only
  // ones that get the full preview-phase deck (see broadcastLyricsState and onConnect).
  // Cleaned up on disconnect (see onClose).
  private privilegedConns = new Set<Party.Connection>();
  // playerId → the conn.id currently allowed to act as that player (set on JOIN/REJOIN).
  // Fixes TODOS.md P2 "bind Lyrics answers to the sending connection" — without this, any
  // connection could submit SUBMIT_LYRICS_ANSWER as any playerId (ids are visible in broadcast
  // state). Not cleared in onClose: a REJOIN from a new connection simply overwrites the entry.
  private playerConnId: Record<string, string> = {};
  // Every currently-open connection (added in onConnect, removed in onClose — markPrivileged also
  // adds, so a privileged connection is always a member even in tests that skip onConnect). Lets
  // broadcastLyricsState reach a not-yet-privileged /screen during preview with a redacted payload
  // instead of silently skipping it (see the comment there).
  private allConns = new Set<Party.Connection>();

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
      hostClaimed: false,
      winner: null,
    };
  }

  private broadcast(msg: ServerMessage) {
    this.room.broadcast(JSON.stringify(msg));
  }

  private sanitizedState(forPrivileged = false): GameState {
    const { hostId: _h, ...rest } = this.state;
    return {
      ...rest,
      hostId: "",
      // Derived signal only — "is it claimed", never the token itself. Lets /screen hide its
      // stale creator-device link once host is claimed from anywhere (see docs/designs and
      // app/room/[code]/screen/page.tsx). this.state.hostId (not the stripped copy) is the
      // real source of truth here.
      hostClaimed: this.state.hostId !== "",
      // Strip year AND video id from the whole remaining deck — a player reading `songs[]`
      // straight off the WebSocket (no rendering needed) could otherwise look up every future
      // round's real video id in advance, not just the current one. Same mechanism as
      // currentSong below; caught by adversarial review while fixing that one.
      songs: rest.songs.map((s) => ({ ...s, year: 0, videoId: forPrivileged ? s.videoId : "" })),
      currentSong: rest.currentSong
        ? {
            ...rest.currentSong,
            // Strip year from currentSong during guessing — answer not yet revealed
            year: rest.phase === "guessing" ? 0 : rest.currentSong.year,
            // Players must not get the video id: opening the real YouTube link reveals the true
            // title/upload date, defeating the year guess (same bug class as the Lyrics Mode leak
            // fixed in v0.5.0.0/v0.5.1.0 — see sanitizedLyricsState). Only the host and the big
            // screen (which actually plays it) get the real id.
            videoId: forPrivileged ? rest.currentSong.videoId : "",
          }
        : null,
    };
  }

  private broadcastState() {
    // Everyone gets the redacted STATE via the normal room broadcast, except privileged
    // connections (host, screen) — they're excluded here and sent the real video id directly
    // below instead. Keeps the common case a single room.broadcast, same as before this fix.
    const privileged = [...this.privilegedConns];
    this.room.broadcast(
      JSON.stringify({ type: "STATE", state: this.sanitizedState(false) }),
      privileged.map((c) => c.id)
    );
    if (privileged.length > 0) {
      const full = { type: "STATE" as const, state: this.sanitizedState(true) };
      for (const conn of privileged) this.sendTo(conn, full);
    }
  }

  /**
   * Host/screen only. LYRICS_PREVIEW carries every candidate's answer (blankSentence) plus each
   * song's title/artist/videoId — the whole answer key for Lyrics AND Guess mode — so it must never
   * be a room broadcast (it was, until /review 2026-09-24). Only the host page reads it, and the
   * host is privileged before any preview runs (LOAD_PLAYLIST claims it).
   */
  private sendPrivileged(msg: ServerMessage) {
    for (const conn of this.privilegedConns) this.sendTo(conn, msg);
  }

  private sendTo(conn: Party.Connection, msg: ServerMessage) {
    // A stale/closed connection can throw here; one dead socket must not abort delivery to
    // everyone else (privilegedConns in particular is iterated in a loop — see broadcastLyricsState).
    try {
      conn.send(JSON.stringify(msg));
    } catch (err) {
      console.warn("sendTo: failed to deliver a message to a connection", err);
    }
  }

  onConnect(conn: Party.Connection) {
    this.allConns.add(conn);
    const ls = this.sanitizedLyricsState();
    // A reconnecting client keeps its old lyricsState; with no game running, tell it to drop it
    // (sent before STATE so STATE stays the first-class snapshot).
    if (!ls) this.sendTo(conn, { type: "LYRICS_ABORTED" });
    const gs = this.sanitizedGuessState();
    if (!gs) this.sendTo(conn, { type: "GUESS_ABORTED" });
    this.sendTo(conn, { type: "STATE", state: this.sanitizedState() });
    if (ls) {
      // Preview-phase ls.rounds carries the full deck with answers revealed (see
      // sanitizedLyricsState). broadcastLyricsState already withholds it from non-privileged
      // connections; a fresh connect must too — this connection hasn't claimed host/screen yet
      // (that happens via a later message), so it's never privileged at this point.
      const forConn = this.privilegedConns.has(conn) ? ls : { ...ls, rounds: [] };
      this.sendTo(conn, { type: "LYRICS_STATE", state: forConn });
    }
    if (gs) this.sendTo(conn, { type: "GUESS_STATE", state: gs });
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
        await this.handleLoadPlaylist(sender, msg.hostId, msg.playlistUrl, msg.gameMode);
        break;
      case "ABORT_LOAD":
        if (this.authorizeHost(sender, msg.hostId)) this.abortLoad = true;
        break;
      case "LOAD_SAVED_PLAYLIST":
        this.handleLoadSavedPlaylist(sender, msg.hostId, msg.playlistId, msg.songs);
        break;
      case "PROPOSE_EDITS":
        await this.handleProposeEdits(sender, msg.hostId, msg.instruction, msg.songs);
        break;
      case "PROPOSE_LYRIC_EDITS":
        await this.handleProposeLyricEdits(sender, msg.hostId, msg.instruction, msg.rounds);
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
      case "GET_LYRICS_AUDIO":
        this.handleGetLyricsAudio(sender, msg.screenId);
        break;
      case "JOIN_SCREEN":
        this.handleJoinScreen(sender, msg.screenId);
        break;
      case "START_LYRICS_ROUND":
        this.handleStartLyricsRound(sender, msg.hostId);
        break;
      case "SUBMIT_LYRICS_ANSWER":
        this.handleSubmitLyricsAnswer(sender, msg.playerId, msg.text);
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
      // ── Guess Mode ───────────────────────────────────────────────────────
      case "START_GUESS_GAME":
        this.handleStartGuessGame(sender, msg.hostId, msg.config, msg.songs);
        break;
      case "START_GUESS_ROUND":
        this.handleStartGuessRound(sender, msg.hostId);
        break;
      case "SUBMIT_GUESS":
        this.handleSubmitGuess(sender, msg.playerId, msg.title, msg.artist);
        break;
      case "SHOW_GUESS_RESULTS":
        this.handleShowGuessResults(sender, msg.hostId);
        break;
      case "NEXT_GUESS_ROUND":
        this.handleNextGuessRound(sender, msg.hostId);
        break;
      case "RESET_GUESS_GAME":
        this.handleResetGuessGame(sender, msg.hostId);
        break;
      case "GET_GUESS_AUDIO":
        this.handleGetGuessAudio(sender, msg.screenId);
        break;
    }
  }

  onClose(conn: Party.Connection) {
    // No connection→playerId map in v1; players reconnect via REJOIN with their stored playerId.
    this.privilegedConns.delete(conn);
    this.allConns.delete(conn);
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
    this.playerConnId[playerId] = conn.id;

    this.broadcastState();
  }

  private handleRejoin(conn: Party.Connection, playerId: string, rawName: string) {
    if (!isValidPlayerId(playerId)) return;
    const name = sanitizeName(rawName);
    if (this.state.players[playerId]) {
      this.state.players[playerId].connected = true;
      this.state.players[playerId].name = name || this.state.players[playerId].name;
      this.playerConnId[playerId] = conn.id;
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

  /**
   * Validates an already-claimed hostId and marks the connection privileged, so preview-phase
   * broadcasts (see broadcastLyricsState) know to send it the full deck. Use for every
   * host-gated handler except the four that can be the FIRST host message — those call
   * claimOrValidateHost instead.
   */
  private authorizeHost(conn: Party.Connection, hostId: string): boolean {
    if (!this.isValidHostId(hostId)) return false;
    this.markPrivileged(conn);
    return true;
  }

  /**
   * Shared first-non-empty-value-wins claim: whichever connection sends `value` first claims
   * it (via `setValue`); every later caller must match `current` exactly. Marks the connection
   * privileged on success either way. Used identically by hostId and screenId — see the two
   * thin wrappers below and the class-field comment above `screenId` for the accepted risk
   * this model carries (any connection can claim by guessing/squatting first).
   */
  private claimOrValidateFirstClaim(
    current: string,
    value: string,
    setValue: (v: string) => void,
    conn: Party.Connection
  ): boolean {
    if (typeof value !== "string" || value === "") return false;
    if (current === "") {
      setValue(value);
    } else if (value !== current) {
      return false;
    }
    this.markPrivileged(conn);
    return true;
  }

  /**
   * The four entry points where a room's host is established: LOAD_PLAYLIST, LOAD_SAVED_PLAYLIST,
   * START_GAME, START_LYRICS_GAME. First caller to send a non-empty hostId claims it; everyone
   * else must match the claimed value exactly. Also marks the connection privileged, same as
   * authorizeHost.
   */
  private claimOrValidateHost(conn: Party.Connection, hostId: string): boolean {
    // Broadcast on the FIRST successful claim only (not on every later host action reconfirming
    // the same hostId) — this is the one signal every client, including /screen, needs to learn
    // "host claimed" for the cross-device handoff hostClaimed check. None of the 4 entry points
    // that route through this (LOAD_PLAYLIST, LOAD_SAVED_PLAYLIST, START_GAME,
    // START_LYRICS_GAME) otherwise broadcast state on their own — found live during QA: the
    // stale-tab link stayed visible after a real claim until some unrelated later broadcast.
    const wasUnclaimed = this.state.hostId === "";
    const claimed = this.claimOrValidateFirstClaim(
      this.state.hostId,
      hostId,
      (v) => { this.state.hostId = v; },
      conn
    );
    if (claimed && wasUnclaimed) this.broadcastState();
    return claimed;
  }

  /**
   * The room's screen credential works exactly like hostId, claimed lazily on first use — either
   * from JOIN_SCREEN (sent once on mount, so Timeline mode's video id starts flowing right away)
   * or GET_LYRICS_AUDIO (Lyrics mode's per-round request; claims it too if JOIN_SCREEN raced it).
   */
  private claimOrValidateScreen(conn: Party.Connection, screenId: string): boolean {
    return this.claimOrValidateFirstClaim(
      this.screenId,
      screenId,
      (v) => { this.screenId = v; },
      conn
    );
  }

  private markPrivileged(conn: Party.Connection) {
    this.privilegedConns.add(conn);
    this.allConns.add(conn);
  }

  /**
   * A Lyrics/Guess round is in play. this.state.phase stays "lobby" through those games, so the
   * lobby handlers check this too — otherwise a stray host START_GAME/LOAD_PLAYLIST mid-round
   * broadcasts the whole song list (every answer) to all players. Preview and ended are safe:
   * no round is live, and the host UI offers playlist loading during Lyrics preview.
   */
  private timedRoundInPlay(): boolean {
    const s = this.lyricsState ?? this.guessState;
    return s !== null && s.phase !== "preview" && s.phase !== "ended";
  }

  private async handleLoadPlaylist(conn: Party.Connection, hostId: string, playlistUrl: string, gameMode?: GameMode) {
    if (this.state.phase !== "lobby" || this.timedRoundInPlay()) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
      return;
    }
    if (!this.claimOrValidateHost(conn, hostId)) {
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
      const seedCards: Card[] = testSongs.map((song, i) => ({ id: `seed-${i}`, ...song }));
      this.pendingPlaylist = { playlistId, songs: seedCards, allSongs: testSongs, diagnostics: [] };
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
    this.playlistLoading = true;

    try {
      const { youtubeKey, anthropicKey } = resolveEnv(this.room.env);

      const result = await resolvePlaylistFromUrl(
        playlistId,
        { youtubeKey, anthropicKey },
        this.room.storage,
        // Send initial DIAGNOSTIC immediately so the host sees the song list, before AI runs.
        (tracks, metas, skippedCount) => {
          this.sendTo(conn, {
            type: "DIAGNOSTIC",
            songs: tracks.map((t, i) => ({ title: t.title, artist: metas[i].artist, year: null, yearSource: null })),
            ...(skippedCount > 0 ? { skippedEmbeddingCount: skippedCount } : {}),
          });
        },
        // ── AI metadata resolution (cache-backed, progressive diagnostics) ───────
        (accumulated, tracks, metas) => {
          if (this.abortLoad || mySeq !== this.loadSeq) return;
          const { songs: partialSongs, allSongs: partialAll, diagnostics: diagSongs } = buildCardsFromAI(tracks, metas, accumulated);
          this.pendingPlaylist = { playlistId, songs: partialSongs, allSongs: partialAll, diagnostics: diagSongs };
          this.sendTo(conn, { type: "DIAGNOSTIC", songs: diagSongs });
        }
      );

      // Abort checkpoint after AI pass.
      if (this.abortLoad || mySeq !== this.loadSeq) {
        if (this.abortLoad) {
          this.sendTo(conn, result.allSongs.length >= 2
            ? { type: "PLAYLIST_READY", songCount: result.allSongs.length, songs: result.allSongs }
            : { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        }
        return;
      }

      const { songs, allSongs, diagnostics, aiResults } = result;
      this.pendingPlaylist = { playlistId, songs, allSongs, diagnostics };

      if (allSongs.length < 2) {
        this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "not_enough_songs" });
        return;
      }

      this.sendTo(conn, {
        type: "PLAYLIST_READY",
        songCount: allSongs.length,
        songs: allSongs,
      });

      // Kick off lyrics generation in background immediately after playlist is ready — but only
      // when the host is actually in Lyrics mode. This used to run unconditionally on every
      // load, spending real Anthropic calls generating lyric questions even for a host who only
      // ever plays timeline mode.
      if (gameMode === "lyrics") {
        const { anthropicKey: lyricsKey } = resolveEnv(this.room.env);
        void this.generateLyricsPreview(allSongs, aiResults, lyricsKey);
      }
    } catch (err) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: parseResolveErrorCode(err) });
    } finally {
      if (mySeq === this.loadSeq) this.playlistLoading = false;
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
    this.sendPrivileged({ type: "LYRICS_PREVIEW", rounds: [], loading: true });

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
    const lyricsCacheRaw = await storageBatchGet<LyricsResult>(this.room.storage,
      enrichedTracks.map((t) => `lyrics:${t.videoId}`)
    );
    const cachedLyrics = new Map<string, LyricsResult>(
      [...lyricsCacheRaw].map(([k, v]) => [k.slice(7), v])
    );
    const uncachedTracks = enrichedTracks.filter((t) => !cachedLyrics.has(t.videoId));

    // If we have cached results, broadcast them immediately so the table is not empty.
    if (cachedLyrics.size > 0) {
      const cachedRounds = this.buildPreviewRounds(enrichedTracks, cachedLyrics);
      this.sendPrivileged({ type: "LYRICS_PREVIEW", rounds: cachedRounds, loading: uncachedTracks.length > 0 });
    }

    if (anthropicKey && uncachedTracks.length > 0) {
      // Accumulate fresh lyrics progressively, broadcasting after each batch.
      const accumulated = new Map<string, LyricsResult>(cachedLyrics);
      await resolveLyricsForTracks(uncachedTracks, anthropicKey, (partial) => {
        partial.forEach((v, k) => accumulated.set(k, v));
        const progressRounds = this.buildPreviewRounds(enrichedTracks, accumulated);
        this.sendPrivileged({ type: "LYRICS_PREVIEW", rounds: progressRounds, loading: true });
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
      this.sendPrivileged({ type: "LYRICS_PREVIEW", rounds: this.buildPreviewRounds(enrichedTracks, allLyrics), loading: false });
    } else {
      this.lyricsPreviewMap = cachedLyrics;
      this.sendPrivileged({ type: "LYRICS_PREVIEW", rounds: this.buildPreviewRounds(enrichedTracks, cachedLyrics), loading: false });
    }
  }

  private handleLoadSavedPlaylist(
    conn: Party.Connection,
    hostId: string,
    playlistId: string,
    songs: EditableSong[]
  ) {
    if (this.state.phase !== "lobby" || this.timedRoundInPlay()) {
      this.sendTo(conn, { type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
      return;
    }
    if (!this.claimOrValidateHost(conn, hostId)) {
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
    };

    this.sendTo(conn, {
      type: "PLAYLIST_READY",
      songCount: allSongs.length,
      songs: allSongs,
    });
  }

  /**
   * Chat-to-diff editing (see docs/designs/ai-assisted-quiz-generation.md, Approach A):
   * proposes field-level edits to the host's current song list from a natural-language
   * instruction. Never mutates room state itself — the diff is sent only to the requesting
   * connection, which renders it as a reviewable change (PlaylistEditor's existing dirty-row
   * state) before the host explicitly saves it, same as a manually typed edit would be.
   */
  private async handleProposeEdits(
    conn: Party.Connection,
    hostId: string,
    instruction: string,
    songs: EditableSong[]
  ) {
    if (!this.authorizeHost(conn, hostId)) {
      this.sendTo(conn, { type: "EDITS_PROPOSAL_FAILED", error: "unauthorized" });
      return;
    }
    if (!Array.isArray(songs) || songs.length === 0 || typeof instruction !== "string" || !instruction.trim()) {
      this.sendTo(conn, { type: "EDITS_PROPOSAL_FAILED", error: "invalid_request" });
      return;
    }

    try {
      const { anthropicKey } = resolveEnv(this.room.env);
      if (!anthropicKey) {
        this.sendTo(conn, { type: "EDITS_PROPOSAL_FAILED", error: "api_key_missing" });
        return;
      }
      const diff = await proposeEdits(instruction, songs, anthropicKey);
      this.sendTo(conn, { type: "EDITS_PROPOSED", diff });
    } catch (err) {
      console.error(`[handleProposeEdits] ${err instanceof Error ? err.message : "unknown_error"}`);
      this.sendTo(conn, { type: "EDITS_PROPOSAL_FAILED", error: "propose_failed" });
    }
  }

  private async handleProposeLyricEdits(
    conn: Party.Connection,
    hostId: string,
    instruction: string,
    rounds: EditableLyricRound[]
  ) {
    if (!this.authorizeHost(conn, hostId)) {
      this.sendTo(conn, { type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "unauthorized" });
      return;
    }
    if (!Array.isArray(rounds) || rounds.length === 0 || typeof instruction !== "string" || !instruction.trim()) {
      this.sendTo(conn, { type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "invalid_request" });
      return;
    }

    try {
      const { anthropicKey } = resolveEnv(this.room.env);
      if (!anthropicKey) {
        this.sendTo(conn, { type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "api_key_missing" });
        return;
      }
      const diff = await proposeLyricEdits(instruction, rounds, anthropicKey);
      this.sendTo(conn, { type: "LYRIC_EDITS_PROPOSED", diff });
    } catch (err) {
      console.error(`[handleProposeLyricEdits] ${err instanceof Error ? err.message : "unknown_error"}`);
      this.sendTo(conn, { type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "propose_failed" });
    }
  }

  private async handleStartGame(
    conn: Party.Connection,
    hostId: string,
    playlistUrl: string,
    targetCardCount?: number,
    songOverrides?: EditableSong[]
  ) {
    if (this.state.phase !== "lobby" || this.timedRoundInPlay()) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (!this.claimOrValidateHost(conn, hostId)) {
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
      const cpopSongs: Card[] = CPOP_SEED.map((c, i) => ({ id: `cpop-${i}`, ...c }));
      this.state.songs = cpopSongs;
      this.broadcast({ type: "DIAGNOSTIC", songs: cpopSongs.map((s) => ({ title: s.title, artist: s.artist, year: s.year, yearSource: "manual" as const })) });
      this.dealStartingCardsAndStart();
      return;
    }

    if (playlistUrl === "hitster://test") {
      this.state.targetCardCount = 3;
      this.state.songs = Array.from({ length: 20 }, (_, i) => ({
        id: `test-${i}`, videoId: "dQw4w9WgXcQ", title: `Test Song ${1960 + i * 3}`,
        artist: "Test Artist", year: 1960 + i * 3,
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
          resolvedCards.push({ id: s.videoId, videoId: s.videoId, title, artist, year: rawYear });
        }
      }
      if (resolvedCards.length < 2) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        return;
      }
      this.state.songs = shuffle(resolvedCards);
      this.broadcast({ type: "DIAGNOSTIC", songs: pending.diagnostics });
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
      const { youtubeKey, anthropicKey } = resolveEnv(this.room.env);
      // D3 (docs/designs/decouple-quiz-bank.md): this fallback used to skip the
      // embeddability filter handleLoadPlaylist applies — an inconsistency, not a
      // deliberate difference. resolvePlaylistFromUrl always filters now, for every caller.
      const { songs } = await resolvePlaylistFromUrl(playlistId, { youtubeKey, anthropicKey }, this.room.storage);
      if (songs.length < 2) { this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" }); return; }
      this.state.songs = shuffle(songs);
      this.dealStartingCardsAndStart();
    } catch (err) {
      this.sendTo(conn, { type: "ERROR", error: parseResolveErrorCode(err) });
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
    if (!this.authorizeHost(conn, hostId)) {
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
    if (!this.authorizeHost(conn, hostId)) {
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
          // Players must not get the video id: opening a lyric video would reveal the answer.
          // The screen fetches it through GET_LYRICS_AUDIO instead.
          videoId: "",
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
    // Answer-leak fix (TODOS.md P2, docs/designs/guess-mode-song-artist.md eng review):
    // during guessing, strip every submitted answer's raw text before it's broadcast — a
    // player who answers later than others must not be able to read earlier answers off the
    // wire before submitting their own. Keys (who has answered) and the correct/points
    // placeholders (always false/0 pre-scoring) stay, since the host's "N / M answered"
    // count (Object.keys(answers).length) and the client's own hasAnswered check depend on
    // them. Full text is safe to reveal at every other phase — results is exactly when the
    // client first actually reads answer text (host/play/screen pages all gate their .answers
    // reads on phase !== "guessing").
    const publicAnswers = timedRound.publicAnswers(ls, (a) => ({ ...a, text: "" }));
    return { ...ls, currentRound: publicRound, rounds: publicRounds, answers: publicAnswers };
  }

  private broadcastLyricsState() {
    const state = this.sanitizedLyricsState();
    if (!state) return;
    if (state.rounds.length === 0) {
      // Nothing secret in this payload (not preview, or nothing to reveal yet) — plain broadcast.
      this.broadcast({ type: "LYRICS_STATE", state });
      return;
    }
    // Preview phase: state.rounds carries the full deck with answers revealed, for the host/screen
    // to review before the game starts. Non-privileged connections (including a /screen that
    // hasn't claimed via GET_LYRICS_AUDIO yet — it only does that in playing/guessing/results, never
    // preview, see isAudioPhase) get the same redacted shape onConnect already sends them, so a
    // /screen open during the whole review window shows its "ready, waiting for host" UI instead of
    // being silently stuck on the previous "loading" screen. Players' own page has no preview-phase
    // UI either way, so this changes nothing visible for them.
    const redacted: PublicLyricsGameState = { ...state, rounds: [] };
    for (const conn of this.allConns) {
      this.sendTo(conn, { type: "LYRICS_STATE", state: this.privilegedConns.has(conn) ? state : redacted });
    }
  }

  private async handleStartLyricsGame(
    conn: Party.Connection,
    hostId: string,
    playlistUrl: string,
    config: LyricsGameConfig,
    lyricOverrides?: LyricOverride[]
  ) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (!this.claimOrValidateHost(conn, hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    // Re-entrancy guard (TODOS.md P3, /ship adversarial review 2026-09-21): unlike Timeline
    // mode, this.state.phase never leaves "lobby" for Lyrics mode, so a second START_LYRICS_GAME
    // (double click, or a client retry) would pass the check above and race this one — the
    // stale call's deck could overwrite the newer one's after both resolve. this.lyricsState is
    // set synchronously below, before any await, so this check is atomic against a concurrent
    // call: whichever invocation runs first sets it, and every later one sees it non-null and
    // bails, all before either does any real async work. Cleared only by abortLyricsStart()
    // (an error, or a host-confirmed RESET_LYRICS_GAME once the game has ended).
    if (this.lyricsState !== null || this.guessState !== null) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }

    this.lyricsConfig = timedRound.clampConfig(config);

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
    // RESET_LYRICS_GAME works in any phase, including mid-"loading" — after every await below,
    // bail if this game was reset (and maybe replaced by a new START) while we waited, so a stale
    // call never writes its deck into, or aborts, a newer game.
    const game = this.lyricsState;

    try {
      const { anthropicKey, youtubeKey } = resolveEnv(this.room.env);

      // Resolve playlist songs (reuse cached AI metadata)
      let tracks: TrackItem[] = [];
      if (playlistUrl === "hitster://test" || playlistUrl === "hitster://cpop-test") {
        const pending = this.pendingPlaylist;
        tracks = (pending?.allSongs ?? []).map((s) => ({ videoId: s.videoId, title: s.title, description: "", channelTitle: s.artist }));
      } else if (this.pendingPlaylist?.playlistId === playlistId) {
        tracks = this.pendingPlaylist.allSongs.map((s) => ({ videoId: s.videoId, title: s.title, description: "", channelTitle: s.artist }));
      } else if (PLAYLIST_ID_PATTERN.test(playlistId)) {
        // D3 (docs/designs/decouple-quiz-bank.md): this branch used to skip the
        // embeddability filter — inconsistent with handleLoadPlaylist. Now shared.
        tracks = (await fetchAndFilterTracks(playlistId, youtubeKey)).tracks;
      } else {
        this.sendTo(conn, { type: "ERROR", error: "playlist_load_failed" });
        this.abortLyricsStart();
        return;
      }

      if (this.lyricsState !== game) return;
      if (tracks.length === 0) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        this.abortLyricsStart();
        return;
      }

      // Resolve AI metadata for title/artist cleanup (needed for lyrics prompt quality)
      const aiMeta = await resolveAIWithCache(this.room.storage, tracks, anthropicKey);
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
      const lyricsCacheRaw = await storageBatchGet<LyricsResult>(this.room.storage,
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
      const deckCandidates = shuffle(candidateTracks)
        .slice(0, this.lyricsConfig.totalRounds * 3); // oversample to handle Sonnet skips

      // Re-resolve deck candidates with Sonnet for accuracy. Cache keyed with model suffix.
      const sonnetCacheRaw = await storageBatchGet<LyricsResult>(this.room.storage,
        deckCandidates.map((t) => `lyrics-sonnet:${t.videoId}`)
      );
      const sonnetCached = new Map<string, LyricsResult>(
        [...sonnetCacheRaw].map(([k, v]) => [k.slice(14), v])
      );
      const sonnetUncached = deckCandidates.filter((t) => !sonnetCached.has(t.videoId));

      // Popularity grounding (docs/designs/lyrics-question-search-grounding.md, Approach C):
      // cached per videoId like the lyrics results above, since each summary costs a real
      // Anthropic call. Only fetched for songs actually getting a fresh Sonnet resolve — the
      // deck's already-cached rounds don't need it re-fetched. Best-effort: a fetch failure for
      // any song just means that song falls back to resolveLyricsBatch's ungrounded prompt.
      let popularitySummaries = new Map<string, string>();
      if (anthropicKey && sonnetUncached.length > 0) {
        const popularityCacheRaw = await storageBatchGet<string>(this.room.storage,
          sonnetUncached.map((t) => `lyrics-popularity:${t.videoId}`)
        );
        popularitySummaries = new Map([...popularityCacheRaw].map(([k, v]) => [k.slice(18), v]));
        const popularityUncached = sonnetUncached.filter((t) => !popularitySummaries.has(t.videoId));
        if (popularityUncached.length > 0) {
          const fresh = await fetchPopularitySummaries(popularityUncached, anthropicKey);
          if (fresh.size > 0) {
            const entries = [...fresh].map(([id, s]) => [`lyrics-popularity:${id}`, s] as const);
            for (let i = 0; i < entries.length; i += 128) {
              this.room.storage.put(Object.fromEntries(entries.slice(i, i + 128))).catch(() => {});
            }
            for (const [id, s] of fresh) popularitySummaries.set(id, s);
          }
        }
      }

      const sonnetFresh = anthropicKey && sonnetUncached.length > 0
        ? await resolveLyricsForTracks(sonnetUncached, anthropicKey, undefined, MODEL_GAME, popularitySummaries)
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

      if (this.lyricsState !== game) return;
      if (deck.length === 0) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        this.abortLyricsStart();
        return;
      }

      this.lyricsDeck = shuffle(deck).slice(0, this.lyricsConfig.totalRounds);
      this.lyricsState.totalRounds = this.lyricsDeck.length;
      this.lyricsState.phase = "preview";
      this.lyricsState.rounds = this.lyricsDeck;
      this.lyricsState.currentRound = null;
      this.lyricsState.answers = {};
      this.broadcastLyricsState();
    } catch (err) {
      if (this.lyricsState !== game) return;
      this.sendTo(conn, { type: "ERROR", error: parseResolveErrorCode(err) });
      this.abortLyricsStart();
    }
  }

  // Clears lyrics state and tells all clients, so the "preparing lyrics" spinner
  // doesn't hang forever (broadcastLyricsState skips a null state).
  private abortLyricsStart() {
    this.lyricsState = null;
    this.broadcast({ type: "LYRICS_ABORTED" });
  }

  // Sent once by /screen on mount, independent of game mode — claims the screen credential right
  // away so Timeline mode's currentSong.videoId (see sanitizedState) starts flowing on the very
  // next broadcastState instead of waiting for a Lyrics-only GET_LYRICS_AUDIO that may never come.
  private handleJoinScreen(conn: Party.Connection, screenId: string) {
    if (!this.authorizeScreen(conn, screenId)) return;
    // onConnect already sent this connection a redacted STATE (it wasn't privileged yet at that
    // point) — resend the real one now instead of leaving /screen stuck without video until the
    // next unrelated state change.
    this.sendTo(conn, { type: "STATE", state: this.sanitizedState(true) });
  }

  /** Shared by JOIN_SCREEN and GET_LYRICS_AUDIO — see claimOrValidateScreen. */
  private authorizeScreen(conn: Party.Connection, screenId: string): boolean {
    if (this.claimOrValidateScreen(conn, screenId)) return true;
    this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
    return false;
  }

  // Screen-only: players never receive the video id (see sanitizedLyricsState). screenId
  // claims lazily here — see claimOrValidateScreen.
  private handleGetLyricsAudio(conn: Party.Connection, screenId: string) {
    if (!this.authorizeScreen(conn, screenId)) return;
    this.sendTo(conn, {
      type: "LYRICS_AUDIO",
      videoId: this.lyricsState?.currentRound?.videoId ?? null,
      roundIndex: this.lyricsState?.currentRoundIndex ?? 0,
    });
  }

  private handleConfirmLyricsPreview(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!timedRound.confirmPreview(this.lyricsState)) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastLyricsState();
  }

  private handleStartLyricsRound(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!timedRound.startRound(this.lyricsState, Date.now())) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastLyricsState();
  }

  private handleSubmitLyricsAnswer(conn: Party.Connection, playerId: string, text: string) {
    if (!isValidPlayerId(playerId)) return;
    if (typeof text !== "string") return;
    // Only the connection that JOINed/REJOINed as this playerId may answer for them — ids are
    // visible to everyone in broadcast state, so without this any player could answer as another.
    if (this.playerConnId[playerId] !== conn.id) return;
    if (!this.lyricsState) return;

    // Server stamps the time itself — a client-supplied ts was spoofable to answer late for free
    // or inflate computePoints' speed bonus (TODOS.md P2). Correctness computed at SHOW_LYRICS_RESULTS.
    const result = timedRound.acceptAnswer(this.lyricsState, playerId, Date.now(), timedRound.ANSWER_GRACE_MS,
      (ts) => ({ text: sanitizeText(text, 200), ts, correct: false, points: 0 }));
    if (result === "too_late") this.sendTo(conn, { type: "TOO_LATE" });
    if (result === "ok") this.broadcastLyricsState();
  }

  private handleShowLyricsResults(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    const { timerSeconds } = this.lyricsState;
    const scored = timedRound.showResults(this.lyricsState, (round, ans, roundStart) => {
      const correct = isCorrect(ans.text, round.blankSentence, round.acceptableVariants, this.lyricsConfig.fuzzyEnabled);
      const points = correct ? computePoints(roundStart, ans.ts, timerSeconds) : 0;
      return { answer: { ...ans, correct, points }, points };
    });
    if (!scored) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastLyricsState();
  }

  private handleNextLyricsRound(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!timedRound.nextRound(this.lyricsState)) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastLyricsState();
  }

  private handleResetLyricsGame(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    // Any phase: quitting mid-game is a normal host action (the host UI confirms first). Before
    // the lobby guard (timedRoundInPlay) an abandoned game couldn't block anything; now it would.
    if (!this.lyricsState) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.lyricsDeck = [];
    // Clients keep their own lyricsState; tell them it is gone so players leave the winner screen.
    this.abortLyricsStart();
    this.broadcastState();
  }

  // ── Guess Mode ──────────────────────────────────────────────────────────────
  // Same round lifecycle as Lyrics mode via ./timed-round; no AI in the path — the deck is the
  // loaded playlist's own titles/artists. No preview phase either: there's nothing generated to
  // review, so the game goes straight to "playing".

  private sanitizedGuessState(): PublicGuessGameState | null {
    const gs = this.guessState;
    if (!gs) return null;
    const { rounds: _deck, currentRound: round, ...rest } = gs;
    const revealed = gs.phase === "results" || gs.phase === "ended";
    return {
      ...rest,
      currentRound: round
        ? { hasArtist: round.artist !== "", title: revealed ? round.title : null, artist: revealed ? round.artist : null }
        : null,
      answers: timedRound.publicAnswers(gs, (a) => ({ ...a, title: "", artist: "" })),
    };
  }

  private broadcastGuessState() {
    const state = this.sanitizedGuessState();
    if (state) this.broadcast({ type: "GUESS_STATE", state });
  }

  private handleStartGuessGame(conn: Party.Connection, hostId: string, config: GuessGameConfig, songOverrides?: EditableSong[]) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (!this.claimOrValidateHost(conn, hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    // One timed-round game per room; also the double-click guard (see handleStartLyricsGame).
    if (this.guessState !== null || this.lyricsState !== null) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    if (this.playlistLoading) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    const songs = this.pendingPlaylist?.allSongs ?? [];
    if (songs.length === 0) {
      this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
      return;
    }
    this.guessConfig = timedRound.clampConfig(config);
    // Host input: keep only well-formed overrides, string fields only.
    const overrides = new Map((Array.isArray(songOverrides) ? songOverrides : [])
      .filter((s) => s && typeof s === "object" && typeof s.videoId === "string")
      .map((s) => [s.videoId, {
        title: typeof s.title === "string" ? s.title : undefined,
        artist: typeof s.artist === "string" ? s.artist : undefined,
      }]));
    // decode first: allSongs from a saved playlist is already escaped — escape exactly once.
    // slice before decoding bounds decodeEntities' work on hostile host input.
    const clean = (s: string, max: number) => sanitizeText(decodeEntities(s.slice(0, max * 6)), max);
    const deck: GuessRound[] = shuffle(songs.map((s) => {
      const ov = overrides.get(s.videoId);
      const artist = clean(ov?.artist ?? s.artist ?? "", 100);
      return {
        videoId: s.videoId,
        title: clean(ov?.title || s.title, 200),
        // An artist with no letters/digits (e.g. the band "!!!") can never be matched — treat the
        // round as title-only rather than dangle an unreachable artist field and bonus.
        artist: normGuess(artist) ? artist : "",
      };
    }).filter((r) => normGuess(r.title) !== "")).slice(0, this.guessConfig.totalRounds);
    if (deck.length === 0) {
      this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
      return;
    }
    const players: GuessGameState["players"] = {};
    for (const [pid, p] of Object.entries(this.state.players)) {
      players[pid] = { name: p.name, score: 0, connected: p.connected };
    }
    this.guessState = {
      mode: "guess",
      phase: "playing",
      players,
      rounds: deck,
      currentRound: deck[0],
      roundStart: null,
      timerSeconds: this.guessConfig.timerSeconds,
      answers: {},
      totalRounds: deck.length,
      currentRoundIndex: 0,
      consecutiveSkips: 0,
    };
    this.broadcastGuessState();
  }

  // Screen-only: the video id reveals the answer, so players never get it (see sanitizedGuessState).
  private handleGetGuessAudio(conn: Party.Connection, screenId: string) {
    if (!this.authorizeScreen(conn, screenId)) return;
    this.sendTo(conn, {
      type: "GUESS_AUDIO",
      videoId: this.guessState?.currentRound?.videoId ?? null,
      roundIndex: this.guessState?.currentRoundIndex ?? 0,
    });
  }

  private handleStartGuessRound(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.guessState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!timedRound.startRound(this.guessState, Date.now())) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastGuessState();
  }

  private handleSubmitGuess(conn: Party.Connection, playerId: string, title: string, artist: string) {
    if (!isValidPlayerId(playerId)) return;
    if (typeof title !== "string" || typeof artist !== "string") return;
    if (this.playerConnId[playerId] !== conn.id) return; // see handleSubmitLyricsAnswer
    if (!this.guessState) return;
    const result = timedRound.acceptAnswer(this.guessState, playerId, Date.now(), timedRound.ANSWER_GRACE_MS, (ts) => ({
      title: sanitizeText(title, 200), artist: sanitizeText(artist, 200), ts,
      titleCorrect: false, artistCorrect: false, titlePoints: 0, artistPoints: 0, bonusPoints: 0, points: 0,
    }));
    if (result === "too_late") this.sendTo(conn, { type: "TOO_LATE" });
    if (result === "ok") this.broadcastGuessState();
  }

  private handleShowGuessResults(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.guessState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    const { timerSeconds } = this.guessState;
    const scored = timedRound.showResults(this.guessState, (round, ans, roundStart) => {
      const score = scoreGuess(ans, round, roundStart, timerSeconds, this.guessConfig.fuzzyEnabled);
      return { answer: { ...ans, ...score }, points: score.points };
    });
    if (!scored) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastGuessState();
  }

  private handleNextGuessRound(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId) || !this.guessState) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!timedRound.nextRound(this.guessState)) {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.broadcastGuessState();
  }

  private handleResetGuessGame(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }
    if (!this.guessState) { // any phase — see handleResetLyricsGame
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }
    this.guessState = null;
    this.broadcast({ type: "GUESS_ABORTED" });
    this.broadcastState();
  }

  private handleResetGame(conn: Party.Connection, hostId: string) {
    if (!this.authorizeHost(conn, hostId)) {
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

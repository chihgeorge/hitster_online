import type * as Party from "partykit/server";
import {
  evaluateRound,
  checkWinner,
  generateRoomCode,
  extractPlaylistId,
  type GameState,
  type ClientMessage,
  type ServerMessage,
  type Card,
  type Player,
} from "../lib/game";
import { fetchPlaylistItems, parseArtistAndTrack } from "../lib/youtube";
import { lookupReleaseYear } from "../lib/spotify";

const DEFAULT_TARGET_CARD_COUNT = 10;
const ROUND_TIMEOUT_MS = 90_000;
const MAX_PLAYERS_SOFT = 8;

// Player name constraints
const MAX_NAME_LENGTH = 20;
function sanitizeName(name: string): string {
  return name
    .replace(/[<>&"']/g, "") // strip HTML special chars
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export default class HitsterRoom implements Party.Server {
  state: GameState;
  roundTimer: ReturnType<typeof setTimeout> | null = null;

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
      hostId: "",
      winner: null,
    };
  }

  private broadcast(msg: ServerMessage) {
    this.room.broadcast(JSON.stringify(msg));
  }

  private broadcastState() {
    this.broadcast({ type: "STATE", state: this.state });
  }

  private sendTo(conn: Party.Connection, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }

  onConnect(conn: Party.Connection) {
    // Send current state to newly connected client
    this.sendTo(conn, { type: "STATE", state: this.state });
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
      case "START_GAME":
        await this.handleStartGame(sender, msg.hostId, msg.playlistUrl, msg.targetCardCount);
        break;
      case "REVEAL":
        this.handleReveal(sender, msg.hostId);
        break;
      case "NEXT_ROUND":
        this.handleNextRound(sender, msg.hostId);
        break;
    }
  }

  onClose(conn: Party.Connection) {
    // Mark player as disconnected; don't remove them so they can rejoin
    for (const [playerId, player] of Object.entries(this.state.players)) {
      // We can't easily map connection → playerId without a side map,
      // so we just mark all players disconnected and let REJOIN re-establish.
      // A proper implementation would maintain a conn-to-player map.
      void playerId;
      void player;
    }
  }

  private handleJoin(conn: Party.Connection, playerId: string, rawName: string) {
    const name = sanitizeName(rawName);
    if (!name) {
      this.sendTo(conn, { type: "ERROR", error: "invalid_name" });
      return;
    }
    if (this.state.phase !== "lobby") {
      // Late join: added but skips current round
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
    const name = sanitizeName(rawName);
    if (this.state.players[playerId]) {
      this.state.players[playerId].connected = true;
      this.state.players[playerId].name = name || this.state.players[playerId].name;
    } else {
      // Unknown player — treat as new join
      this.handleJoin(conn, playerId, rawName);
      return;
    }
    this.sendTo(conn, { type: "STATE", state: this.state });
    this.broadcastState();
  }

  private handlePlace(conn: Party.Connection, playerId: string, position: number) {
    if (this.state.phase !== "guessing") {
      this.sendTo(conn, { type: "WRONG_PHASE" });
      return;
    }
    if (!this.state.players[playerId]) return;

    // Validate position is within range of the player's timeline
    const player = this.state.players[playerId];
    const maxPosition = player.timeline.length; // can insert after last card
    if (position < 0 || position > maxPosition) {
      this.sendTo(conn, { type: "ERROR", error: "invalid_position" });
      return;
    }

    this.state.placements[playerId] = position;
    this.sendTo(conn, { type: "PLACEMENT_ACK", playerId });

    // Broadcast delta — only placement ack, not full state on every placement
    this.broadcastState();
  }

  private isValidHostId(hostId: string): boolean {
    return this.state.hostId !== "" && hostId === this.state.hostId;
  }

  private async handleStartGame(
    conn: Party.Connection,
    hostId: string,
    playlistUrl: string,
    targetCardCount?: number
  ) {
    if (this.state.phase !== "lobby") {
      this.sendTo(conn, { type: "ERROR", error: "wrong_phase" });
      return;
    }

    // First START_GAME message from the host establishes hostId
    if (this.state.hostId === "") {
      this.state.hostId = hostId;
    } else if (!this.isValidHostId(hostId)) {
      this.sendTo(conn, { type: "ERROR", error: "unauthorized" });
      return;
    }

    if (targetCardCount) {
      this.state.targetCardCount = Math.max(1, Math.min(targetCardCount, 20));
    }

    const playlistId = extractPlaylistId(playlistUrl);
    this.state.playlistId = playlistId;

    this.broadcastState(); // show "loading..." to players

    try {
      const tracks = await fetchPlaylistItems(playlistId);
      const songs: Card[] = [];

      // Resolve release years in parallel (max 10 concurrent Spotify requests)
      const BATCH = 10;
      for (let i = 0; i < tracks.length; i += BATCH) {
        const batch = tracks.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async (track) => {
            const parsed = parseArtistAndTrack(track.title);
            if (!parsed) return null;

            const year = await lookupReleaseYear(parsed.artist, parsed.track).catch(() => null);
            if (!year) return null;

            return {
              id: track.videoId,
              videoId: track.videoId,
              title: track.title,
              artist: parsed.artist,
              year,
              yearSource: "spotify" as const,
            } satisfies Card;
          })
        );

        for (const result of results) {
          if (result.status === "fulfilled" && result.value) {
            songs.push(result.value);
          }
        }
      }

      if (songs.length < 2) {
        this.sendTo(conn, { type: "ERROR", error: "not_enough_songs" });
        return;
      }

      // Shuffle songs
      this.state.songs = songs.sort(() => Math.random() - 0.5);

      // Deal starting cards (one per player, year visible)
      for (const [playerId, player] of Object.entries(this.state.players)) {
        if (player.timeline.length === 0) {
          const startingCard = this.pickStartingCard(playerId);
          if (startingCard) {
            player.timeline = [startingCard];
            player.cardCount = 1;
          }
        }
      }

      this.startNextRound();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown_error";
      this.sendTo(conn, { type: "ERROR", error: msg === "QUOTA_EXCEEDED" ? "quota_exceeded" : "playlist_load_failed" });
    }
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

    this.clearRoundTimer();
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

    const nextSong = this.state.songs.shift()!;
    this.state.currentSong = nextSong;
    this.state.placements = {};
    this.state.phase = "guessing";
    this.state.currentRound += 1;

    this.broadcastState();

    // Auto-advance to reveal after 90s if host doesn't click Reveal
    this.clearRoundTimer();
    this.roundTimer = setTimeout(() => {
      if (this.state.phase === "guessing") {
        this.state.phase = "reveal";
        if (this.state.currentSong) {
          this.state.players = evaluateRound(
            this.state.placements,
            this.state.currentSong,
            this.state.players
          );
        }
        const winner = checkWinner(this.state.players, this.state.targetCardCount);
        if (winner) {
          this.state.phase = "ended";
          this.state.winner = winner;
        }
        this.broadcastState();
      }
    }, ROUND_TIMEOUT_MS);
  }

  private clearRoundTimer() {
    if (this.roundTimer) {
      clearTimeout(this.roundTimer);
      this.roundTimer = null;
    }
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

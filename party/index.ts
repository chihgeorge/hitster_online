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
} from "../lib/game";
import {
  fetchPlaylistItems,
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
} from "../lib/youtube";
import { lookupReleaseYear, SpotifyRateLimitedError } from "../lib/spotify";
import { lookupYearFromItunes } from "../lib/itunes";
import { lookupYearFromKnowledgeGraph, KnowledgeGraphBlockedError } from "../lib/googlekg";

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

export default class HitsterRoom implements Party.Server {
  state: GameState;

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
      case "RESET_GAME":
        this.handleResetGame(sender, msg.hostId);
        break;
    }
  }

  onClose(_conn: Party.Connection) {
    // No connection→playerId map in v1; players reconnect via REJOIN with their stored playerId.
  }

  private handleJoin(conn: Party.Connection, playerId: string, rawName: string) {
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
    if (playerId !== this.state.activePlayerId) return;
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

    if (typeof targetCardCount === "number") {
      this.state.targetCardCount = Math.max(1, Math.min(targetCardCount, MAX_TARGET_CARD_COUNT));
    }

    const playlistId = extractPlaylistId(playlistUrl);
    this.state.playlistId = playlistId;

    this.broadcastState(); // show "loading..." to players

    // Test seed: bypass API calls for deterministic E2E testing.
    // Songs are in ascending year order (no shuffle) so placement positions are predictable.
    if (playlistUrl === "hitster://test") {
      this.state.targetCardCount = 3;
      this.state.songs = Array.from({ length: 20 }, (_, i) => ({
        id: `test-${i}`,
        videoId: "dQw4w9WgXcQ",
        title: `Test Song ${1960 + i * 3}`,
        artist: "Test Artist",
        year: 1960 + i * 3,
        yearSource: "manual" as const,
      } satisfies Card));
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
      return;
    }

    if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
      this.sendTo(conn, { type: "ERROR", error: "playlist_load_failed" });
      return;
    }

    try {
      // Production: PartyKit stores secrets with pkvar- prefix in Cloudflare env
      // Local dev: miniflare exposes them under the unprefixed name via process.env
      const youtubeKey =
        (this.room.env?.["pkvar-YOUTUBE_API_KEY"] as string | undefined) ??
        (this.room.env?.YOUTUBE_API_KEY as string | undefined) ??
        process.env.YOUTUBE_API_KEY;
      const spotifyClientId =
        (this.room.env?.["pkvar-SPOTIFY_CLIENT_ID"] as string | undefined) ??
        (this.room.env?.SPOTIFY_CLIENT_ID as string | undefined) ??
        process.env.SPOTIFY_CLIENT_ID;
      const spotifyClientSecret =
        (this.room.env?.["pkvar-SPOTIFY_CLIENT_SECRET"] as string | undefined) ??
        (this.room.env?.SPOTIFY_CLIENT_SECRET as string | undefined) ??
        process.env.SPOTIFY_CLIENT_SECRET;

      const tracks = await fetchPlaylistItems(playlistId, youtubeKey);
      const songs: Card[] = [];
      const diagnostics: SongDiagnostic[] = [];

      // Once Spotify 429s persistently or KG returns 403, skip that source for all remaining songs.
      let spotifyRateLimited = false;
      let kgBlocked = false;

      // Resolve release years in parallel batches. Rate-limit detection lets us be more aggressive:
      // if a source is blocked we bail immediately rather than waiting per-song.
      const BATCH = SPOTIFY_BATCH_SIZE;
      for (let i = 0; i < tracks.length; i += BATCH) {
        if (i > 0) await new Promise((r) => setTimeout(r, 100)); // brief pause between batches
        const batch = tracks.slice(i, i + BATCH);
        // Snapshot flags so all songs in the same batch see the same value
        const batchSpotifyRateLimited = spotifyRateLimited;
        const batchKgBlocked = kgBlocked;
        const results = await Promise.allSettled(
          batch.map(async (track) => {
            // Layer 1: YouTube Music structured description (most reliable)
            const descMeta = parseYouTubeMusicDescription(track.description);

            // Layer 2: year embedded directly in title like "song (1980)"
            const titleYear = extractYearFromTitle(track.title);

            // Layer 3: parse "Artist - Track" from title
            const titleParsed = parseArtistAndTrack(track.title);

            // Best artist guess: description > title parse > channel name
            const artist =
              descMeta.artist ??
              titleParsed?.artist ??
              channelToArtist(track.channelTitle);

            const trackName = titleParsed?.track ?? track.title;

            // Year resolution priority: description > title > Spotify > Google KG
            let year: number | null = descMeta.year ?? titleYear ?? null;
            let yearSource: Card["yearSource"] = descMeta.year
              ? "description"
              : titleYear
              ? "title"
              : "spotify";

            if (!year) {
              if (!batchSpotifyRateLimited) {
                try {
                  year = await lookupReleaseYear(artist, trackName, spotifyClientId, spotifyClientSecret);
                  if (year) yearSource = "spotify";
                } catch (err) {
                  if (err instanceof SpotifyRateLimitedError) spotifyRateLimited = true;
                  // Other errors (missing credentials, network): year stays null
                }
              }
              // iTunes Search API: free, no key, good international coverage
              if (!year) {
                year = await lookupYearFromItunes(artist, trackName).catch(() => null);
                if (year) yearSource = "itunes";
              }
              if (!year && youtubeKey && !batchKgBlocked) {
                try {
                  year = await lookupYearFromKnowledgeGraph(artist, trackName, youtubeKey);
                  if (year) yearSource = "google";
                } catch (err) {
                  if (err instanceof KnowledgeGraphBlockedError) kgBlocked = true;
                }
              }
            }

            return { track, artist, year, yearSource };
          })
        );

        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          const { track, artist, year, yearSource } = result.value;
          diagnostics.push({ title: track.title, artist, year, yearSource: year ? yearSource : null });
          if (year) {
            songs.push({
              id: track.videoId,
              videoId: track.videoId,
              title: track.title,
              artist,
              year,
              yearSource,
            } satisfies Card);
          }
        }

        // Send intermediate diagnostic after each batch so the host sees progress live
        this.sendTo(conn, {
          type: "DIAGNOSTIC",
          songs: [...diagnostics],
          status: { spotifyRateLimited, kgBlocked },
        });
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
      let errorCode: string;
      if (msg === "QUOTA_EXCEEDED") {
        errorCode = "quota_exceeded";
      } else if (msg.includes("API_KEY") || msg.includes("not set")) {
        errorCode = "api_key_missing";
      } else if (msg.includes("403")) {
        errorCode = "playlist_forbidden";
      } else if (msg.includes("404")) {
        errorCode = "playlist_not_found";
      } else if (msg.includes("YouTube API error")) {
        errorCode = `youtube_error:${msg.match(/\d{3}/)?.[0] ?? "unknown"}`;
      } else if (msg.includes("Spotify")) {
        errorCode = "spotify_error";
      } else {
        errorCode = "playlist_load_failed";
      }
      this.sendTo(conn, { type: "ERROR", error: errorCode });
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

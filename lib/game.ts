// Shared game state types used by both the PartyKit server and Next.js client.

export type GamePhase = "lobby" | "guessing" | "reveal" | "ended";

export interface Card {
  id: string;
  videoId: string;
  title: string;
  artist: string;
  year: number;
  yearSource: "spotify" | "description" | "title" | "manual";
}

export interface Player {
  name: string;
  cardCount: number;
  timeline: Card[]; // chronologically ordered cards the player has kept
  connected: boolean;
}

export interface GameState {
  phase: GamePhase;
  players: Record<string, Player>; // keyed by playerId
  targetCardCount: number; // first to reach this wins (default 10)
  currentRound: number;
  playlistId: string;
  songs: Card[];
  currentSong: Card | null;
  // playerId → 0-based insertion position on that player's own timeline.
  // 0 = before first card, 1 = between card[0] and card[1], etc.
  placements: Record<string, number>;
  hostId: string;
  winner: string | null; // playerId of winner once phase === 'ended'
}

// --- Message types sent over the WebSocket ---

export type ClientMessage =
  | { type: "JOIN"; name: string; playerId: string }
  | { type: "REJOIN"; playerId: string; name: string }
  | { type: "PLACE"; playerId: string; position: number }
  | { type: "START_GAME"; hostId: string; playlistUrl: string; targetCardCount?: number }
  | { type: "REVEAL"; hostId: string }
  | { type: "NEXT_ROUND"; hostId: string };

export type ServerMessage =
  | { type: "STATE"; state: GameState }
  | { type: "PLACEMENT_ACK"; playerId: string }
  | { type: "ERROR"; error: string }
  | { type: "TOO_LATE" }
  | { type: "WRONG_PHASE" };

// --- Placement evaluation (core game logic) ---

/**
 * Returns true if inserting a card with `revealedYear` at `position` in the
 * player's current `timeline` is a correct HITSTER placement.
 *
 * position 0 = before all cards (year must be <= first card's year)
 * position N = after all N cards (year must be >= last card's year)
 * position k = between card[k-1] and card[k]
 *
 * Same-year rule: a card placed immediately adjacent to a card with the same
 * year is also correct (use <= / >= at boundaries).
 */
export function isCorrectPlacement(
  position: number,
  revealedYear: number,
  timeline: Card[]
): boolean {
  if (timeline.length === 0) return true; // first card is always correct

  const before = timeline[position - 1]?.year ?? -Infinity;
  const after = timeline[position]?.year ?? Infinity;

  return revealedYear >= before && revealedYear <= after;
}

/**
 * Evaluates all placements for a completed round and returns updated players.
 * Players who placed correctly keep the card on their timeline.
 * Players who didn't place (timed out) are unchanged.
 */
export function evaluateRound(
  placements: Record<string, number>,
  revealedSong: Card,
  players: Record<string, Player>
): Record<string, Player> {
  const updated: Record<string, Player> = {};

  for (const [playerId, player] of Object.entries(players)) {
    const position = placements[playerId];

    if (position === undefined) {
      // Did not place — no change
      updated[playerId] = player;
      continue;
    }

    const correct = isCorrectPlacement(position, revealedSong.year, player.timeline);

    if (correct) {
      const newTimeline = [...player.timeline];
      newTimeline.splice(position, 0, revealedSong);
      updated[playerId] = {
        ...player,
        cardCount: player.cardCount + 1,
        timeline: newTimeline,
      };
    } else {
      updated[playerId] = player; // card discarded, no change
    }
  }

  return updated;
}

/**
 * Returns the playerId of the first player who has reached targetCardCount,
 * or null if no one has won yet.
 */
export function checkWinner(
  players: Record<string, Player>,
  targetCardCount: number
): string | null {
  for (const [playerId, player] of Object.entries(players)) {
    if (player.cardCount >= targetCardCount) return playerId;
  }
  return null;
}

/** Generates a random 4-character room code (A-Z, no O/0/I/1). */
export function generateRoomCode(): string {
  const chars = "BCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 4 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

/** Extracts a YouTube playlist ID from a full URL or returns the string as-is. */
export function extractPlaylistId(input: string): string {
  try {
    const url = new URL(input);
    return url.searchParams.get("list") ?? input;
  } catch {
    return input;
  }
}

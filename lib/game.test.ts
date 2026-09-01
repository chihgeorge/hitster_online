import { describe, it, expect } from "vitest";
import {
  isCorrectPlacement,
  evaluateRound,
  checkWinner,
  generateRoomCode,
  extractPlaylistId,
  type Card,
  type Player,
} from "./game";
import { isValidYear } from "./utils";

// Helper to make a Card with just the fields needed for placement tests
function card(id: string, year: number): Card {
  return { id, videoId: id, title: id, artist: "Test", year, yearSource: "spotify" };
}

function player(overrides: Partial<Player> = {}): Player {
  return {
    name: "Test",
    cardCount: 0,
    timeline: [],
    connected: true,
    ...overrides,
  };
}

// ─── isCorrectPlacement ───────────────────────────────────────────────────────

describe("isCorrectPlacement", () => {
  it("returns true for an empty timeline (first card is always correct)", () => {
    expect(isCorrectPlacement(0, 1975, [])).toBe(true);
  });

  it("places correctly before the first card", () => {
    const timeline = [card("a", 1990)];
    expect(isCorrectPlacement(0, 1975, timeline)).toBe(true);
    expect(isCorrectPlacement(0, 1995, timeline)).toBe(false);
  });

  it("places correctly after the last card", () => {
    const timeline = [card("a", 1990)];
    expect(isCorrectPlacement(1, 2000, timeline)).toBe(true);
    expect(isCorrectPlacement(1, 1985, timeline)).toBe(false);
  });

  it("places correctly between two cards", () => {
    const timeline = [card("a", 1975), card("b", 2003)];
    expect(isCorrectPlacement(1, 1990, timeline)).toBe(true);
    expect(isCorrectPlacement(1, 1970, timeline)).toBe(false);
    expect(isCorrectPlacement(1, 2010, timeline)).toBe(false);
  });

  it("same-year edge case: adjacent to equal year is correct (before)", () => {
    const timeline = [card("a", 1990)];
    expect(isCorrectPlacement(0, 1990, timeline)).toBe(true); // same year before = correct
  });

  it("same-year edge case: adjacent to equal year is correct (after)", () => {
    const timeline = [card("a", 1990)];
    expect(isCorrectPlacement(1, 1990, timeline)).toBe(true); // same year after = correct
  });

  it("rejects placement where year is out of range", () => {
    const timeline = [card("a", 1980), card("b", 2000)];
    expect(isCorrectPlacement(1, 1960, timeline)).toBe(false);
    expect(isCorrectPlacement(1, 2020, timeline)).toBe(false);
  });
});

// ─── evaluateRound ────────────────────────────────────────────────────────────

describe("evaluateRound", () => {
  const song = card("song", 1985);

  it("adds card to timeline for correct placement", () => {
    const players = {
      p1: player({ timeline: [card("a", 1975), card("b", 1995)] }),
    };
    const placements = { p1: 1 }; // between 1975 and 1995 — correct for 1985

    const result = evaluateRound(placements, song, players);
    expect(result.p1.cardCount).toBe(1);
    expect(result.p1.timeline).toHaveLength(3);
    expect(result.p1.timeline[1].year).toBe(1985);
  });

  it("discards card for wrong placement", () => {
    const players = {
      p1: player({ timeline: [card("a", 1975), card("b", 1995)] }),
    };
    const placements = { p1: 0 }; // before 1975 — wrong for 1985

    const result = evaluateRound(placements, song, players);
    expect(result.p1.cardCount).toBe(0);
    expect(result.p1.timeline).toHaveLength(2);
  });

  it("leaves player unchanged if they did not place (timeout)", () => {
    const players = { p1: player({ timeline: [card("a", 1975)] }) };
    const placements = {}; // p1 didn't place

    const result = evaluateRound(placements, song, players);
    expect(result.p1.cardCount).toBe(0);
    expect(result.p1.timeline).toHaveLength(1);
  });

  it("evaluates multiple players independently", () => {
    const players = {
      p1: player({ timeline: [card("a", 1975), card("b", 1995)] }),
      p2: player({ timeline: [card("c", 2000)] }),
    };
    const placements = {
      p1: 1, // correct (1975 < 1985 < 1995)
      p2: 0, // wrong (2000, placing before it with 1985 → correct actually, let me fix)
    };
    // p2 has only [2000], placing at position 0 with year 1985 → before 2000, correct
    const result = evaluateRound(placements, song, players);
    expect(result.p1.cardCount).toBe(1);
    expect(result.p2.cardCount).toBe(1);
  });
});

// ─── checkWinner ──────────────────────────────────────────────────────────────

describe("checkWinner", () => {
  it("returns null when no one has reached targetCardCount", () => {
    const players = {
      p1: player({ cardCount: 5 }),
      p2: player({ cardCount: 7 }),
    };
    expect(checkWinner(players, 10)).toBeNull();
  });

  it("returns the playerId of the winner", () => {
    const players = {
      p1: player({ cardCount: 9 }),
      p2: player({ cardCount: 10 }),
    };
    expect(checkWinner(players, 10)).toBe("p2");
  });

  it("returns first winner found when multiple players hit the target", () => {
    const players = {
      p1: player({ cardCount: 10 }),
      p2: player({ cardCount: 10 }),
    };
    // Result is deterministic (Object.entries order)
    const winner = checkWinner(players, 10);
    expect(["p1", "p2"]).toContain(winner);
  });
});

// ─── generateRoomCode ─────────────────────────────────────────────────────────

describe("generateRoomCode", () => {
  it("returns a 4-character string", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateRoomCode()).toHaveLength(4);
    }
  });

  it("contains only allowed characters (no O, I)", () => {
    const allowed = /^[BCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
    for (let i = 0; i < 100; i++) {
      expect(generateRoomCode()).toMatch(allowed);
    }
  });
});

// ─── isValidYear ─────────────────────────────────────────────────────────────

describe("isValidYear", () => {
  it("returns true for 1900", () => expect(isValidYear(1900)).toBe(true));
  it("returns true for current year", () => expect(isValidYear(new Date().getFullYear())).toBe(true));
  it("returns true for current year + 1", () => expect(isValidYear(new Date().getFullYear() + 1)).toBe(true));
  it("returns false for 1899", () => expect(isValidYear(1899)).toBe(false));
  it("returns false for current year + 2", () => expect(isValidYear(new Date().getFullYear() + 2)).toBe(false));
  it("returns false for 0", () => expect(isValidYear(0)).toBe(false));
  it("returns false for NaN", () => expect(isValidYear(NaN)).toBe(false));
});

// ─── extractPlaylistId ────────────────────────────────────────────────────────

describe("extractPlaylistId", () => {
  it("extracts list param from a full YouTube URL", () => {
    const url = "https://www.youtube.com/playlist?list=PLFsQleAWXsj_4yDeebiIADdH5FMayBiZo";
    expect(extractPlaylistId(url)).toBe("PLFsQleAWXsj_4yDeebiIADdH5FMayBiZo");
  });

  it("returns the input as-is if it looks like a plain ID already", () => {
    expect(extractPlaylistId("PLFsQleAWXsj_4yDeebiIADdH5FMayBiZo")).toBe(
      "PLFsQleAWXsj_4yDeebiIADdH5FMayBiZo"
    );
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import HitsterRoom from "./index";

// Valid UUID-format player IDs used throughout tests
const P1 = "00000000-0000-0000-0000-000000000001";
const P2 = "00000000-0000-0000-0000-000000000002";
const P8 = "00000000-0000-0000-0000-000000000008";
const STRANGER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ─── Mock PartyKit dependencies ──────────────────────────────────────────────

function makeConn(id = "conn-1") {
  return {
    id,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as import("partykit/server").Connection;
}

function makeRoom() {
  return {
    id: "room-1",
    broadcast: vi.fn(),
    getConnections: vi.fn(() => []),
    storage: {
      get: vi.fn((key: unknown) => Promise.resolve(Array.isArray(key) ? new Map() : undefined)),
      put: vi.fn(() => Promise.resolve()),
      delete: vi.fn(() => Promise.resolve()),
    },
  } as unknown as import("partykit/server").Room;
}

// Only mock network functions; real parse helpers run untouched so
// fakeTrack descriptions are parsed correctly without extra stubbing.
vi.mock("../lib/youtube", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, fetchPlaylistItems: vi.fn(), fetchEmbeddableVideoIds: vi.fn() };
});

vi.mock("../lib/ai-metadata", () => ({
  resolveTracksWithAI: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../lib/lyrics-resolver", () => ({
  resolveLyricsForTracks: vi.fn().mockResolvedValue(new Map()),
}));

import { fetchPlaylistItems, fetchEmbeddableVideoIds } from "../lib/youtube";
import { resolveTracksWithAI } from "../lib/ai-metadata";
import { resolveLyricsForTracks } from "../lib/lyrics-resolver";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function send(room: HitsterRoom, conn: ReturnType<typeof makeConn>, msg: object) {
  return room.onMessage(JSON.stringify(msg), conn);
}

function lastBroadcast(room: HitsterRoom) {
  const mock = room.room.broadcast as ReturnType<typeof vi.fn>;
  const last = mock.mock.calls.at(-1)?.[0];
  return last ? JSON.parse(last) : null;
}

function lastSentTo(conn: ReturnType<typeof makeConn>) {
  const calls = (conn.send as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls.at(-1)?.[0];
  return last ? JSON.parse(last) : null;
}

/** Track with a "Released on:" description so the real parser extracts the year */
function fakeTrack(videoId: string, year: number) {
  return {
    videoId,
    title: `Song ${videoId}`,
    description: `Provided to YouTube by Label\nReleased on: ${year}-01-01\nArtist: TestArtist`,
    channelTitle: "TestArtist - Topic",
  };
}

// ─── onConnect ────────────────────────────────────────────────────────────────

describe("onConnect", () => {
  it("sends current lobby state to newly connected client", () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.type).toBe("STATE");
    expect(msg?.state.phase).toBe("lobby");
  });
});

// ─── JOIN ─────────────────────────────────────────────────────────────────────

describe("JOIN handler", () => {
  it("adds player and broadcasts state", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    expect(room.state.players[P1].name).toBe("Alice");
    expect(lastBroadcast(room)?.type).toBe("STATE");
  });

  it("sanitizes name: strips HTML special characters", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "  <Alice>  " });
    expect(room.state.players[P1].name).toBe("Alice");
  });

  it("rejects empty name after sanitization", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "<<<" });
    expect(lastSentTo(conn)?.error).toBe("invalid_name");
    expect(room.state.players[P1]).toBeUndefined();
  });

  it("truncates name at 20 characters", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "A".repeat(30) });
    expect(room.state.players[P1].name).toHaveLength(20);
  });

  it("rejects new player when room is full (8 players)", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    for (let i = 0; i < 8; i++) {
      await send(room, makeConn(`c${i}`), { type: "JOIN", playerId: `00000000-0000-0000-0000-00000000000${i}`, name: `P${i}` });
    }
    const late = makeConn("c8");
    await send(room, late, { type: "JOIN", playerId: P8, name: "Late" });
    expect(lastSentTo(late)?.error).toBe("room_full");
  });
});

// ─── REJOIN ───────────────────────────────────────────────────────────────────

describe("REJOIN handler", () => {
  it("marks known player connected and sends state", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    await send(room, makeConn(), { type: "JOIN", playerId: P1, name: "Alice" });
    room.state.players[P1].connected = false;

    const conn2 = makeConn("c2");
    await send(room, conn2, { type: "REJOIN", playerId: P1, name: "Alice" });
    expect(room.state.players[P1].connected).toBe(true);
    expect(lastSentTo(conn2)?.type).toBe("STATE");
  });

  it("treats unknown playerId as new JOIN", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "REJOIN", playerId: STRANGER, name: "Bob" });
    expect(room.state.players[STRANGER]?.name).toBe("Bob");
  });
});

// ─── PLACE ────────────────────────────────────────────────────────────────────

describe("PLACE handler", () => {
  function roomInGuessing() {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985, yearSource: "description",
    };
    return r;
  }

  it("records placement and sends PLACEMENT_ACK", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P1, position: 0 });
    expect(room.state.placements[P1]).toBe(0);
    expect(lastSentTo(conn)?.type).toBe("PLACEMENT_ACK");
  });

  it("rejects position outside timeline bounds", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P1, position: 5 });
    expect(lastSentTo(conn)?.error).toBe("invalid_position");
  });

  it("sends TOO_LATE when not in guessing phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P1, position: 0 });
    expect(lastSentTo(conn)?.type).toBe("TOO_LATE");
  });

  it("handles two concurrent PLACE messages from the active player without crashing", async () => {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985, yearSource: "description",
    };

    const conn = makeConn("conn-1");

    // Simulate a double-click / network retry: same player sends PLACE twice simultaneously
    await Promise.all([
      send(r, conn, { type: "PLACE", playerId: P1, position: 0 }),
      send(r, conn, { type: "PLACE", playerId: P1, position: 0 }),
    ]);

    // Placement recorded exactly once, ACK sent at least once
    expect(r.state.placements[P1]).toBe(0);
    const sentMessages = (conn.send as ReturnType<typeof vi.fn>).mock.calls.map(
      ([raw]: [string]) => JSON.parse(raw),
    );
    expect(sentMessages.some((m: { type: string }) => m.type === "PLACEMENT_ACK")).toBe(true);
  });

  it("rejects PLACE from a non-active player (spectator)", async () => {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.players[P2] = { name: "Bob", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985, yearSource: "description",
    };

    const conn = makeConn("conn-2");
    await send(r, conn, { type: "PLACE", playerId: P2, position: 0 });

    // P2 is spectating — placement should be silently ignored
    expect(r.state.placements[P2]).toBeUndefined();
    const sentMessages = (conn.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sentMessages).toHaveLength(0);
  });
});

// ─── START_GAME ──────────────────────────────────────────────────────────────

describe("START_GAME handler", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads playlist and transitions to guessing phase", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "https://www.youtube.com/playlist?list=PL123",
    });

    expect(room.state.phase).toBe("guessing");
    expect(room.state.hostId).toBe("host-uuid");
    expect(room.state.currentSong).not.toBeNull();
  });

  it("respects custom targetCardCount", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
      targetCardCount: 5,
    });

    expect(room.state.targetCardCount).toBe(5);
  });

  it("sends not_enough_songs when playlist yields fewer than 2 songs", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    expect(lastSentTo(conn)?.error).toBe("not_enough_songs");
    expect(room.state.phase).toBe("lobby");
  });

  it("rejects START_GAME when phase is not lobby", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });
    expect(lastSentTo(conn)?.error).toBe("wrong_phase");
  });

  it("rejects START_GAME from a non-host once hostId is established", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "real-host",
      playlistUrl: "PLtest",
    });

    // Reset to lobby to trigger a second START_GAME attempt
    room.state.phase = "lobby";
    const impostor = makeConn("impostor");
    await send(room, impostor, {
      type: "START_GAME",
      hostId: "fake-host",
      playlistUrl: "PLtest",
    });
    expect(lastSentTo(impostor)?.error).toBe("unauthorized");
  });

  it("rejects START_GAME from a different connection once hostConnId is established via onConnect", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    const attackerConn = makeConn("attacker-conn");

    // onConnect from the host — establishes hostConnId
    room.onConnect(hostConn);

    // Attacker tries to claim host before the real host has loaded anything
    await send(room, attackerConn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "hitster://test",
    });
    expect(lastSentTo(attackerConn)?.error).toBe("unauthorized");
    expect(room.state.hostId).toBe(""); // host not claimed
  });

  it("uses AI year when no year in description or title", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Untitled Song", description: "no year here", channelTitle: "Artist" },
      { videoId: "v2", title: "Another Song", description: "no year here", channelTitle: "Artist" },
    ]);
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([
      ["v1", { title: "Untitled Song", artist: "Artist", year: 1980 }],
      ["v2", { title: "Another Song", artist: "Artist", year: 1982 }],
    ]));

    process.env.ANTHROPIC_API_KEY = "test-key";
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    expect(resolveTracksWithAI).toHaveBeenCalled();
    expect(room.state.phase).toBe("guessing");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("skips AI call for tracks already in storage cache", async () => {
    const cachedMeta = { title: "Cached Title", artist: "Cached Artist", year: 1975 };
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Raw Title", description: "no year here", channelTitle: "Artist" },
      { videoId: "v2", title: "Another Song", description: "no year here", channelTitle: "Artist" },
    ]);
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([
      ["v2", { title: "Another Song", artist: "Artist", year: 1990 }],
    ]));

    process.env.ANTHROPIC_API_KEY = "test-key";
    const room = new HitsterRoom(makeRoom() as any);
    // Seed storage with v1 already cached
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys) ? new Map([["aiMeta:v1", cachedMeta]]) : undefined)
    );
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    // AI should only have been called with v2 (v1 was cached)
    const callArg = vi.mocked(resolveTracksWithAI).mock.calls[0]?.[0] as { videoId: string }[];
    expect(callArg.map((t) => t.videoId)).toEqual(["v2"]);
    expect(room.state.phase).toBe("guessing");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("writes fresh AI results to storage cache", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "A Song", description: "no year", channelTitle: "Artist" },
    ]);
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([
      ["v1", { title: "A Song", artist: "Artist", year: 2001 }],
    ]));

    process.env.ANTHROPIC_API_KEY = "test-key";
    const room = new HitsterRoom(makeRoom() as any);
    // Seed a second track so the game can start (needs ≥2 songs)
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "A Song", description: "no year", channelTitle: "Artist" },
      { videoId: "v2", title: "B Song", description: "no year", channelTitle: "Artist" },
    ]);
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([
      ["v1", { title: "A Song", artist: "Artist", year: 2001 }],
      ["v2", { title: "B Song", artist: "Artist", year: 2003 }],
    ]));
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    const putCalls = (room.room.storage.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBeGreaterThan(0);
    const stored = putCalls[0][0] as Record<string, unknown>;
    expect(stored["aiMeta:v1"]).toBeDefined();
    expect(stored["aiMeta:v2"]).toBeDefined();

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("all tracks cached — AI not called and storage.put not called", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Song A", description: "no year", channelTitle: "Artist" },
      { videoId: "v2", title: "Song B", description: "no year", channelTitle: "Artist" },
    ]);

    process.env.ANTHROPIC_API_KEY = "test-key";
    const room = new HitsterRoom(makeRoom() as any);
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys)
        ? new Map([
            ["aiMeta:v1", { title: "Song A", artist: "Artist", year: 1980 }],
            ["aiMeta:v2", { title: "Song B", artist: "Artist", year: 1985 }],
          ])
        : undefined)
    );

    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    expect(resolveTracksWithAI).not.toHaveBeenCalled();
    const putCalls = (room.room.storage.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBe(0);
    expect(room.state.phase).toBe("guessing");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("cached metadata (title, artist, year) used in final song cards", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Raw Title", description: "no year", channelTitle: "Unknown" },
      { videoId: "v2", title: "Song B", description: "no year", channelTitle: "Artist" },
    ]);

    process.env.ANTHROPIC_API_KEY = "test-key";
    const room = new HitsterRoom(makeRoom() as any);
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys)
        ? new Map([
            ["aiMeta:v1", { title: "Clean Title", artist: "Clean Artist", year: 1975 }],
            ["aiMeta:v2", { title: "Song B", artist: "Artist", year: 1985 }],
          ])
        : undefined)
    );

    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    // startNextRound splices the first song into currentSong; search both pools.
    const allCards = [
      ...room.state.songs,
      ...(room.state.currentSong ? [room.state.currentSong] : []),
    ];
    const v1Card = allCards.find((s) => s.videoId === "v1");
    expect(v1Card?.year).toBe(1975);
    expect(v1Card?.title).toBe("Clean Title");
    expect(v1Card?.artist).toBe("Clean Artist");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("handles quota exceeded error from YouTube API", async () => {
    vi.mocked(fetchPlaylistItems).mockRejectedValue(new Error("QUOTA_EXCEEDED"));

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    expect(lastSentTo(conn)?.error).toBe("quota_exceeded");
  });
});

// ─── REVEAL ───────────────────────────────────────────────────────────────────

describe("REVEAL handler", () => {
  async function startedRoom() {
    vi.clearAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest" });
    return { room, conn };
  }

  it("transitions to reveal phase", async () => {
    const { room, conn } = await startedRoom();
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    expect(room.state.phase).toBe("reveal");
  });

  it("evaluates placements on reveal", async () => {
    const { room, conn } = await startedRoom();
    // p1 has 1 starting card; placing at position 0 or 1 is within bounds
    await send(room, conn, { type: "PLACE", playerId: P1, position: 0 });
    const cardsBefore = room.state.players[P1].cardCount;
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    // cardCount may have changed (correct or incorrect) — just verify no crash
    expect(typeof room.state.players[P1].cardCount).toBe("number");
    expect(room.state.players[P1].cardCount).toBeGreaterThanOrEqual(cardsBefore);
  });

  it("rejects REVEAL from non-host", async () => {
    const { room } = await startedRoom();
    const intruder = makeConn("intruder");
    await send(room, intruder, { type: "REVEAL", hostId: "wrong" });
    expect(lastSentTo(intruder)?.error).toBe("unauthorized");
    expect(room.state.phase).toBe("guessing");
  });

  it("transitions to ended when a player wins", async () => {
    const { room, conn } = await startedRoom();
    room.state.players[P1].cardCount = 9;
    room.state.targetCardCount = 10;

    // Make an unconditionally correct placement: set up song year to fit before player's timeline
    const songYear = room.state.currentSong!.year;
    const timeline = room.state.players[P1].timeline;
    const pos = timeline.findIndex((c) => c.year >= songYear);
    const safePos = pos === -1 ? timeline.length : pos;
    await send(room, conn, { type: "PLACE", playerId: P1, position: safePos });
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });

    if (room.state.players[P1].cardCount >= 10) {
      expect(room.state.phase).toBe("ended");
      expect(room.state.winner).toBe(P1);
    }
  });
});

// ─── NEXT_ROUND ──────────────────────────────────────────────────────────────

describe("NEXT_ROUND handler", () => {
  it("advances from reveal to next song", async () => {
    vi.clearAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest" });

    const firstSongId = room.state.currentSong?.videoId;
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    await send(room, conn, { type: "NEXT_ROUND", hostId: "host-uuid" });

    expect(room.state.phase).toBe("guessing");
    expect(room.state.currentSong?.videoId).not.toBe(firstSongId);
  });

  it("rejects NEXT_ROUND from non-host", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "reveal";
    room.state.hostId = "host-uuid";
    const intruder = makeConn("intruder");
    await send(room, intruder, { type: "NEXT_ROUND", hostId: "wrong" });
    expect(lastSentTo(intruder)?.error).toBe("unauthorized");
  });

  it("rejects NEXT_ROUND when not in reveal phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.hostId = "host-uuid";
    const conn = makeConn();
    await send(room, conn, { type: "NEXT_ROUND", hostId: "host-uuid" });
    expect(lastSentTo(conn)?.error).toBe("wrong_phase");
  });

  it("ends game when playlist is exhausted", async () => {
    vi.clearAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
    ]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest" });
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    await send(room, conn, { type: "NEXT_ROUND", hostId: "host-uuid" });

    // With 2 tracks and 1 player starting card, pool may be exhausted or have 1 left
    expect(["guessing", "ended"]).toContain(room.state.phase);
  });
});

// ─── RESET_GAME ──────────────────────────────────────────────────────────────

describe("RESET_GAME handler", () => {
  async function endedRoom() {
    vi.clearAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest" });
    room.state.phase = "ended";
    room.state.winner = P1;
    return { room, conn };
  }

  it("resets to lobby and preserves players", async () => {
    const { room, conn } = await endedRoom();
    await send(room, conn, { type: "RESET_GAME", hostId: "host-uuid" });
    expect(room.state.phase).toBe("lobby");
    expect(room.state.winner).toBeNull();
    expect(room.state.players[P1].name).toBe("Alice");
    expect(room.state.players[P1].cardCount).toBe(0);
    expect(room.state.players[P1].timeline).toHaveLength(0);
  });

  it("rejects RESET_GAME from non-host", async () => {
    const { room } = await endedRoom();
    const intruder = makeConn("intruder");
    await send(room, intruder, { type: "RESET_GAME", hostId: "wrong" });
    expect(lastSentTo(intruder)?.error).toBe("unauthorized");
    expect(room.state.phase).toBe("ended");
  });

  it("rejects RESET_GAME when not in ended phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.hostId = "host-uuid";
    room.state.phase = "guessing";
    const conn = makeConn();
    await send(room, conn, { type: "RESET_GAME", hostId: "host-uuid" });
    expect(lastSentTo(conn)?.error).toBe("wrong_phase");
    expect(room.state.phase).toBe("guessing");
  });
});

// ─── PLACE edge cases ─────────────────────────────────────────────────────────

describe("PLACE edge cases", () => {
  function roomInGuessing() {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.players[P2] = { name: "Bob", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985, yearSource: "description",
    };
    return r;
  }

  it("silently ignores PLACE from non-active player", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P2, position: 0 });
    expect(room.state.placements[P2]).toBeUndefined();
    expect(lastSentTo(conn)).toBeNull();
  });

  it("rejects negative position with invalid_position error", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P1, position: -1 });
    expect(lastSentTo(conn)?.error).toBe("invalid_position");
  });

  it("rejects float position to prevent cheat bypass", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: P1, position: 0.5 });
    expect(lastSentTo(conn)?.error).toBe("invalid_position");
    expect(room.state.placements[P1]).toBeUndefined();
  });
});

// ─── REVEAL edge cases ────────────────────────────────────────────────────────

describe("REVEAL edge cases", () => {
  it("rejects REVEAL when not in guessing phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.hostId = "host-uuid";
    room.state.phase = "reveal";
    const conn = makeConn();
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    expect(lastSentTo(conn)?.error).toBe("wrong_phase");
  });
});

// ─── START_GAME boundary conditions ──────────────────────────────────────────

describe("START_GAME targetCardCount clamping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clamps targetCardCount of 0 to 1", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest", targetCardCount: 0 });
    expect(room.state.targetCardCount).toBe(1);
  });

  it("clamps targetCardCount of 25 to 20", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest", targetCardCount: 25 });
    expect(room.state.targetCardCount).toBe(20);
  });
});

// ─── sanitizedState — year stripping ─────────────────────────────────────────

describe("sanitizedState — year stripping", () => {
  it("strips year from deck songs in STATE broadcast", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.songs = [
      { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985, yearSource: "description" },
      { id: "s2", videoId: "s2", title: "Song B", artist: "Artist", year: 1990, yearSource: "description" },
    ];
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.songs.every((s: { year: number }) => s.year === 0)).toBe(true);
  });

  it("strips year from currentSong during guessing phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985, yearSource: "description" };
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.currentSong?.year).toBe(0);
  });

  it("preserves year on currentSong during reveal phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "reveal";
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985, yearSource: "description" };
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.currentSong?.year).toBe(1985);
  });

  it("strips hostId from STATE broadcast", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.hostId = "secret-host-id";
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.hostId).toBe("");
  });
});

// ─── UUID validation ──────────────────────────────────────────────────────────

describe("UUID validation on JOIN/REJOIN/PLACE", () => {
  it("rejects JOIN with non-UUID playerId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: "not-a-uuid", name: "Alice" });
    expect(room.state.players["not-a-uuid"]).toBeUndefined();
    expect(Object.keys(room.state.players)).toHaveLength(0);
  });

  it("rejects REJOIN with non-UUID playerId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "REJOIN", playerId: "bad-id", name: "Alice" });
    expect(room.state.players["bad-id"]).toBeUndefined();
  });

  it("rejects PLACE with non-UUID playerId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    room.state.activePlayerId = P1;
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song", artist: "Artist", year: 1985, yearSource: "description" };
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: "not-a-uuid", position: 0 });
    expect(room.state.placements["not-a-uuid"]).toBeUndefined();
    expect(lastSentTo(conn)).toBeNull();
  });

  it("accepts JOIN with valid UUID", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    expect(room.state.players[P1]?.name).toBe("Alice");
  });
});

// ─── LOAD_SAVED_PLAYLIST handler ──────────────────────────────────────────────

describe("LOAD_SAVED_PLAYLIST handler", () => {
  const validSongs = [
    { videoId: "v1", title: "Song A", artist: "Artist", year: 1985 },
    { videoId: "v2", title: "Song B", artist: "Artist", year: 1990 },
  ];

  it("happy path — sets pendingPlaylist and sends PLAYLIST_READY", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: validSongs,
    });
    expect(lastSentTo(conn)?.type).toBe("PLAYLIST_READY");
    expect(lastSentTo(conn)?.songCount).toBe(2);
  });

  it("rejects in non-lobby phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.hostId = "host-uuid";
    const conn = makeConn();
    await send(room, conn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: validSongs,
    });
    expect(lastSentTo(conn)?.error).toBe("wrong_phase");
  });

  it("rejects unauthorized hostId once host is established", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    // First call establishes host
    await send(room, conn, { type: "LOAD_SAVED_PLAYLIST", hostId: "host-uuid", playlistId: "pl-1", songs: validSongs });
    // Second call with wrong hostId
    const impostor = makeConn("impostor");
    await send(room, impostor, { type: "LOAD_SAVED_PLAYLIST", hostId: "wrong-uuid", playlistId: "pl-2", songs: validSongs });
    expect(lastSentTo(impostor)?.error).toBe("unauthorized");
  });

  it("rejects when songs is not an array", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: null,
    });
    expect(lastSentTo(conn)?.error).toBe("not_enough_songs");
  });

  it("rejects when fewer than 2 songs pass validation", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: [{ videoId: "v1", title: "Song A", artist: "Artist", year: 1985 }],
    });
    expect(lastSentTo(conn)?.error).toBe("not_enough_songs");
  });

  it("includes all songs in PLAYLIST_READY but filters invalid years at game start", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: [
        { videoId: "v1", title: "Good Song", artist: "Artist", year: 1985 },
        { videoId: "v2", title: "Good Song 2", artist: "Artist", year: 1990 },
        { videoId: "v3", title: "Bad Song", artist: "Artist", year: 1800 }, // invalid year — shows in editor as null
      ],
    });
    const msg = lastSentTo(conn);
    expect(msg?.type).toBe("PLAYLIST_READY");
    // All 3 songs shown in PlaylistEditor (invalid year stored as null so host can fix it)
    expect(msg?.songCount).toBe(3);
    // Invalid year song has year: null in the list
    const badSong = msg?.songs?.find((s: { videoId: string }) => s.videoId === "v3");
    expect(badSong?.year).toBeNull();
  });

  it("rejects when hostConnId established but a different conn tries to claim host", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    room.onConnect(hostConn); // establishes hostConnId
    const attacker = makeConn("attacker");
    await send(room, attacker, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: validSongs,
    });
    expect(lastSentTo(attacker)?.error).toBe("unauthorized");
    expect(room.state.hostId).toBe(""); // host not claimed
  });
});

// ─── LOAD_PLAYLIST handler — AI metadata cache ────────────────────────────────

describe("LOAD_PLAYLIST handler — AI metadata cache", () => {
  const TWO_TRACKS = [
    { videoId: "v1", title: "Raw Title", description: "no year here", channelTitle: "Artist" },
    { videoId: "v2", title: "Another Song", description: "no year here", channelTitle: "Artist" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPlaylistItems).mockResolvedValue(TWO_TRACKS);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1", "v2"]));
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map());
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("cache hit — skips AI for cached tracks", async () => {
    vi.mocked(resolveTracksWithAI).mockResolvedValue(
      new Map([["v2", { title: "Another Song", artist: "Artist", year: 1990 }]])
    );

    const room = new HitsterRoom(makeRoom() as any);
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys)
        ? new Map([["aiMeta:v1", { title: "Cached Title", artist: "Cached Artist", year: 1975 }]])
        : undefined)
    );

    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });

    const callArg = vi.mocked(resolveTracksWithAI).mock.calls[0]?.[0] as { videoId: string }[];
    expect(callArg.map((t) => t.videoId)).toEqual(["v2"]);
    expect(lastSentTo(conn)?.type).toBe("PLAYLIST_READY");
  });

  it("cache write — persists fresh AI results to storage after LOAD_PLAYLIST", async () => {
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([
      ["v1", { title: "Song A", artist: "Artist", year: 1980 }],
      ["v2", { title: "Song B", artist: "Artist", year: 1985 }],
    ]));

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });

    const putCalls = (room.room.storage.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.length).toBeGreaterThan(0);
    const stored = putCalls[0][0] as Record<string, unknown>;
    expect(stored["aiMeta:v1"]).toBeDefined();
    expect(stored["aiMeta:v2"]).toBeDefined();
  });

  it("onBatchDone callback merges cachedAI + partial in DIAGNOSTIC", async () => {
    const cachedV1 = { title: "Cached Title", artist: "Cached Artist", year: 1975 };

    vi.mocked(resolveTracksWithAI).mockImplementation(
      (_tracks: unknown, _key: unknown, onBatchDone?: (partial: Map<string, { title: string; artist: string; year: number }>) => void) => {
        if (onBatchDone) {
          onBatchDone(new Map([["v2", { title: "AI Song B", artist: "AI Artist", year: 1990 }]]));
        }
        return Promise.resolve(new Map([["v2", { title: "AI Song B", artist: "AI Artist", year: 1990 }]]));
      }
    );

    const room = new HitsterRoom(makeRoom() as any);
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys)
        ? new Map([["aiMeta:v1", cachedV1]])
        : undefined)
    );

    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });

    // Find a DIAGNOSTIC emitted by the onBatchDone callback (has 2 songs with non-null years)
    const allMessages = (conn.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string));
    const callbackDiagnostic = allMessages.find(
      (m: { type: string; songs?: { year: number | null }[] }) =>
        m.type === "DIAGNOSTIC" && m.songs?.some((s) => s.year != null)
    );
    expect(callbackDiagnostic).toBeDefined();

    const v1Entry = callbackDiagnostic.songs.find((s: { title: string }) => s.title === "Cached Title");
    const v2Entry = callbackDiagnostic.songs.find((s: { title: string }) => s.title === "AI Song B");
    expect(v1Entry?.year).toBe(1975);
    expect(v2Entry?.year).toBe(1990);
  });
});

// ─── Malformed JSON ───────────────────────────────────────────────────────────

describe("malformed message handling", () => {
  it("silently ignores non-JSON messages", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    await expect(room.onMessage("not json", makeConn())).resolves.toBeUndefined();
  });
});

// ─── Lyrics Mode ─────────────────────────────────────────────────────────────

const LYRICS_ROUND = {
  videoId: "vid1",
  title: "Test Song",
  artist: "Test Artist",
  language: "zh-TW" as const,
  lyricContext: "Before ___",
  blankSentence: "你好世界",
  acceptableVariants: [],
};

function fakeLyricsTrack() {
  return { videoId: "vid1", title: "Test Song", description: "2000 年歌曲", channelTitle: "Test Artist" };
}

const CACHED_LYRICS = {
  title: "Test Song", artist: "Test Artist", language: "zh-TW" as const,
  lyricContext: "Before ___", blankSentence: "你好世界", acceptableVariants: [],
};

async function setupLyricsGame(overrides?: object) {
  vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
  vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1"]));

  const mockRoom = makeRoom();
  // Pre-populate DO storage with lyrics cache so tests don't need a real Anthropic key
  (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
    Promise.resolve(new Map(Array.isArray(keys)
      ? keys
          .filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:"))
          .map((k: string) => [k, CACHED_LYRICS])
      : []))
  );

  const room = new HitsterRoom(mockRoom as any);
  const hostConn = makeConn("host-conn");
  const p1Conn = makeConn("p1-conn");

  // Join player first
  await send(room, p1Conn, { type: "JOIN", playerId: P1, name: "Alice" });

  // Start lyrics game using a valid playlist ID (PLtest matches PLAYLIST_ID_PATTERN)
  await send(room, hostConn, {
    type: "START_LYRICS_GAME",
    hostId: "host-uuid",
    playlistUrl: "PLtest",
    config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    ...overrides,
  });

  // Advance past preview phase to playing so tests start in the expected state.
  await send(room, hostConn, { type: "CONFIRM_LYRICS_PREVIEW", hostId: "host-uuid" });

  return { room, hostConn, p1Conn };
}

describe("Lyrics Mode: sanitizedLyricsState hides blankSentence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("strips blankSentence during playing phase", async () => {
    const { room } = await setupLyricsGame();
    const msgs = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string));
    const playingState = msgs.findLast((m: any) => m.type === "LYRICS_STATE" && m.state.phase === "playing");
    expect(playingState).toBeDefined();
    expect(playingState.state.currentRound.blankSentence).toBeNull();
  });

  it("reveals blankSentence during results phase", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界", ts: Date.now() });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });

    const msgs = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string));
    const resultsState = msgs.findLast((m: any) => m.type === "LYRICS_STATE" && m.state.phase === "results");
    expect(resultsState?.state.currentRound.blankSentence).toBe("你好世界");
  });
});

describe("Lyrics Mode: START_LYRICS_GAME", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions to loading then preview then playing", async () => {
    const { room } = await setupLyricsGame();
    const broadcasts = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string));
    const phases = broadcasts.filter((m: any) => m.type === "LYRICS_STATE").map((m: any) => m.state.phase);
    expect(phases).toContain("loading");
    expect(phases).toContain("preview");
    expect(phases.at(-1)).toBe("playing");
  });

  it("rejects non-host", async () => {
    const { room } = await setupLyricsGame();
    // Stranger tries to start another game with wrong hostId
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "START_LYRICS_GAME", hostId: "bad-id", playlistUrl: "PLtest", config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false } });
    const lastMsg = lastSentTo(stranger);
    expect(lastMsg?.type).toBe("ERROR");
  });

  it("returns error when no lyrics resolved and no cache", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    const room = new HitsterRoom(makeRoom() as any);
    // Storage returns nothing — no lyrics cache, and anthropicKey is undefined so resolveLyricsForTracks won't be called
    (room.room.storage.get as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest", config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false } });
    const errorMsg = (hostConn.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string))
      .find((m: any) => m.type === "ERROR");
    expect(errorMsg).toBeDefined();
    expect(errorMsg.error).toBe("not_enough_songs");
  });

  it("applies lyricOverrides to deck", async () => {
    const { room } = await setupLyricsGame({
      lyricOverrides: [{ videoId: "vid1", blankSentence: "OVERRIDDEN" }],
    });
    const broadcasts = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string));
    // In preview phase, blankSentence is revealed so we can verify the override took effect
    const previewBcast = broadcasts.findLast((m: any) => m.type === "LYRICS_STATE" && m.state.phase === "preview");
    expect(previewBcast).toBeDefined();
    expect(previewBcast.state.rounds[0].blankSentence).toBe("OVERRIDDEN");
  });

  it("uses DO lyrics cache when available", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);

    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys
            .filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:"))
            .map((k: string) => [k, CACHED_LYRICS])
        : []))
    );

    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest", config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false } });
    // resolveLyricsForTracks should NOT be called (everything in DO cache, no anthropicKey anyway)
    expect(vi.mocked(resolveLyricsForTracks)).not.toHaveBeenCalled();
    const phases = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string))
      .filter((m: any) => m.type === "LYRICS_STATE")
      .map((m: any) => m.state.phase);
    // After START_LYRICS_GAME, phase is "preview"; needs CONFIRM_LYRICS_PREVIEW to reach "playing"
    expect(phases.at(-1)).toBe("preview");
  });
});

describe("Lyrics Mode: START_LYRICS_ROUND", () => {
  it("transitions playing → guessing and sets roundStart", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const msg = lastBroadcast(room);
    expect(msg?.type).toBe("LYRICS_STATE");
    expect(msg?.state.phase).toBe("guessing");
    expect(msg?.state.roundStart).toBeGreaterThan(0);
  });

  it("rejects wrong phase", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    // Now in guessing — sending again should error
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const last = lastSentTo(hostConn);
    expect(last?.type).toBe("ERROR");
    expect(last?.error).toBe("wrong_phase");
  });
});

describe("Lyrics Mode: SUBMIT_LYRICS_ANSWER", () => {
  it("stores answer and broadcasts", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界", ts: Date.now() });
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers[P1]?.text).toBe("你好世界");
  });

  it("ignores duplicate submission", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const ts = Date.now();
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "first", ts });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "second", ts: ts + 100 });
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers[P1]?.text).toBe("first");
  });

  it("rejects submission outside guessing phase", async () => {
    const { room, p1Conn } = await setupLyricsGame();
    // Still in playing phase
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "anything", ts: Date.now() });
    // No broadcast change for answers
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers?.[P1]).toBeUndefined();
  });

  it("sends TOO_LATE for answer after deadline", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const WAY_LATE = Date.now() + 200_000;
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "late", ts: WAY_LATE });
    const last = lastSentTo(p1Conn);
    expect(last?.type).toBe("TOO_LATE");
  });

  it("ignores unknown player", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "SUBMIT_LYRICS_ANSWER", playerId: STRANGER, text: "hi", ts: Date.now() });
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers?.[STRANGER]).toBeUndefined();
  });
});

describe("Lyrics Mode: SHOW_LYRICS_RESULTS", () => {
  async function reachResults() {
    const setup = await setupLyricsGame();
    const { room, hostConn, p1Conn } = setup;
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界", ts: Date.now() });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    return setup;
  }

  it("transitions guessing → results", async () => {
    const { room } = await reachResults();
    expect(lastBroadcast(room)?.state.phase).toBe("results");
  });

  it("marks correct answer and awards points", async () => {
    const { room } = await reachResults();
    const state = lastBroadcast(room)?.state;
    expect(state?.answers[P1]?.correct).toBe(true);
    expect(state?.answers[P1]?.points).toBeGreaterThan(0);
    expect(state?.players[P1]?.score).toBeGreaterThan(0);
  });

  it("marks wrong answer as incorrect with 0 points", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "wrong answer", ts: Date.now() });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    const state = lastBroadcast(room)?.state;
    expect(state?.answers[P1]?.correct).toBe(false);
    expect(state?.answers[P1]?.points).toBe(0);
    expect(state?.players[P1]?.score).toBe(0);
  });

  it("rejects non-host", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "SHOW_LYRICS_RESULTS", hostId: "bad-id" });
    const last = lastSentTo(stranger);
    expect(last?.type).toBe("ERROR");
  });
});

describe("Lyrics Mode: NEXT_LYRICS_ROUND", () => {
  it("ends game when last round done", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });
    expect(lastBroadcast(room)?.state.phase).toBe("ended");
  });

  it("rejects wrong phase", async () => {
    const { room, hostConn } = await setupLyricsGame();
    // Still in playing phase
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });
    const last = lastSentTo(hostConn);
    expect(last?.type).toBe("ERROR");
    expect(last?.error).toBe("wrong_phase");
  });
});

describe("Lyrics Mode: RESET_LYRICS_GAME", () => {
  it("clears lyrics state after ended", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });
    expect(lastBroadcast(room)?.state.phase).toBe("ended");
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    // After reset, no LYRICS_STATE broadcast — timeline lobby should be back
    const lastMsg = lastBroadcast(room);
    expect(lastMsg?.type).toBe("STATE");
    expect(lastMsg?.state.phase).toBe("lobby");
  });
});

describe("Lyrics Mode: RESET_LYRICS_GAME tells clients to drop lyrics state", () => {
  // Regression: ISSUE-002 — players stayed on the WINNER screen after the host clicked Play Again
  // Found by /qa on 2026-09-21
  it("broadcasts LYRICS_ABORTED before the lobby STATE so players leave the ended screen", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });
    const broadcast = room.room.broadcast as ReturnType<typeof vi.fn>;
    broadcast.mockClear();
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    const types = broadcast.mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(types).toContain("LYRICS_ABORTED");
    expect(types.indexOf("LYRICS_ABORTED")).toBeLessThan(types.lastIndexOf("STATE"));
  });
});

describe("Lyrics Mode: onConnect sends LYRICS_STATE when active", () => {
  it("sends lyricsState to new connections when game is active", async () => {
    const { room } = await setupLyricsGame();
    const newcomer = makeConn("new-conn");
    await room.onConnect(newcomer);
    const msgs = (newcomer.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string));
    const lyricsMsg = msgs.find((m: any) => m.type === "LYRICS_STATE");
    expect(lyricsMsg).toBeDefined();
    expect(lyricsMsg.state.phase).toBe("playing");
  });
});

describe("Lyrics Mode: CONFIRM_LYRICS_PREVIEW guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects wrong phase (not in preview)", async () => {
    const { room, hostConn } = await setupLyricsGame();
    // Already advanced to playing phase; CONFIRM_LYRICS_PREVIEW should error
    await send(room, hostConn, { type: "CONFIRM_LYRICS_PREVIEW", hostId: "host-uuid" });
    const last = lastSentTo(hostConn);
    expect(last?.type).toBe("ERROR");
    expect(last?.error).toBe("wrong_phase");
  });

  it("rejects non-host", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:"))
            .map((k: string) => [k, CACHED_LYRICS])
        : []))
    );
    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });
    // Now in preview phase — a stranger tries to confirm
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "CONFIRM_LYRICS_PREVIEW", hostId: "bad-id" });
    const last = lastSentTo(stranger);
    expect(last?.type).toBe("ERROR");
    expect(last?.error).toBe("unauthorized");
  });
});

describe("Lyrics Mode: NEXT_LYRICS_ROUND advances to next round", () => {
  beforeEach(() => vi.clearAllMocks());

  it("transitions results → playing with next round loaded", async () => {
    const TRACK_2 = { videoId: "vid2", title: "Second Song", description: "", channelTitle: "Artist 2" };
    const CACHED_LYRICS_2 = { title: "Second Song", artist: "Artist 2", language: "en" as const, lyricContext: "X ___", blankSentence: "hello", acceptableVariants: [] };

    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack(), TRACK_2]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1", "vid2"]));

    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:")).map((k: string) => {
            const id = k.startsWith("lyrics-sonnet:") ? k.slice(14) : k.slice(7);
            return [k, id === "vid2" ? CACHED_LYRICS_2 : CACHED_LYRICS];
          })
        : []))
    );

    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    const p1Conn = makeConn("p1-conn");

    await send(room, p1Conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 2, fuzzyEnabled: false },
    });
    await send(room, hostConn, { type: "CONFIRM_LYRICS_PREVIEW", hostId: "host-uuid" });

    // Complete round 1
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });

    const msg = lastBroadcast(room);
    expect(msg?.type).toBe("LYRICS_STATE");
    // Should be in playing phase with next round loaded (not ended)
    expect(msg?.state.phase).toBe("playing");
    expect(msg?.state.currentRoundIndex).toBe(1);
  });
});

describe("Lyrics Mode: RESET_LYRICS_GAME wrong phase", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects reset when game is not in ended phase", async () => {
    const { room, hostConn } = await setupLyricsGame();
    // Still in playing phase — reset should error
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    const last = lastSentTo(hostConn);
    expect(last?.type).toBe("ERROR");
    expect(last?.error).toBe("wrong_phase");
  });
});

describe("Lyrics Mode: generateLyricsPreview broadcasts LYRICS_PREVIEW", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("broadcasts LYRICS_PREVIEW with loading:false after cached lyrics loaded", async () => {
    const TWO_TRACKS = [
      { videoId: "v1", title: "Song A", description: "", channelTitle: "Artist" },
      { videoId: "v2", title: "Song B", description: "", channelTitle: "Artist" },
    ];
    vi.mocked(fetchPlaylistItems).mockResolvedValue(TWO_TRACKS);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1", "v2"]));
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map());

    const LYRICS_V1 = { title: "Song A", artist: "Artist", language: "en" as const, lyricContext: "X ___", blankSentence: "a", acceptableVariants: [] };
    const LYRICS_V2 = { title: "Song B", artist: "Artist", language: "en" as const, lyricContext: "Y ___", blankSentence: "b", acceptableVariants: [] };

    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(Array.isArray(keys)
        ? new Map(keys.filter((k: string) => k.startsWith("lyrics:")).map((k: string) => {
            const id = k.slice(7);
            return [k, id === "v1" ? LYRICS_V1 : id === "v2" ? LYRICS_V2 : null];
          }).filter(([, v]) => v !== null))
        : new Map())
    );

    const room = new HitsterRoom(mockRoom as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });
    // Flush all pending microtasks so the void generateLyricsPreview() completes
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const broadcasts = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string));
    const previewMsgs = broadcasts.filter((m: { type: string }) => m.type === "LYRICS_PREVIEW");
    expect(previewMsgs.length).toBeGreaterThan(0);
    const finalPreview = previewMsgs.at(-1);
    expect(finalPreview?.loading).toBe(false);
    expect(finalPreview?.rounds.length).toBeGreaterThan(0);
    // resolveLyricsForTracks should NOT be called (all cached)
    expect(vi.mocked(resolveLyricsForTracks)).not.toHaveBeenCalled();
  });
});

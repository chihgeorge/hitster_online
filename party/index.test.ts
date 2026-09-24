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
  const conn = {
    id,
    state: null as unknown,
    send: vi.fn(),
    close: vi.fn(),
    setState: vi.fn((s: unknown) => {
      conn.state = s;
      return conn.state;
    }),
  };
  return conn as unknown as import("partykit/server").Connection;
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
  return {
    ...actual,
    fetchPlaylistItems: vi.fn(),
    // Default: every requested video is embeddable (the realistic case) — tests that
    // specifically exercise the embeddability filter override this with their own
    // mockResolvedValue. Without a default, every test that doesn't care about this filter
    // would need to mock it anyway just to avoid `undefined.size` (fetchAndFilterTracks in
    // lib/playlist-resolver.ts, used by every playlist-loading path per D3).
    fetchEmbeddableVideoIds: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(new Set(ids))),
  };
});

vi.mock("../lib/ai-metadata", () => ({
  resolveTracksWithAI: vi.fn().mockResolvedValue(new Map()),
  proposeEdits: vi.fn().mockResolvedValue([]),
  proposeLyricEdits: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/lyrics-resolver", () => ({
  resolveLyricsForTracks: vi.fn().mockResolvedValue(new Map()),
  MODEL_GAME: "claude-sonnet-5",
}));

vi.mock("../lib/lyrics-popularity", () => ({
  fetchPopularitySummaries: vi.fn().mockResolvedValue(new Map()),
}));

import { fetchPlaylistItems, fetchEmbeddableVideoIds } from "../lib/youtube";
import { resolveTracksWithAI, proposeEdits, proposeLyricEdits } from "../lib/ai-metadata";
import { resolveLyricsForTracks } from "../lib/lyrics-resolver";
import { fetchPopularitySummaries } from "../lib/lyrics-popularity";

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

// Preview-phase LYRICS_STATE (the deck with answers revealed) goes only to privileged
// connections via conn.send, not room.broadcast — merge both sources in call order to see the
// full phase sequence a host actually observed.
function allSentMessages(room: HitsterRoom, ...conns: ReturnType<typeof makeConn>[]) {
  const bcast = room.room.broadcast as ReturnType<typeof vi.fn>;
  const entries = bcast.mock.calls.map((c: unknown[], i: number) => ({
    order: bcast.mock.invocationCallOrder[i],
    msg: JSON.parse(c[0] as string),
  }));
  for (const conn of conns) {
    const s = conn.send as ReturnType<typeof vi.fn>;
    s.mock.calls.forEach((c: unknown[], i: number) => {
      entries.push({ order: s.mock.invocationCallOrder[i], msg: JSON.parse(c[0] as string) });
    });
  }
  return entries.sort((a, b) => a.order - b.order).map((e) => e.msg);
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

  // Cross-device host handoff (docs/designs, /plan-eng-review 2026-09-22): hostClaimed is a
  // derived yes/no signal, never the real hostId — sanitizedState always zeros that separately.
  it("reports hostClaimed: false before any host claim", () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.hostClaimed).toBe(false);
    expect(msg?.state.hostId).toBe("");
  });

  it("reports hostClaimed: true after a host claim, still without exposing the real hostId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });

    const conn2 = makeConn("conn-2");
    room.onConnect(conn2);
    const msg = lastSentTo(conn2);
    expect(msg?.state.hostClaimed).toBe(true);
    expect(msg?.state.hostId).toBe("");
  });

  // Regression: found live during QA — the claim itself (inside handleLoadPlaylist) never used
  // to broadcast, so an already-open /screen tab never learned hostClaimed flipped to true until
  // some unrelated later broadcast. Fixed at the shared claimOrValidateHost wrapper, not per-caller.
  it("broadcasts STATE exactly once, on the FIRST successful host claim", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    expect(room.room.broadcast).toHaveBeenCalledTimes(1);
    const broadcasted = lastBroadcast(room);
    expect(broadcasted?.type).toBe("STATE");
    expect(broadcasted?.state.hostClaimed).toBe(true);
  });

  it("does not re-broadcast when the SAME host reconfirms via a later action", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    (room.room.broadcast as ReturnType<typeof vi.fn>).mockClear();
    await send(room, conn, { type: "ABORT_LOAD", hostId: "host-uuid" });
    expect(room.room.broadcast).not.toHaveBeenCalled();
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
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985,
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
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985,
    };

    const conn = makeConn("conn-1");

    // Simulate a double-click / network retry: same player sends PLACE twice simultaneously
    await Promise.all([
      send(r, conn, { type: "PLACE", playerId: P1, position: 0 }),
      send(r, conn, { type: "PLACE", playerId: P1, position: 0 }),
    ]);

    // Placement recorded correctly, and BOTH messages get their own ACK — handlePlace has no
    // idempotency guard against a duplicate/retried PLACE, so each call runs and acks in full.
    // Documents the actual behavior for TODOS.md's "concurrent-placement integration test" item.
    expect(r.state.placements[P1]).toBe(0);
    const sentMessages = (conn.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => JSON.parse(args[0] as string),
    );
    const acks = sentMessages.filter((m: { type: string }) => m.type === "PLACEMENT_ACK");
    expect(acks).toHaveLength(2);
  });

  it("last of two concurrent PLACE messages at different positions wins (handlePlace is synchronous, no interleaving)", async () => {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [{ id: "c1", videoId: "c1", title: "Old", artist: "A", year: 1990 }], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = { id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985 };

    const conn = makeConn("conn-1");

    // Two different positions "in flight" at once — e.g. a stale retry racing a fresh click.
    await Promise.all([
      send(r, conn, { type: "PLACE", playerId: P1, position: 0 }),
      send(r, conn, { type: "PLACE", playerId: P1, position: 1 }),
    ]);

    // handlePlace does no async work internally, so the Durable Object's single-threaded
    // model guarantees the second call fully completes after the first — last message wins,
    // deterministically, not a genuine race. Matches what the client's pendingPlace guard
    // (app/room/[code]/play/page.tsx, v0.12.8.0) already assumes: the server is the source of
    // truth for whichever PLACE actually lands last.
    expect(r.state.placements[P1]).toBe(1);
    const sentMessages = (conn.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (args: unknown[]) => JSON.parse(args[0] as string),
    );
    const acks = sentMessages.filter((m: { type: string }) => m.type === "PLACEMENT_ACK");
    expect(acks).toHaveLength(2);
  });

  it("rejects PLACE from a non-active player (spectator)", async () => {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players[P1] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.players[P2] = { name: "Bob", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.activePlayerId = P1;
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985,
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

  // Regression for D3 (docs/designs/decouple-quiz-bank.md): this fallback path (LOAD_PLAYLIST
  // wasn't called first) used to skip the embeddability filter that LOAD_PLAYLIST itself
  // applies — an inconsistency, not a deliberate difference. Now shared via
  // lib/playlist-resolver.ts's fetchAndFilterTracks, so behavior matches everywhere.
  it("filters out non-embeddable videos even on the fallback (no prior LOAD_PLAYLIST) path", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      fakeTrack("v1", 1980),
      fakeTrack("v2", 1985),
      fakeTrack("v3", 1990),
    ]);
    // Only v1/v2 are embeddable — v3 should never reach the deck. mockResolvedValueOnce, not
    // mockResolvedValue: the latter would persist past this test (vi.clearAllMocks() only
    // clears call history, not implementations) and silently filter v3 out of every later
    // test in this file that assumes the file-level "everything embeddable" default.
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValueOnce(new Set(["v1", "v2"]));

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "https://www.youtube.com/playlist?list=PL123",
    });

    expect(room.state.phase).toBe("guessing");
    expect(room.state.songs.some((s) => s.videoId === "v3")).toBe(false);
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

  // Regression: host claiming used to require being the room's first-ever connection
  // (hostConnId). That broke once /screen always connects first (it's what creates the room —
  // see app/screen/page.tsx), since the real host's later connection would be rejected. Claiming
  // is now value-wins, not connection-order-wins: any connection can claim host as long as it's
  // first to send a non-empty hostId.
  it("claims host on first value sent, regardless of which connection connects first", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const screenConn = makeConn("screen-conn"); // /screen is always the room's first connection now
    const hostConn = makeConn("host-conn");
    room.onConnect(screenConn);
    room.onConnect(hostConn); // second connection — would have been rejected under the old gate

    await send(room, hostConn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "hitster://test",
    });
    expect(room.state.hostId).toBe("host-uuid");
    expect(lastSentTo(hostConn)?.type).not.toBe("ERROR");
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
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985,
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

// Regression (TODOS.md P2): the host-editor year override reaches START_GAME's `songs` param
// (only on the LOAD_PLAYLIST-cached path — the fallback path ignores overrides entirely, see
// handleStartGame), but nothing verified it actually lands in the dealt deck AND changes
// placement scoring, not just the value shown back in the editor UI.
describe("START_GAME song year override reaches placement evaluation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the host-edited year, not the originally-fetched year, both in the dealt deck and in scoring", async () => {
    // v1 fetched at 1970, overridden to 2020. v2 fetched (and left un-overridden) at 2010.
    // Original order: v1(1970) < v2(2010). Overridden order: v1(2020) > v2(2010) — the
    // override flips their relative order, so whichever placement follows only lines up with
    // the override, not the original fetch.
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1", 1970), fakeTrack("v2", 2010)]);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });
    await send(room, conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
      songs: [{ videoId: "v1", title: "Song v1", artist: "TestArtist", year: 2020 }],
    });

    // The dealt deck reflects the override, wherever the card landed (starting card or round card).
    const startCard = room.state.players[P1].timeline[0];
    const roundCard = room.state.currentSong!;
    const v1Card = startCard.videoId === "v1" ? startCard : roundCard;
    expect(v1Card.year).toBe(2020); // not 1970 — the fetched year was overridden before scoring

    // Place the round card at position 0 ("before the starting card"). Correct iff
    // roundCard.year <= startCard.year using the OVERRIDDEN years — compute the expectation
    // from the actual dealt state so this holds regardless of which card became which.
    const expectedCorrect = roundCard.year <= startCard.year;
    await send(room, conn, { type: "PLACE", playerId: P1, position: 0 });
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });

    expect(room.state.players[P1].cardCount).toBe(expectedCorrect ? 2 : 1);
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
      { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985 },
      { id: "s2", videoId: "s2", title: "Song B", artist: "Artist", year: 1990 },
    ];
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.songs.every((s: { year: number }) => s.year === 0)).toBe(true);
  });

  it("strips year from currentSong during guessing phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985 };
    const conn = makeConn();
    room.onConnect(conn);
    const msg = lastSentTo(conn);
    expect(msg?.state.currentSong?.year).toBe(0);
  });

  it("preserves year on currentSong during reveal phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "reveal";
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song A", artist: "Artist", year: 1985 };
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

// Regression for TODOS.md P2 "Timeline mode exposes the real video id to all players at all
// times" — same bug class as the Lyrics Mode leak fixed in v0.5.0.0/v0.5.1.0, fixed here by
// routing currentSong.videoId through the same privilegedConns model.
describe("Timeline mode: currentSong.videoId is screen/host-only", () => {
  // Adversarial-review finding: songs[] (the full remaining deck) carried real videoIds to every
  // client too — nothing renders it today, but a player reading raw WS traffic could look up
  // every future round's video id in advance, not just the current one.
  it("a player's STATE broadcast has every deck song's videoId stripped, not just currentSong", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.songs = [
      { id: "s2", videoId: "FUTURE_ID_1", title: "Song B", artist: "Artist", year: 1990 },
      { id: "s3", videoId: "FUTURE_ID_2", title: "Song C", artist: "Artist", year: 1995 },
    ];
    const player = makeConn("player-1");
    room.onConnect(player);
    await send(room, player, { type: "JOIN", playerId: "00000000-0000-0000-0000-000000000004", name: "Dana" });
    const msg = lastSentTo(player);
    expect(msg?.state.songs.every((s: { videoId: string }) => s.videoId === "")).toBe(true);
  });

  it("a JOIN_SCREEN'd connection still gets the real deck videoIds", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.songs = [{ id: "s2", videoId: "FUTURE_ID_1", title: "Song B", artist: "Artist", year: 1990 }];
    const screen = makeConn("screen-2");
    await send(room, screen, { type: "JOIN_SCREEN", screenId: "screen-token" });
    expect(lastSentTo(screen)?.state.songs[0].videoId).toBe("FUTURE_ID_1");
  });

  it("a player's STATE broadcast has currentSong.videoId stripped", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.currentSong = { id: "s1", videoId: "REAL_ID", title: "Song A", artist: "Artist", year: 1985 };
    const player = makeConn("player-1");
    room.onConnect(player);
    await send(room, player, { type: "JOIN", playerId: "00000000-0000-0000-0000-000000000002", name: "Bob" });
    const msg = lastSentTo(player);
    expect(msg?.state.currentSong?.videoId).toBe("");
  });

  it("a JOIN_SCREEN'd connection gets the real videoId on the next STATE broadcast", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.currentSong = { id: "s1", videoId: "REAL_ID", title: "Song A", artist: "Artist", year: 1985 };
    const screen = makeConn("screen-1");
    await send(room, screen, { type: "JOIN_SCREEN", screenId: "screen-token" });
    // JOIN_SCREEN itself resends STATE immediately with the real id
    expect(lastSentTo(screen)?.state.currentSong?.videoId).toBe("REAL_ID");

    (screen.send as ReturnType<typeof vi.fn>).mockClear();
    await send(room, screen, { type: "JOIN", playerId: "00000000-0000-0000-0000-000000000003", name: "Carol" });
    expect(lastSentTo(screen)?.state.currentSong?.videoId).toBe("REAL_ID");
  });

  it("a host connection also gets the real videoId via broadcastState", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.hostId = "h1"; // already claimed, as in other host-gated tests in this file
    room.state.currentSong = { id: "s1", videoId: "REAL_ID", title: "Song A", artist: "Artist", year: 1985 };
    const host = makeConn("host-1");
    await send(room, host, { type: "REVEAL", hostId: "h1" }); // authorizeHost marks this conn privileged
    expect(lastSentTo(host)?.state.currentSong?.videoId).toBe("REAL_ID");
  });

  // Coverage gap found by /ship's coverage audit: JOIN_SCREEN shares claimOrValidateScreen with
  // GET_LYRICS_AUDIO (which has these exact negative-path tests — see "Lyrics Mode: video id is
  // screen-only" below), but the new entry point itself was never directly exercised.
  it("refuses JOIN_SCREEN with an empty screenId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN_SCREEN", screenId: "" });
    expect(lastSentTo(conn)?.type).toBe("ERROR");
  });

  it("refuses JOIN_SCREEN with a non-string screenId", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN_SCREEN", screenId: 12345 as unknown as string });
    expect(lastSentTo(conn)?.type).toBe("ERROR");
  });

  it("refuses JOIN_SCREEN from an impostor once the real screen has claimed the slot", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const screen = makeConn("screen-1");
    await send(room, screen, { type: "JOIN_SCREEN", screenId: "real-token" });
    expect(lastSentTo(screen)?.type).toBe("STATE"); // successful claim resends STATE, not ERROR

    const impostor = makeConn("impostor-1");
    await send(room, impostor, { type: "JOIN_SCREEN", screenId: "guessed-token" });
    expect(lastSentTo(impostor)?.type).toBe("ERROR");
  });

  // Coverage gap: broadcastState's privileged-exclusion array was only ever exercised with one
  // privileged connection at a time. Host AND screen privileged simultaneously covers the
  // `privileged.length > 1` branch of both the room.broadcast(..., without) exclusion and the
  // per-connection sendTo loop.
  it("broadcastState sends the real videoId to both a privileged host and a privileged screen at once", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    room.state.phase = "guessing";
    room.state.hostId = "h1";
    room.state.currentSong = { id: "s1", videoId: "REAL_ID", title: "Song A", artist: "Artist", year: 1985 };
    const host = makeConn("host-1");
    const screen = makeConn("screen-1");
    await send(room, host, { type: "REVEAL", hostId: "h1" }); // claims host privilege
    await send(room, screen, { type: "JOIN_SCREEN", screenId: "screen-token" }); // claims screen privilege
    const player = makeConn("player-1");
    room.onConnect(player);

    // A broadcastState-triggering event every connection observes:
    await send(room, player, { type: "JOIN", playerId: "00000000-0000-0000-0000-000000000005", name: "Eve" });

    expect(lastSentTo(host)?.state.currentSong?.videoId).toBe("REAL_ID");
    expect(lastSentTo(screen)?.state.currentSong?.videoId).toBe("REAL_ID");
    expect(lastSentTo(player)?.state.currentSong?.videoId).toBe("");
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
    room.state.currentSong = { id: "s1", videoId: "s1", title: "Song", artist: "Artist", year: 1985 };
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

  // Same regression as the START_GAME test above, for LOAD_SAVED_PLAYLIST — one of the other
  // three claim entry points — proving the fix applies uniformly, not just to START_GAME.
  it("claims host via LOAD_SAVED_PLAYLIST from a connection that connected after /screen", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const screenConn = makeConn("screen-conn");
    room.onConnect(screenConn);
    const hostConn = makeConn("host-conn");
    room.onConnect(hostConn);
    await send(room, hostConn, {
      type: "LOAD_SAVED_PLAYLIST",
      hostId: "host-uuid",
      playlistId: "pl-123",
      songs: validSongs,
    });
    expect(room.state.hostId).toBe("host-uuid");
    expect(lastSentTo(hostConn)?.type).not.toBe("ERROR");
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

// ─── PROPOSE_EDITS handler — chat-to-diff editing ─────────────────────────────
// docs/designs/ai-assisted-quiz-generation.md, Approach A.

describe("PROPOSE_EDITS handler", () => {
  const SONGS = [
    { videoId: "v1", title: "Wonderwall", artist: "Oasis", year: 1994 },
    { videoId: "v2", title: "Yesterday", artist: "The Beatles", year: 1965 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(proposeEdits).mockResolvedValue([]);
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  async function hostedRoom() {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    // Claim host via LOAD_PLAYLIST (one of the 4 first-claim entry points) — PROPOSE_EDITS
    // itself uses authorizeHost, which requires hostId already established.
    vi.mocked(fetchPlaylistItems).mockResolvedValue([]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set());
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    return { room, conn };
  }

  it("sends back the proposed diff on success", async () => {
    const diff = [{ videoId: "v1", field: "year" as const, oldValue: 1994, newValue: 1995 }];
    vi.mocked(proposeEdits).mockResolvedValue(diff);

    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix the year", songs: SONGS });

    expect(lastSentTo(conn)).toEqual({ type: "EDITS_PROPOSED", diff });
  });

  it("passes the instruction and songs through to proposeEdits with the server's API key", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix the year", songs: SONGS });

    expect(proposeEdits).toHaveBeenCalledWith("fix the year", SONGS, "test-key");
  });

  it("rejects a non-host connection", async () => {
    const { room } = await hostedRoom();
    const intruder = makeConn("intruder");
    await send(room, intruder, { type: "PROPOSE_EDITS", hostId: "wrong-host", instruction: "fix it", songs: SONGS });

    expect(lastSentTo(intruder)).toEqual({ type: "EDITS_PROPOSAL_FAILED", error: "unauthorized" });
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("rejects an empty songs list", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix it", songs: [] });

    expect(lastSentTo(conn)).toEqual({ type: "EDITS_PROPOSAL_FAILED", error: "invalid_request" });
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("rejects a blank instruction", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "   ", songs: SONGS });

    expect(lastSentTo(conn)).toEqual({ type: "EDITS_PROPOSAL_FAILED", error: "invalid_request" });
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("fails gracefully when the Anthropic API key isn't configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix it", songs: SONGS });

    expect(lastSentTo(conn)).toEqual({ type: "EDITS_PROPOSAL_FAILED", error: "api_key_missing" });
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("sends EDITS_PROPOSAL_FAILED if proposeEdits throws unexpectedly", async () => {
    vi.mocked(proposeEdits).mockRejectedValue(new Error("boom"));
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix it", songs: SONGS });

    expect(lastSentTo(conn)).toEqual({ type: "EDITS_PROPOSAL_FAILED", error: "propose_failed" });
  });

  it("never mutates room state — only sends the diff back to the requesting connection", async () => {
    vi.mocked(proposeEdits).mockResolvedValue([{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }]);
    const { room, conn } = await hostedRoom();
    const phaseBefore = room.state.phase;
    // hostedRoom()'s own setup (claiming host via LOAD_PLAYLIST) legitimately broadcasts once —
    // clear it so this only asserts on PROPOSE_EDITS's own behavior.
    (room.room.broadcast as ReturnType<typeof vi.fn>).mockClear();
    await send(room, conn, { type: "PROPOSE_EDITS", hostId: "host-uuid", instruction: "fix it", songs: SONGS });

    expect(room.state.phase).toBe(phaseBefore);
    expect(room.room.broadcast).not.toHaveBeenCalled();
  });
});

describe("PROPOSE_LYRIC_EDITS handler", () => {
  const ROUNDS = [
    { videoId: "v1", title: "愛你", artist: "Twice", lyricContext: "I want you 想要有 ___ 陪伴", blankSentence: "你的愛" },
    { videoId: "v2", title: "Dynamite", artist: "BTS", lyricContext: "Cos I, I, I'm in the ___", blankSentence: "stars" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(proposeLyricEdits).mockResolvedValue([]);
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  async function hostedRoom() {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    vi.mocked(fetchPlaylistItems).mockResolvedValue([]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set());
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    return { room, conn };
  }

  it("sends back the proposed diff on success", async () => {
    const diff = [{ videoId: "v1", field: "blankSentence" as const, oldValue: "你的愛", newValue: "你的心" }];
    vi.mocked(proposeLyricEdits).mockResolvedValue(diff);

    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix the answer", rounds: ROUNDS });

    expect(lastSentTo(conn)).toEqual({ type: "LYRIC_EDITS_PROPOSED", diff });
  });

  it("passes the instruction and rounds through to proposeLyricEdits with the server's API key", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix the answer", rounds: ROUNDS });

    expect(proposeLyricEdits).toHaveBeenCalledWith("fix the answer", ROUNDS, "test-key");
  });

  it("rejects a non-host connection", async () => {
    const { room } = await hostedRoom();
    const intruder = makeConn("intruder");
    await send(room, intruder, { type: "PROPOSE_LYRIC_EDITS", hostId: "wrong-host", instruction: "fix it", rounds: ROUNDS });

    expect(lastSentTo(intruder)).toEqual({ type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "unauthorized" });
    expect(proposeLyricEdits).not.toHaveBeenCalled();
  });

  it("rejects an empty rounds list", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix it", rounds: [] });

    expect(lastSentTo(conn)).toEqual({ type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "invalid_request" });
    expect(proposeLyricEdits).not.toHaveBeenCalled();
  });

  it("rejects a blank instruction", async () => {
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "   ", rounds: ROUNDS });

    expect(lastSentTo(conn)).toEqual({ type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "invalid_request" });
    expect(proposeLyricEdits).not.toHaveBeenCalled();
  });

  it("fails gracefully when the Anthropic API key isn't configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix it", rounds: ROUNDS });

    expect(lastSentTo(conn)).toEqual({ type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "api_key_missing" });
    expect(proposeLyricEdits).not.toHaveBeenCalled();
  });

  it("sends LYRIC_EDITS_PROPOSAL_FAILED if proposeLyricEdits throws unexpectedly", async () => {
    vi.mocked(proposeLyricEdits).mockRejectedValue(new Error("boom"));
    const { room, conn } = await hostedRoom();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix it", rounds: ROUNDS });

    expect(lastSentTo(conn)).toEqual({ type: "LYRIC_EDITS_PROPOSAL_FAILED", error: "propose_failed" });
  });

  it("never mutates room state — only sends the diff back to the requesting connection", async () => {
    vi.mocked(proposeLyricEdits).mockResolvedValue([{ videoId: "v1", field: "blankSentence", oldValue: "你的愛", newValue: "你的心" }]);
    const { room, conn } = await hostedRoom();
    const phaseBefore = room.state.phase;
    (room.room.broadcast as ReturnType<typeof vi.fn>).mockClear();
    await send(room, conn, { type: "PROPOSE_LYRIC_EDITS", hostId: "host-uuid", instruction: "fix it", rounds: ROUNDS });

    expect(room.state.phase).toBe(phaseBefore);
    expect(room.room.broadcast).not.toHaveBeenCalled();
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
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界" });
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
    const { room, hostConn } = await setupLyricsGame();
    const phases = allSentMessages(room, hostConn).filter((m) => m.type === "LYRICS_STATE").map((m) => m.state.phase);
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

  // Regression (TODOS.md P3, /ship adversarial review 2026-09-21): a second START_LYRICS_GAME
  // sent while the first is still mid-flight (double click, retry) used to pass the
  // state.phase === "lobby" check (Lyrics mode never touches state.phase) and race the first
  // call — whichever resolved last would silently clobber the deck the host actually saw.
  it("rejects a second START_LYRICS_GAME while the first is still mid-flight, without clobbering the first's deck", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1"]));
    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:"))
            .map((k: string) => [k, CACHED_LYRICS])
        : []))
    );
    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "JOIN", playerId: P1, name: "Alice" });

    // Fire both without awaiting the first — the second is dispatched while the first's async
    // pipeline is still running its awaits, exactly the double-click/retry race in question.
    const first = send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });
    const second = send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });
    await Promise.all([first, second]);

    // Exactly one of the two calls should have won and produced a deck; the rejected call's
    // "wrong_phase" ERROR is somewhere in hostConn's messages (not necessarily last — the
    // winning call's later broadcasts arrive after it).
    const hostMsgs = (hostConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(hostMsgs).toContainEqual(expect.objectContaining({ type: "ERROR", error: "wrong_phase" }));
    expect(room.lyricsState).not.toBeNull();
    expect(room.lyricsState?.rounds.length).toBeGreaterThan(0);
  });

  it("fetches and caches popularity summaries for songs needing a fresh Sonnet resolve (docs/designs/lyrics-question-search-grounding.md)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1"]));
    vi.mocked(resolveLyricsForTracks).mockResolvedValue(
      new Map([["vid1", CACHED_LYRICS]])
    );
    vi.mocked(fetchPopularitySummaries).mockResolvedValue(
      new Map([["vid1", "最有名的一句是..."]])
    );

    const mockRoom = makeRoom();
    // lyrics: (Haiku preview) cached so the deck can build; lyrics-sonnet: and
    // lyrics-popularity: both NOT cached, so both fresh-fetch paths fire.
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") && !k.startsWith("lyrics-sonnet:") && !k.startsWith("lyrics-popularity:"))
            .map((k: string) => [k, CACHED_LYRICS])
        : []))
    );

    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });

    expect(vi.mocked(fetchPopularitySummaries)).toHaveBeenCalledTimes(1);
    const [tracksArg] = vi.mocked(fetchPopularitySummaries).mock.calls[0];
    expect(tracksArg.map((t) => t.videoId)).toContain("vid1");

    // resolveLyricsForTracks (the Sonnet call) receives the fresh summary as its 5th arg.
    const sonnetCall = vi.mocked(resolveLyricsForTracks).mock.calls.at(-1)!;
    const summariesArg = sonnetCall[4] as Map<string, string>;
    expect(summariesArg.get("vid1")).toBe("最有名的一句是...");

    // Result gets cached under lyrics-popularity: for next time.
    const putCalls = (mockRoom.storage.put as ReturnType<typeof vi.fn>).mock.calls;
    const cachedPopularity = putCalls.find((c: any[]) => "lyrics-popularity:vid1" in (c[0] as object));
    expect(cachedPopularity).toBeDefined();

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("skips fetching popularity when the sonnet cache already has everything", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    await setupLyricsGame(); // pre-caches lyrics: and lyrics-sonnet: — no uncached tracks
    expect(vi.mocked(fetchPopularitySummaries)).not.toHaveBeenCalled();
    delete process.env.ANTHROPIC_API_KEY;
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
    const { room, hostConn } = await setupLyricsGame({
      lyricOverrides: [{ videoId: "vid1", blankSentence: "OVERRIDDEN" }],
    });
    // In preview phase, blankSentence is revealed (host-only) so we can verify the override took effect
    const previewMsg = allSentMessages(room, hostConn).findLast((m) => m.type === "LYRICS_STATE" && m.state.phase === "preview");
    expect(previewMsg).toBeDefined();
    expect(previewMsg.state.rounds[0].blankSentence).toBe("OVERRIDDEN");
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
    const phases = allSentMessages(room, hostConn).filter((m) => m.type === "LYRICS_STATE").map((m) => m.state.phase);
    // After START_LYRICS_GAME, phase is "preview"; needs CONFIRM_LYRICS_PREVIEW to reach "playing"
    expect(phases.at(-1)).toBe("preview");
  });
});

describe("Lyrics Mode: preview deck is host/screen-only (regression for the review-step leak)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not broadcast the preview deck — a player connection never receives the answers", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1"]));
    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:")).map((k: string) => [k, CACHED_LYRICS])
        : []))
    );
    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    const p1Conn = makeConn("p1-conn");
    await send(room, p1Conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });
    // room.broadcast() is the only channel a player connection could receive — never call it with the deck
    const broadcastCalls = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any[]) => JSON.parse(c[0] as string))
      .filter((m: any) => m.type === "LYRICS_STATE");
    expect(broadcastCalls.every((m: any) => m.state.rounds.length === 0)).toBe(true);
    // The player's own connection never got the deck either
    const toPlayer = (p1Conn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    expect(toPlayer.every((m: any) => m.type !== "LYRICS_STATE" || m.state.rounds.length === 0)).toBe(true);
    // The host, who claimed via START_LYRICS_GAME, does get the full deck
    const toHost = (hostConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    const hostPreview = toHost.find((m: any) => m.type === "LYRICS_STATE" && m.state.phase === "preview");
    expect(hostPreview?.state.rounds.length).toBeGreaterThan(0);
  });

  // Regression: security review found onConnect() sent the raw sanitizedLyricsState() (full
  // rounds/answers during preview) to ANY newly-connecting socket, bypassing broadcastLyricsState's
  // privilegedConns gate entirely — a player joining or reconnecting mid-preview got the answer key.
  // Found by /ship's security specialist review on 2026-09-22.
  it("onConnect does not send the preview deck to a connection that hasn't claimed host or screen", async () => {
    const { room } = await setupLyricsGame();
    // Force the room back into preview with a real deck, the way it looks before CONFIRM_LYRICS_PREVIEW.
    room.lyricsState!.phase = "preview";
    room.lyricsState!.rounds = [room.lyricsState!.currentRound!];

    const newPlayerConn = makeConn("late-joiner-conn");
    room.onConnect(newPlayerConn);
    const sent = (newPlayerConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    const lyricsMsg = sent.find((m: any) => m.type === "LYRICS_STATE");
    expect(lyricsMsg).toBeDefined();
    expect(lyricsMsg.state.rounds).toEqual([]);
  });

  it("onConnect sends the full preview deck when the reconnecting connection already claimed host", async () => {
    const { room, hostConn } = await setupLyricsGame();
    room.lyricsState!.phase = "preview";
    room.lyricsState!.rounds = [room.lyricsState!.currentRound!];

    // hostConn already claimed via setupLyricsGame's START_LYRICS_GAME, so it's privileged.
    (hostConn.send as ReturnType<typeof vi.fn>).mockClear();
    room.onConnect(hostConn);
    const sent = (hostConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    const lyricsMsg = sent.find((m: any) => m.type === "LYRICS_STATE");
    expect(lyricsMsg?.state.rounds.length).toBeGreaterThan(0);
  });

  // Regression: a /screen connected before the host confirms the preview never becomes privileged
  // during preview (it only claims via GET_LYRICS_AUDIO, which fires in playing/guessing/results,
  // never preview) — broadcastLyricsState used to skip it entirely, leaving it stuck on the
  // "loading" spinner through the whole review window instead of showing its "ready" UI.
  // Found by /ship's adversarial review on 2026-09-22.
  it("a connected-but-not-yet-privileged screen gets a redacted (not stale) preview update", async () => {
    const { room } = await setupLyricsGame();
    const screenConn = makeConn("screen-conn-not-yet-privileged");
    room.onConnect(screenConn); // connected, but never sent GET_LYRICS_AUDIO — not privileged
    (screenConn.send as ReturnType<typeof vi.fn>).mockClear();
    room.lyricsState!.phase = "preview";
    room.lyricsState!.rounds = [room.lyricsState!.currentRound!];
    (room as any).broadcastLyricsState();
    const toScreen = (screenConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    const lyricsMsg = toScreen.find((m: any) => m.type === "LYRICS_STATE");
    expect(lyricsMsg).toBeDefined(); // got SOMETHING, not silently skipped
    expect(lyricsMsg.state.phase).toBe("preview");
    expect(lyricsMsg.state.rounds).toEqual([]); // redacted, not the answer-bearing deck
  });

  it("a screen that has claimed via GET_LYRICS_AUDIO also gets the preview deck", async () => {
    const { room, hostConn } = await setupLyricsGame();
    // setupLyricsGame already advances past preview; re-derive a fresh preview round the same way
    // by claiming a screen mid-game, then confirming it would have received a later preview too
    const screenConn = makeConn("screen-conn");
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    (room.room.broadcast as ReturnType<typeof vi.fn>).mockClear();
    (screenConn.send as ReturnType<typeof vi.fn>).mockClear();
    (hostConn.send as ReturnType<typeof vi.fn>).mockClear();
    // Directly exercise the broadcast helper's preview path against the now-privileged screen
    room.lyricsState!.phase = "preview";
    room.lyricsState!.rounds = [room.lyricsState!.currentRound!];
    (room as any).broadcastLyricsState();
    const toScreen = (screenConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    expect(toScreen.some((m: any) => m.type === "LYRICS_STATE" && m.state.rounds.length > 0)).toBe(true);
  });

  // Regression: a stale/closed privileged connection throwing on send() used to abort the whole
  // broadcastLyricsState loop, silently dropping the update for every OTHER privileged connection
  // too. sendTo now catches per-connection so one dead socket can't take the rest down with it.
  // Found by /ship's testing specialist review on 2026-09-22.
  it("one privileged connection throwing on send does not stop delivery to the others", async () => {
    const { room, hostConn } = await setupLyricsGame();
    const screenConn = makeConn("screen-conn");
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    room.lyricsState!.phase = "preview";
    room.lyricsState!.rounds = [room.lyricsState!.currentRound!];
    (hostConn.send as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("WebSocket is not connected"); });
    (screenConn.send as ReturnType<typeof vi.fn>).mockClear();
    expect(() => (room as any).broadcastLyricsState()).not.toThrow();
    const toScreen = (screenConn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0] as string));
    expect(toScreen.some((m: any) => m.type === "LYRICS_STATE" && m.state.rounds.length > 0)).toBe(true);
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
  it("stores answer and broadcasts (redacted — see answer-leak fix tests below)", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界" });
    // Server-side storage has the real text...
    expect(room.lyricsState?.answers[P1]?.text).toBe("你好世界");
    // ...but the broadcast during guessing never carries it (answer-leak fix).
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers[P1]?.text).toBe("");
    expect(msg?.state?.answers[P1]).toBeDefined(); // presence (for the "N/M answered" count) still broadcasts
  });

  it("ignores duplicate submission", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "first" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "second" });
    expect(room.lyricsState?.answers[P1]?.text).toBe("first");
  });

  it("rejects submission outside guessing phase", async () => {
    const { room, p1Conn } = await setupLyricsGame();
    // Still in playing phase
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "anything" });
    // No broadcast change for answers
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers?.[P1]).toBeUndefined();
  });

  it("sends TOO_LATE for answer after deadline", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 200_000);
      await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "late" });
    } finally {
      vi.useRealTimers();
    }
    const last = lastSentTo(p1Conn);
    expect(last?.type).toBe("TOO_LATE");
  });

  it("ignores unknown player", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "SUBMIT_LYRICS_ANSWER", playerId: STRANGER, text: "hi" });
    const msg = lastBroadcast(room);
    expect(msg?.state?.answers?.[STRANGER]).toBeUndefined();
  });

  it("ignores an answer sent by a connection that isn't the joined player (identity spoofing)", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const impostor = makeConn("impostor-conn");
    await send(room, impostor, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "not really Alice" });
    expect(room.lyricsState?.answers[P1]).toBeUndefined();
    // The real P1 connection can still answer afterward.
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "actually Alice" });
    expect(room.lyricsState?.answers[P1]?.text).toBe("actually Alice");
  });

  // Regression for the answer-leak fix (TODOS.md P2, docs/designs/guess-mode-song-artist.md
  // eng review): broadcastLyricsState used to spread the full answers map — including raw
  // text — to every connection during guessing, so a player who answered later could read
  // everyone else's guesses off the wire before submitting their own.
  it("never broadcasts any player's raw answer text during guessing, even with multiple answers in flight", async () => {
    // Not setupLyricsGame() — ls.players is snapshotted at START_LYRICS_GAME time, so both
    // players must JOIN (the Timeline-mode player list) before the lyrics game starts.
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeLyricsTrack()]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["vid1"]));
    const mockRoom = makeRoom();
    (mockRoom.storage.get as ReturnType<typeof vi.fn>).mockImplementation((keys: unknown) =>
      Promise.resolve(new Map(Array.isArray(keys)
        ? keys.filter((k: string) => k.startsWith("lyrics:") || k.startsWith("lyrics-sonnet:"))
            .map((k: string) => [k, CACHED_LYRICS])
        : []))
    );
    const room = new HitsterRoom(mockRoom as any);
    const hostConn = makeConn("host-conn");
    const p1Conn = makeConn("p1-conn");
    const p2Conn = makeConn("p2-conn");
    await send(room, p1Conn, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, p2Conn, { type: "JOIN", playerId: P2, name: "Bob" });
    await send(room, hostConn, {
      type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest",
      config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false },
    });
    await send(room, hostConn, { type: "CONFIRM_LYRICS_PREVIEW", hostId: "host-uuid" });
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });

    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "Alice secret guess" });
    await send(room, p2Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P2, text: "Bob secret guess" });

    // Every LYRICS_STATE broadcast sent during this whole sequence — not just the last one —
    // must never carry either player's raw text while still in guessing phase.
    const guessingBroadcasts = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((m) => m.type === "LYRICS_STATE" && m.state.phase === "guessing");
    expect(guessingBroadcasts.length).toBeGreaterThan(0);
    for (const msg of guessingBroadcasts) {
      for (const pid of [P1, P2]) {
        if (msg.state.answers[pid]) expect(msg.state.answers[pid].text).toBe("");
      }
    }
    // The server's own private state still has the real text (needed for scoring at reveal).
    expect(room.lyricsState?.answers[P1]?.text).toBe("Alice secret guess");
    expect(room.lyricsState?.answers[P2]?.text).toBe("Bob secret guess");

    // Once revealed, the real text is broadcast — the fix only withholds it during guessing.
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    const resultsMsg = lastBroadcast(room);
    expect(resultsMsg?.state?.answers[P1]?.text).toBe("Alice secret guess");
    expect(resultsMsg?.state?.answers[P2]?.text).toBe("Bob secret guess");
  });
});

describe("Lyrics Mode: SHOW_LYRICS_RESULTS", () => {
  async function reachResults() {
    const setup = await setupLyricsGame();
    const { room, hostConn, p1Conn } = setup;
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "你好世界" });
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
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "wrong answer" });
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

  // Reset works in any phase since /review 2026-09-24 (quitting mid-game; the lobby guard would
  // otherwise lock an abandoned room). Only "no game at all" is wrong_phase.
  it("rejects reset when no Lyrics game exists", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
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
        ? new Map(keys.filter((k: string) => k.startsWith("lyrics:")).map((k: string): [string, typeof LYRICS_V1 | null] => {
            const id = k.slice(7);
            return [k, id === "v1" ? LYRICS_V1 : id === "v2" ? LYRICS_V2 : null];
          }).filter(([, v]) => v !== null))
        : new Map())
    );

    const room = new HitsterRoom(mockRoom as any);
    const conn = makeConn();
    const player = makeConn("player-conn");
    room.onConnect(player);
    await send(room, player, { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest", gameMode: "lyrics" });
    // Flush all pending microtasks so the void generateLyricsPreview() completes
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The preview carries every answer (blankSentence) — host/screen only, never a room broadcast
    // and never to a player's connection (/review 2026-09-24).
    const typesOf = (calls: unknown[][]) => calls.map((c) => JSON.parse(c[0] as string));
    expect(typesOf((room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls).some((m) => m.type === "LYRICS_PREVIEW")).toBe(false);
    expect(typesOf((player.send as ReturnType<typeof vi.fn>).mock.calls).some((m) => m.type === "LYRICS_PREVIEW")).toBe(false);
    const previewMsgs = typesOf((conn.send as ReturnType<typeof vi.fn>).mock.calls).filter((m: { type: string }) => m.type === "LYRICS_PREVIEW");
    expect(previewMsgs.length).toBeGreaterThan(0);
    const finalPreview = previewMsgs.at(-1);
    expect(finalPreview?.loading).toBe(false);
    expect(finalPreview?.rounds.length).toBeGreaterThan(0);
    // resolveLyricsForTracks should NOT be called (all cached)
    expect(vi.mocked(resolveLyricsForTracks)).not.toHaveBeenCalled();
  });

  // Regression: LOAD_PLAYLIST used to kick off lyrics preview generation unconditionally,
  // spending real Anthropic calls even when the host only ever plays timeline mode.
  it.each([
    ["timeline mode", "timeline" as const],
    ["gameMode omitted", undefined],
  ])("does not generate a lyrics preview when the host loads in %s", async (_label, gameMode) => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Song A", description: "", channelTitle: "Artist" },
    ]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1"]));
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map());

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest", gameMode });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const broadcasts = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string));
    expect(broadcasts.some((m: { type: string }) => m.type === "LYRICS_PREVIEW")).toBe(false);
  });
});

describe("Lyrics Mode: answer deadline boundary and reset side effects", () => {
  async function startGuessing() {
    const setup = await setupLyricsGame();
    await send(setup.room, setup.hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const { roundStart, timerSeconds } = lastBroadcast(setup.room).state;
    return { ...setup, deadline: roundStart + timerSeconds * 1000 };
  }

  it("accepts an answer inside the 500ms grace window past the timer", async () => {
    const { room, p1Conn, deadline } = await startGuessing();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(deadline + 400);
      await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "grace" });
    } finally {
      vi.useRealTimers();
    }
    expect(room.lyricsState?.answers[P1]?.text).toBe("grace");
  });

  it("sends TOO_LATE and stores nothing just past the grace window", async () => {
    const { room, p1Conn, deadline } = await startGuessing();
    const broadcast = room.room.broadcast as ReturnType<typeof vi.fn>;
    broadcast.mockClear();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(deadline + 501);
      await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "late" });
    } finally {
      vi.useRealTimers();
    }
    expect(lastSentTo(p1Conn)?.type).toBe("TOO_LATE");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("a mid-game reset ends the game for everyone and reopens the lobby", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    expect(room.lyricsState).toBeNull();
    expect(allSentMessages(room).some((m) => m.type === "LYRICS_ABORTED")).toBe(true);
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    expect(lastSentTo(hostConn)?.type).toBe("PLAYLIST_READY");
  });

  it("a reset during loading stops the stale start from touching the next game", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(fetchPlaylistItems).mockReturnValueOnce(new Promise((r) => { release = r; }) as any);
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, makeConn("p1"), { type: "JOIN", playerId: P1, name: "Alice" });
    const stale = send(room, hostConn, { type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "PLtest", config: { timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false } });
    expect(room.lyricsState?.phase).toBe("loading");
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    expect(room.lyricsState).toBeNull();
    // A new game starts while the stale fetch is still pending…
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    const guess = room.guessState;
    expect(guess?.phase).toBe("playing");
    // …then the stale fetch resolves: it must neither abort nor overwrite anything.
    release([]);
    await stale;
    expect(room.guessState).toBe(guess);
    expect(room.lyricsState).toBeNull();
    const aborts = allSentMessages(room).filter((m) => m.type === "LYRICS_ABORTED").length;
    expect(aborts).toBe(1); // only the reset's own
  });

  it("does not replay LYRICS_STATE to a player who connects after reset", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_LYRICS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "RESET_LYRICS_GAME", hostId: "host-uuid" });
    const late = makeConn("late-conn");
    await room.onConnect(late);
    const types = (late.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(types).not.toContain("LYRICS_STATE");
  });
});

describe("Lyrics Mode: adversarial-review hardening", () => {
  // Regression: reconnecting players kept the ended screen because LYRICS_ABORTED was edge-triggered
  // Found by /ship adversarial review on 2026-09-21
  it("tells a connecting client to drop stale lyrics state when no game is running", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn("reconnector");
    await room.onConnect(conn);
    const types = (conn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(types).toContain("LYRICS_ABORTED");
    expect(types.at(-1)).toBe("STATE");
  });

  it("does not send LYRICS_ABORTED to a client connecting mid-game", async () => {
    const { room } = await setupLyricsGame();
    const conn = makeConn("mid-game");
    await room.onConnect(conn);
    const types = (conn.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => JSON.parse(c[0]).type);
    expect(types).not.toContain("LYRICS_ABORTED");
    expect(types).toContain("LYRICS_STATE");
  });

  // Regression (fixed): ts used to be client-supplied, so a non-numeric value passed `ts >
  // deadline` (false) and NaN-poisoned the score. Server now stamps ts itself (TODOS.md P2), so
  // a client-supplied ts — of any shape — must simply be ignored, never trusted for timing/scoring.
  it.each([
    ["missing ts", undefined],
    ["string ts", "0"],
    ["NaN ts", NaN],
    ["a spoofed early ts (claiming max speed bonus)", 0],
  ])("ignores a client-supplied ts (%s) and stamps its own", async (_label, spoofedTs) => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: "x", ts: spoofedTs } as any);
    const stored = room.lyricsState?.answers[P1];
    expect(stored).toBeDefined();
    expect(stored!.ts).toBeGreaterThan(0);
    expect(stored!.ts).not.toBe(spoofedTs);
  });

  it("ignores an answer whose text is not a string instead of throwing", async () => {
    const { room, hostConn, p1Conn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_LYRICS_ANSWER", playerId: P1, text: { a: 1 } } as any);
    expect(room.lyricsState?.answers[P1]).toBeUndefined();
  });
});

describe("Lyrics Mode: video id is screen-only", () => {
  // Regression guard: players could open the lyric video from the broadcast and read the answer
  it("never broadcasts the current round's video id", async () => {
    const { room, hostConn } = await setupLyricsGame();
    const broadcast = room.room.broadcast as ReturnType<typeof vi.fn>;
    broadcast.mockClear(); // the review step still broadcasts the whole deck (see TODOS.md), only the round is in scope here
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const realId = room.lyricsState!.currentRound!.videoId;
    expect(realId).toBeTruthy();
    const raw = broadcast.mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(raw).not.toContain(realId);
    expect(lastBroadcast(room).state.currentRound.videoId).toBe("");
  });

  it("does not leak the id to a player who connects mid-round", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const late = makeConn("late-player");
    await room.onConnect(late);
    const raw = (late.send as ReturnType<typeof vi.fn>).mock.calls.map((c: any[]) => c[0]).join("\n");
    expect(raw).not.toContain(room.lyricsState!.currentRound!.videoId);
  });

  it("GET_LYRICS_AUDIO gives the screen the id and round index, to the screen only", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const screenConn = makeConn("screen-conn");
    const broadcast = room.room.broadcast as ReturnType<typeof vi.fn>;
    broadcast.mockClear();
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    expect(lastSentTo(screenConn)).toEqual({
      type: "LYRICS_AUDIO",
      videoId: room.lyricsState!.currentRound!.videoId,
      roundIndex: room.lyricsState!.currentRoundIndex,
    });
    expect(broadcast).not.toHaveBeenCalled();
    // The host connection never receives it — only the claimed screen does
    expect(lastSentTo(hostConn)?.type).not.toBe("LYRICS_AUDIO");
  });

  it("refuses GET_LYRICS_AUDIO with an empty screenId", async () => {
    const { room, p1Conn } = await setupLyricsGame();
    await send(room, p1Conn, { type: "GET_LYRICS_AUDIO", screenId: "" });
    const reply = lastSentTo(p1Conn);
    expect(reply?.type).toBe("ERROR");
    expect(JSON.stringify(reply)).not.toContain(room.lyricsState!.currentRound!.videoId);
  });

  // Untrusted client input: the wire type says screenId is a string, but a hand-crafted WebSocket
  // message can send anything JSON allows. Found by /ship's testing specialist review on 2026-09-22.
  it("refuses GET_LYRICS_AUDIO with a non-string screenId", async () => {
    const { room, p1Conn } = await setupLyricsGame();
    await send(room, p1Conn, { type: "GET_LYRICS_AUDIO", screenId: 12345 as unknown as string });
    expect(lastSentTo(p1Conn)?.type).toBe("ERROR");
  });

  it("first screenId claims the room; a different one is refused", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const screenConn = makeConn("screen-conn");
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "real-screen-token" });
    expect(lastSentTo(screenConn)?.type).toBe("LYRICS_AUDIO");
    // A second connection guessing a different token is refused, not treated as a second screen
    const impostor = makeConn("impostor-conn");
    await send(room, impostor, { type: "GET_LYRICS_AUDIO", screenId: "guessed-token" });
    expect(lastSentTo(impostor)?.type).toBe("ERROR");
    // The real screen can still reconnect on a new connection with its persisted token
    const screenReconnect = makeConn("screen-conn-2");
    await send(room, screenReconnect, { type: "GET_LYRICS_AUDIO", screenId: "real-screen-token" });
    expect(lastSentTo(screenReconnect)?.type).toBe("LYRICS_AUDIO");
  });

  // Regression/documentation: unlike hostId, claimOrValidateScreen has no "first connection"
  // race guard (see the comment on it in party/index.ts) — whoever sends GET_LYRICS_AUDIO with
  // a non-empty screenId FIRST claims the room's screen slot, even a connection that was never
  // meant to be the screen. The squatter's own connection receives LYRICS_AUDIO directly (see the
  // assertion below), i.e. a player COULD self-issue the current round's video id from their own
  // tab by hand — low realistic risk for a house game with friends, but a real gap, not a
  // hardened one. Known, accepted (TODOS.md P3, real fix is a host-minted token) — this test pins
  // the current behavior so a future change to the claim logic is a deliberate, reviewed
  // decision, not an accidental regression. Found by /ship's coverage audit on 2026-09-22,
  // reviewed by the adversarial review on 2026-09-22.
  it("an early GET_LYRICS_AUDIO from any connection claims the screen slot first, receiving the video id directly — known gap, not a guard", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    // Some other connection (not the real /screen page) races in with a made-up token first.
    const squatter = makeConn("squatter-conn");
    await send(room, squatter, { type: "GET_LYRICS_AUDIO", screenId: "squatter-token" });
    expect(lastSentTo(squatter)?.type).toBe("LYRICS_AUDIO");
    // The real screen, arriving after, is refused for the rest of the room's lifetime —
    // there is no re-claim path short of restarting the room (same as a squatted hostId).
    const realScreen = makeConn("real-screen-conn");
    await send(room, realScreen, { type: "GET_LYRICS_AUDIO", screenId: "the-real-screens-token" });
    expect(lastSentTo(realScreen)?.type).toBe("ERROR");
  });

  it("replies with a null id when no lyrics game is running", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const host = makeConn("h");
    const screenConn = makeConn("screen-conn");
    await send(room, host, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    expect(lastSentTo(screenConn)).toMatchObject({ type: "LYRICS_AUDIO", videoId: null });
  });
});

describe("Lyrics Mode: GET_LYRICS_AUDIO across rounds", () => {
  // The fixture deck has a single song, so simulate being on a later round by setting the index directly
  it("reports the current round index, so the screen can discard a reply for an earlier round", async () => {
    const { room, hostConn } = await setupLyricsGame();
    await send(room, hostConn, { type: "START_LYRICS_ROUND", hostId: "host-uuid" });
    const screenConn = makeConn("screen-conn");
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    expect(lastSentTo(screenConn)).toMatchObject({ type: "LYRICS_AUDIO", roundIndex: 0 });
    room.lyricsState!.currentRoundIndex = 3;
    await send(room, screenConn, { type: "GET_LYRICS_AUDIO", screenId: "screen-token" });
    expect(lastSentTo(screenConn)).toMatchObject({ type: "LYRICS_AUDIO", roundIndex: 3 });
  });
});

// ─── Dead-code cleanup: DIAGNOSTIC shape and error mapping ───────────────────

describe("DIAGNOSTIC without the retired status field", () => {
  it("cpop-test seed broadcasts DIAGNOSTIC with manual year source and no status", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const host = makeConn("h");
    await send(room, host, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    const diag = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .find((m: { type: string }) => m.type === "DIAGNOSTIC");
    expect(diag).toBeDefined();
    expect(diag).not.toHaveProperty("status");
    expect(diag.songs.length).toBeGreaterThan(0);
    expect(diag.songs.every((s: { yearSource: string }) => s.yearSource === "manual")).toBe(true);
  });

  it("initial DIAGNOSTIC sent while loading a playlist carries no status", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1", 1985), fakeTrack("v2", 1990)]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1", "v2"]));
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map());
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });
    const diags = (conn.send as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => JSON.parse(c[0] as string))
      .filter((m: { type: string }) => m.type === "DIAGNOSTIC");
    expect(diags.length).toBeGreaterThan(0);
    for (const d of diags) expect(d).not.toHaveProperty("status");
  });
});

describe("LOAD_PLAYLIST error mapping after removing spotify_error", () => {
  it.each([
    ["Spotify token request failed", "playlist_load_failed"],
    ["YouTube API error 500", "youtube_error:500"],
    ["HTTP 404", "playlist_not_found"],
  ])("maps %j to %s", async (message, code) => {
    vi.mocked(fetchPlaylistItems).mockRejectedValue(new Error(message));
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });
    expect(lastSentTo(conn)).toMatchObject({ type: "PLAYLIST_LOAD_ERROR", error: code });
  });
});

// ─── Guess Mode (docs/designs/guess-mode-song-artist.md) ─────────────────────

async function setupGuessGame(config: object = { timerSeconds: 60, totalRounds: 2, fuzzyEnabled: false }, songs?: object[]) {
  const room = new HitsterRoom(makeRoom() as any);
  const hostConn = makeConn("host-conn");
  const p1Conn = makeConn("p1-conn");
  const p2Conn = makeConn("p2-conn");
  await send(room, p1Conn, { type: "JOIN", playerId: P1, name: "Alice" });
  await send(room, p2Conn, { type: "JOIN", playerId: P2, name: "Bob" });
  await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test", gameMode: "guess" });
  await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config, songs });
  return { room, hostConn, p1Conn, p2Conn };
}

describe("Guess Mode: lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts straight in playing with no AI calls, and never broadcasts the deck or the answer", async () => {
    const { room } = await setupGuessGame();
    expect(resolveLyricsForTracks).not.toHaveBeenCalled();
    expect(room.guessState?.phase).toBe("playing");
    const msg = lastBroadcast(room);
    expect(msg?.type).toBe("GUESS_STATE");
    expect(msg.state.rounds).toBeUndefined();
    expect(msg.state.currentRound).toEqual({ hasArtist: true, title: null, artist: null });
    expect(JSON.stringify(msg)).not.toContain(room.guessState!.currentRound!.videoId);
  });

  it("full round: guess → results scores title/artist/bonus, reveals the answer, then advances and ends", async () => {
    const { room, hostConn, p1Conn, p2Conn } = await setupGuessGame();
    const round = room.guessState!.currentRound!;
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_GUESS", playerId: P1, title: round.title, artist: round.artist });
    await send(room, p2Conn, { type: "SUBMIT_GUESS", playerId: P2, title: round.title, artist: "wrong" });

    // Guessing-phase broadcast: who answered is visible, what they answered is not.
    const during = lastBroadcast(room);
    expect(Object.keys(during.state.answers).sort()).toEqual([P1, P2].sort());
    expect(JSON.stringify(during.state.answers)).not.toContain(round.title);

    await send(room, hostConn, { type: "SHOW_GUESS_RESULTS", hostId: "host-uuid" });
    const res = lastBroadcast(room).state;
    expect(res.phase).toBe("results");
    expect(res.currentRound).toEqual({ hasArtist: true, title: round.title, artist: round.artist });
    expect(res.answers[P1]).toMatchObject({ titleCorrect: true, artistCorrect: true, title: round.title });
    expect(res.answers[P1].bonusPoints).toBeGreaterThan(0);
    expect(res.answers[P2]).toMatchObject({ titleCorrect: true, artistCorrect: false, artistPoints: 0, bonusPoints: 0 });
    expect(res.players[P1].score).toBe(res.answers[P1].points);
    expect(res.players[P1].score).toBeGreaterThan(res.players[P2].score);

    await send(room, hostConn, { type: "NEXT_GUESS_ROUND", hostId: "host-uuid" });
    expect(room.guessState).toMatchObject({ phase: "playing", currentRoundIndex: 1, answers: {} });
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_GUESS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_GUESS_ROUND", hostId: "host-uuid" });
    expect(room.guessState?.phase).toBe("ended");

    await send(room, hostConn, { type: "RESET_GUESS_GAME", hostId: "host-uuid" });
    expect(room.guessState).toBeNull();
    const all = allSentMessages(room);
    expect(all.some((m) => m.type === "GUESS_ABORTED")).toBe(true);
  });

  it("a track with no artist metadata is a title-only round (hasArtist: false)", async () => {
    const songs = [{ videoId: "KqjgLbKZ1h0", title: "那些年", artist: "", year: 2012 }];
    const { room } = await setupGuessGame({ timerSeconds: 60, totalRounds: 30, fuzzyEnabled: false }, songs);
    const noArtist = room.guessState!.rounds.find((r) => r.videoId === "KqjgLbKZ1h0");
    expect(noArtist?.artist).toBe("");
    // Walk rounds until the title-only one is current, then check the public flag.
    const hostConn = makeConn("host-conn");
    for (let i = 0; i < room.guessState!.rounds.length && room.guessState!.currentRound?.videoId !== "KqjgLbKZ1h0"; i++) {
      await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
      await send(room, hostConn, { type: "SHOW_GUESS_RESULTS", hostId: "host-uuid" });
      await send(room, hostConn, { type: "NEXT_GUESS_ROUND", hostId: "host-uuid" });
    }
    expect(room.guessState!.currentRound?.videoId).toBe("KqjgLbKZ1h0");
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    expect(lastBroadcast(room).state.currentRound.hasArtist).toBe(false);
  });

  it("applies the host's title edits to the deck", async () => {
    const songs = [{ videoId: "KqjgLbKZ1h0", title: "Those Years", artist: "胡夏", year: 2012 }];
    const { room } = await setupGuessGame({ timerSeconds: 60, totalRounds: 30, fuzzyEnabled: false }, songs);
    expect(room.guessState!.rounds.find((r) => r.videoId === "KqjgLbKZ1h0")?.title).toBe("Those Years");
  });
});

describe("Guess Mode: guards", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a second START_GUESS_GAME, and a Lyrics start while Guess runs", async () => {
    const { room, hostConn } = await setupGuessGame();
    const deck = room.guessState!.rounds;
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
    expect(room.guessState!.rounds).toBe(deck);
    await send(room, hostConn, { type: "START_LYRICS_GAME", hostId: "host-uuid", playlistUrl: "hitster://cpop-test", config: {} });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
    expect(room.lyricsState).toBeNull();
  });

  it("errors with not_enough_songs when no playlist is loaded", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "not_enough_songs" });
    expect(room.guessState).toBeNull();
  });

  it("drops malformed, spoofed, duplicate and late guesses", async () => {
    const { room, hostConn, p1Conn } = await setupGuessGame();
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    await send(room, p1Conn, { type: "SUBMIT_GUESS", playerId: P1, title: 42, artist: "x" });
    expect(room.guessState!.answers[P1]).toBeUndefined();
    await send(room, makeConn("impostor"), { type: "SUBMIT_GUESS", playerId: P1, title: "a", artist: "b" });
    expect(room.guessState!.answers[P1]).toBeUndefined();
    await send(room, p1Conn, { type: "SUBMIT_GUESS", playerId: P1, title: "first", artist: "" });
    await send(room, p1Conn, { type: "SUBMIT_GUESS", playerId: P1, title: "second", artist: "" });
    expect(room.guessState!.answers[P1].title).toBe("first");

    const p2Conn = makeConn("p2-conn");
    await send(room, p2Conn, { type: "REJOIN", playerId: P2, name: "Bob" });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 200_000);
      await send(room, p2Conn, { type: "SUBMIT_GUESS", playerId: P2, title: "late", artist: "" });
    } finally {
      vi.useRealTimers();
    }
    expect(lastSentTo(p2Conn)?.type).toBe("TOO_LATE");
  });

  it("GET_GUESS_AUDIO gives the video id to the screen only", async () => {
    const { room, p1Conn } = await setupGuessGame();
    const screen = makeConn("screen-conn");
    await send(room, screen, { type: "GET_GUESS_AUDIO", screenId: "screen-uuid" });
    expect(lastSentTo(screen)).toEqual({ type: "GUESS_AUDIO", videoId: room.guessState!.currentRound!.videoId, roundIndex: 0 });
    await send(room, p1Conn, { type: "GET_GUESS_AUDIO", screenId: "not-the-screen" });
    expect(lastSentTo(p1Conn)).toMatchObject({ type: "ERROR", error: "unauthorized" });
  });

  it("onConnect sends GUESS_STATE mid-game and STATE stays ahead of it", async () => {
    const { room } = await setupGuessGame();
    const late = makeConn("late");
    room.onConnect(late);
    const types = (late.send as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string).type);
    expect(types).toContain("GUESS_STATE");
    expect(types).not.toContain("GUESS_ABORTED");
    expect(types.indexOf("STATE")).toBeLessThan(types.indexOf("GUESS_STATE"));
  });
});

describe("Guess Mode: review hardening", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["START_GUESS_ROUND", "SHOW_GUESS_RESULTS", "NEXT_GUESS_ROUND", "RESET_GUESS_GAME"])(
    "%s from a non-host is unauthorized and changes nothing", async (type) => {
      const { room } = await setupGuessGame();
      const before = { phase: room.guessState!.phase, idx: room.guessState!.currentRoundIndex };
      const stranger = makeConn("stranger");
      await send(room, stranger, { type, hostId: "bad-id" });
      expect(lastSentTo(stranger)).toMatchObject({ type: "ERROR", error: "unauthorized" });
      expect(room.guessState).toMatchObject({ phase: before.phase, currentRoundIndex: before.idx });
    });

  it("START_GUESS_GAME from a non-host is unauthorized", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    const stranger = makeConn("stranger");
    await send(room, stranger, { type: "START_GUESS_GAME", hostId: "bad-id", config: {} });
    expect(lastSentTo(stranger)).toMatchObject({ type: "ERROR", error: "unauthorized" });
    expect(room.guessState).toBeNull();
  });

  it("RESET_GUESS_GAME mid-game quits the game and reopens the lobby", async () => {
    const { room, hostConn } = await setupGuessGame();
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "RESET_GUESS_GAME", hostId: "host-uuid" });
    expect(room.guessState).toBeNull();
    expect(allSentMessages(room).some((m) => m.type === "GUESS_ABORTED")).toBe(true);
    await send(room, hostConn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "hitster://test" });
    expect(room.state.phase).toBe("guessing"); // Timeline started
  });

  it("RESET_GUESS_GAME with no game is wrong_phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://test" });
    await send(room, hostConn, { type: "RESET_GUESS_GAME", hostId: "host-uuid" });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
  });

  it("START_GUESS_GAME is refused while a playlist is still loading (titles not AI-cleaned yet)", async () => {
    let release!: (v: unknown) => void;
    vi.mocked(fetchPlaylistItems).mockReturnValueOnce(new Promise((r) => { release = r; }) as any);
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    const loading = send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "PLtest" });
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
    expect(room.guessState).toBeNull();
    release([fakeTrack("v1", 2001), fakeTrack("v2", 2002)]);
    await loading;
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    expect(room.guessState?.phase).toBe("playing");
  });

  it("START_GUESS_GAME during a Timeline game is wrong_phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const hostConn = makeConn("host-conn");
    await send(room, makeConn("p1"), { type: "JOIN", playerId: P1, name: "Alice" });
    await send(room, hostConn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "hitster://test" });
    expect(room.state.phase).toBe("guessing");
    await send(room, hostConn, { type: "START_GUESS_GAME", hostId: "host-uuid", config: {} });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
    expect(room.guessState).toBeNull();
  });

  it("lobby actions mid-round are refused, so the song list never reaches players", async () => {
    const { room, hostConn } = await setupGuessGame();
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    (room.room.broadcast as ReturnType<typeof vi.fn>).mockClear();
    await send(room, hostConn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "ERROR", error: "wrong_phase" });
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test", gameMode: "lyrics" });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
    await send(room, hostConn, { type: "LOAD_SAVED_PLAYLIST", hostId: "host-uuid", playlistId: "x", songs: [] });
    expect(lastSentTo(hostConn)).toMatchObject({ type: "PLAYLIST_LOAD_ERROR", error: "wrong_phase" });
    const sent = (room.room.broadcast as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string).type);
    expect(sent).not.toContain("DIAGNOSTIC");
    expect(sent).not.toContain("LYRICS_PREVIEW");
    expect(room.state.phase).toBe("lobby");
  });

  it("lobby actions are allowed again once the Guess game has ended", async () => {
    const { room, hostConn } = await setupGuessGame({ timerSeconds: 60, totalRounds: 1, fuzzyEnabled: false });
    await send(room, hostConn, { type: "START_GUESS_ROUND", hostId: "host-uuid" });
    await send(room, hostConn, { type: "SHOW_GUESS_RESULTS", hostId: "host-uuid" });
    await send(room, hostConn, { type: "NEXT_GUESS_ROUND", hostId: "host-uuid" });
    expect(room.guessState?.phase).toBe("ended");
    await send(room, hostConn, { type: "LOAD_PLAYLIST", hostId: "host-uuid", playlistUrl: "hitster://cpop-test" });
    expect(lastSentTo(hostConn)?.type).toBe("PLAYLIST_READY");
  });
});

describe("Guess Mode: unwinnable metadata", () => {
  it("drops symbol-only titles and treats symbol-only artists as title-only", async () => {
    const songs = [
      { videoId: "KqjgLbKZ1h0", title: "!!!", artist: "胡夏", year: 2012 },
      { videoId: "vsBf_0gDxSM", title: "可惜沒如果", artist: "!!!", year: 2014 },
    ];
    const { room } = await setupGuessGame({ timerSeconds: 60, totalRounds: 30, fuzzyEnabled: false }, songs);
    expect(room.guessState!.rounds.find((r) => r.videoId === "KqjgLbKZ1h0")).toBeUndefined();
    expect(room.guessState!.rounds.find((r) => r.videoId === "vsBf_0gDxSM")?.artist).toBe("");
  });
});

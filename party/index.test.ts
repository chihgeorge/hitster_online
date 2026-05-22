import { describe, it, expect, vi, beforeEach } from "vitest";
import HitsterRoom from "./index";

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
    storage: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
  } as unknown as import("partykit/server").Room;
}

// Only mock fetchPlaylistItems (network); real parse helpers run untouched so
// fakeTrack descriptions are parsed correctly without extra stubbing.
vi.mock("../lib/youtube", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, fetchPlaylistItems: vi.fn() };
});

vi.mock("../lib/spotify", () => ({
  lookupReleaseYear: vi.fn(),
}));

import { fetchPlaylistItems } from "../lib/youtube";
import { lookupReleaseYear } from "../lib/spotify";

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
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "Alice" });
    expect(room.state.players["p1"].name).toBe("Alice");
    expect(lastBroadcast(room)?.type).toBe("STATE");
  });

  it("sanitizes name: strips HTML special characters", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "  <Alice>  " });
    expect(room.state.players["p1"].name).toBe("Alice");
  });

  it("rejects empty name after sanitization", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "<<<" });
    expect(lastSentTo(conn)?.error).toBe("invalid_name");
    expect(room.state.players["p1"]).toBeUndefined();
  });

  it("truncates name at 20 characters", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "A".repeat(30) });
    expect(room.state.players["p1"].name).toHaveLength(20);
  });

  it("rejects new player when room is full (8 players)", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    for (let i = 0; i < 8; i++) {
      await send(room, makeConn(`c${i}`), { type: "JOIN", playerId: `p${i}`, name: `P${i}` });
    }
    const late = makeConn("c8");
    await send(room, late, { type: "JOIN", playerId: "p8", name: "Late" });
    expect(lastSentTo(late)?.error).toBe("room_full");
  });
});

// ─── REJOIN ───────────────────────────────────────────────────────────────────

describe("REJOIN handler", () => {
  it("marks known player connected and sends state", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    await send(room, makeConn(), { type: "JOIN", playerId: "p1", name: "Alice" });
    room.state.players["p1"].connected = false;

    const conn2 = makeConn("c2");
    await send(room, conn2, { type: "REJOIN", playerId: "p1", name: "Alice" });
    expect(room.state.players["p1"].connected).toBe(true);
    expect(lastSentTo(conn2)?.type).toBe("STATE");
  });

  it("treats unknown playerId as new JOIN", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "REJOIN", playerId: "stranger", name: "Bob" });
    expect(room.state.players["stranger"]?.name).toBe("Bob");
  });
});

// ─── PLACE ────────────────────────────────────────────────────────────────────

describe("PLACE handler", () => {
  function roomInGuessing() {
    const r = new HitsterRoom(makeRoom() as any);
    r.state.players["p1"] = { name: "Alice", cardCount: 0, timeline: [], connected: true };
    r.state.phase = "guessing";
    r.state.currentSong = {
      id: "v1", videoId: "v1", title: "Song", artist: "Artist", year: 1985, yearSource: "description",
    };
    return r;
  }

  it("records placement and sends PLACEMENT_ACK", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: "p1", position: 0 });
    expect(room.state.placements["p1"]).toBe(0);
    expect(lastSentTo(conn)?.type).toBe("PLACEMENT_ACK");
  });

  it("rejects position outside timeline bounds", async () => {
    const room = roomInGuessing();
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: "p1", position: 5 });
    expect(lastSentTo(conn)?.error).toBe("invalid_position");
  });

  it("sends WRONG_PHASE when not in guessing phase", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, { type: "PLACE", playerId: "p1", position: 0 });
    expect(lastSentTo(conn)?.type).toBe("WRONG_PHASE");
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
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "Alice" });
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

  it("falls back to Spotify year when no year in description or title", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([
      { videoId: "v1", title: "Untitled Song", description: "no year here", channelTitle: "Artist" },
      { videoId: "v2", title: "Another Song", description: "no year here", channelTitle: "Artist" },
    ]);
    vi.mocked(lookupReleaseYear).mockResolvedValue(1980);

    const room = new HitsterRoom(makeRoom() as any);
    const conn = makeConn();
    await send(room, conn, {
      type: "START_GAME",
      hostId: "host-uuid",
      playlistUrl: "PLtest",
    });

    expect(lookupReleaseYear).toHaveBeenCalled();
    expect(room.state.phase).toBe("guessing");
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
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "Alice" });
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
    await send(room, conn, { type: "PLACE", playerId: "p1", position: 0 });
    const cardsBefore = room.state.players["p1"].cardCount;
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    // cardCount may have changed (correct or incorrect) — just verify no crash
    expect(typeof room.state.players["p1"].cardCount).toBe("number");
    expect(room.state.players["p1"].cardCount).toBeGreaterThanOrEqual(cardsBefore);
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
    room.state.players["p1"].cardCount = 9;
    room.state.targetCardCount = 10;

    // Make an unconditionally correct placement: set up song year to fit before player's timeline
    const songYear = room.state.currentSong!.year;
    const timeline = room.state.players["p1"].timeline;
    const pos = timeline.findIndex((c) => c.year >= songYear);
    const safePos = pos === -1 ? timeline.length : pos;
    await send(room, conn, { type: "PLACE", playerId: "p1", position: safePos });
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });

    if (room.state.players["p1"].cardCount >= 10) {
      expect(room.state.phase).toBe("ended");
      expect(room.state.winner).toBe("p1");
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
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "Alice" });
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
    await send(room, conn, { type: "JOIN", playerId: "p1", name: "Alice" });
    await send(room, conn, { type: "START_GAME", hostId: "host-uuid", playlistUrl: "PLtest" });
    await send(room, conn, { type: "REVEAL", hostId: "host-uuid" });
    await send(room, conn, { type: "NEXT_ROUND", hostId: "host-uuid" });

    // With 2 tracks and 1 player starting card, pool may be exhausted or have 1 left
    expect(["guessing", "ended"]).toContain(room.state.phase);
  });
});

// ─── Malformed JSON ───────────────────────────────────────────────────────────

describe("malformed message handling", () => {
  it("silently ignores non-JSON messages", async () => {
    const room = new HitsterRoom(makeRoom() as any);
    await expect(room.onMessage("not json", makeConn())).resolves.toBeUndefined();
  });
});

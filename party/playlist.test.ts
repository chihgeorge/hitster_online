import { describe, it, expect, vi, beforeEach } from "vitest";
import PlaylistParty from "./playlist";
import type { EditableSong } from "../lib/game";

vi.mock("../lib/playlist-resolver", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, resolvePlaylistFromUrl: vi.fn() };
});
import { resolvePlaylistFromUrl } from "../lib/playlist-resolver";

vi.mock("../lib/ai-metadata", () => ({ proposeEdits: vi.fn() }));
import { proposeEdits } from "../lib/ai-metadata";

// ─── Mock PartyKit room ───────────────────────────────────────────────────────

/** D2a: room.context.parties.library.get(hostId).fetch(...) is how PlaylistParty writes
 * to the library index server-side. This stub records every such call so tests can assert
 * on it, and defaults to a 200 OK response. */
function makeLibraryFetchMock() {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function makeRoom(id = "test-playlist-id", libraryFetch = makeLibraryFetchMock()) {
  const store = new Map<string, unknown>();
  return {
    id,
    env: {},
    storage: {
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      put: vi.fn((key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); }),
      delete: vi.fn((key: string) => { store.delete(key); return Promise.resolve(); }),
      deleteAll: vi.fn(() => { store.clear(); return Promise.resolve(); }),
    },
    context: {
      parties: {
        library: { get: (_hostId: string) => ({ fetch: libraryFetch }) },
      },
    },
    // expose internal store for assertions
    _store: store,
  } as unknown as import("partykit/server").Room & { _store: Map<string, unknown> };
}

function makeRequest(method: string, body?: unknown, id = "test-playlist-id"): import("partykit/server").Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  return {
    method,
    url: `http://localhost/parties/playlist/${id}`,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as import("partykit/server").Request;
}

function song(videoId: string, year = 2000): EditableSong {
  return { videoId, title: `Song ${videoId}`, artist: "Test Artist", year };
}

async function parseResponse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

// ─── Helpers to set up initial state ─────────────────────────────────────────

async function createPlaylist(party: PlaylistParty, songs: EditableSong[], name = "My Mix") {
  const req = makeRequest("POST", { ownerHostId: "host-1", name, songs });
  return party.onRequest(req);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PlaylistParty: POST — save playlist", () => {
  it("saves a valid playlist and returns 201", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const songs = [song("v1"), song("v2", 1995)];
    const req = makeRequest("POST", { ownerHostId: "host-1", name: "My Mix", songs });
    const res = await party.onRequest(req);
    const { status, body } = await parseResponse(res);

    expect(status).toBe(201);
    expect(body.playlistId).toBe("test-playlist-id");
    expect(room.storage.put).toHaveBeenCalledWith("ownerHostId", "host-1");
  });

  it("returns 409 if playlist already exists", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    await createPlaylist(party, [song("v1"), song("v2")]);
    const res = await createPlaylist(party, [song("v3"), song("v4")]);
    const { status } = await parseResponse(res);

    expect(status).toBe(409);
  });

  it("rejects missing ownerHostId", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const req = makeRequest("POST", { name: "My Mix", songs: [song("v1"), song("v2")] });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  it("rejects missing name", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const req = makeRequest("POST", { ownerHostId: "host-1", songs: [song("v1"), song("v2")] });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  it("rejects invalid year in songs", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const badSongs = [song("v1", 1800), song("v2")];
    const req = makeRequest("POST", { ownerHostId: "host-1", name: "Bad Mix", songs: badSongs });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  it("rejects empty title in songs", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const badSongs = [{ videoId: "v1", title: "  ", artist: "A", year: 2000 }, song("v2")];
    const req = makeRequest("POST", { ownerHostId: "host-1", name: "My Mix", songs: badSongs });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });
});

describe("PlaylistParty: POST action RESOLVE_FROM_URL (D1/D2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves a playlist server-side and saves it, same as the client-songs path", async () => {
    vi.mocked(resolvePlaylistFromUrl).mockResolvedValue({
      tracks: [], metas: [], aiResults: new Map(), diagnostics: [], skippedEmbeddingCount: 0,
      songs: [{ id: "v1", videoId: "v1", title: "T", artist: "A", year: 2020 }],
      allSongs: [{ videoId: "v1", title: "T", artist: "A", year: 2020 }, { videoId: "v2", title: "T2", artist: "A2", year: 2019 }],
    });

    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", {
      ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL", playlistUrl: "https://www.youtube.com/playlist?list=PLtest",
    });
    const { status, body } = await parseResponse(await party.onRequest(req));

    expect(status).toBe(201);
    expect(body.playlistId).toBe("test-playlist-id");
    expect(room._store.get("playlist")).toMatchObject({
      songs: [{ videoId: "v1", title: "T", artist: "A", year: 2020 }, { videoId: "v2", title: "T2", artist: "A2", year: 2019 }],
    });
  });

  it("rejects a missing playlistUrl", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", { ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
    expect(resolvePlaylistFromUrl).not.toHaveBeenCalled();
  });

  it("rejects an unparseable playlistUrl", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", { ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL", playlistUrl: "not a url" });
    const { status, body } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
    expect(body.error).toBe("playlist_load_failed");
  });

  it("returns not_enough_songs when fewer than 2 songs resolve", async () => {
    vi.mocked(resolvePlaylistFromUrl).mockResolvedValue({
      tracks: [], metas: [], aiResults: new Map(), diagnostics: [], skippedEmbeddingCount: 0,
      songs: [], allSongs: [{ videoId: "v1", title: "T", artist: "A", year: 2020 }],
    });
    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", {
      ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL", playlistUrl: "https://www.youtube.com/playlist?list=PLtest",
    });
    const { status, body } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
    expect(body.error).toBe("not_enough_songs");
  });

  it("maps a resolution failure to a stable error code instead of throwing", async () => {
    vi.mocked(resolvePlaylistFromUrl).mockRejectedValue(new Error("QUOTA_EXCEEDED"));
    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", {
      ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL", playlistUrl: "https://www.youtube.com/playlist?list=PLtest",
    });
    const { status, body } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
    expect(body.error).toBe("quota_exceeded");
  });

  it("never partially saves a playlist when resolution fails", async () => {
    vi.mocked(resolvePlaylistFromUrl).mockRejectedValue(new Error("boom"));
    const room = makeRoom();
    const party = new PlaylistParty(room);
    const req = makeRequest("POST", {
      ownerHostId: "host-1", name: "From URL", action: "RESOLVE_FROM_URL", playlistUrl: "https://www.youtube.com/playlist?list=PLtest",
    });
    await party.onRequest(req);
    expect(room._store.has("playlist")).toBe(false);
  });
});

describe("PlaylistParty: library sync on create/delete (D2a)", () => {
  it("UPSERTs the library index on successful create, with the right owner/entry shape", async () => {
    const libraryFetch = makeLibraryFetchMock();
    const room = makeRoom("test-playlist-id", libraryFetch);
    const party = new PlaylistParty(room);

    await createPlaylist(party, [song("v1"), song("v2")], "My Mix");

    expect(libraryFetch).toHaveBeenCalledTimes(1);
    const [, init] = libraryFetch.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      action: "UPSERT",
      entry: { id: "test-playlist-id", name: "My Mix", songCount: 2 },
    });
  });

  it("REMOVEs the library entry on successful delete", async () => {
    const libraryFetch = makeLibraryFetchMock();
    const room = makeRoom("test-playlist-id", libraryFetch);
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);
    libraryFetch.mockClear();

    await party.onRequest(makeRequest("DELETE", { ownerHostId: "host-1" }));

    expect(libraryFetch).toHaveBeenCalledTimes(1);
    const [, init] = libraryFetch.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ action: "REMOVE", id: "test-playlist-id" });
  });

  it("still returns 201 even when the library sync fails — playlist write is not rolled back", async () => {
    const libraryFetch = vi.fn().mockRejectedValue(new Error("library DO unreachable"));
    const room = makeRoom("test-playlist-id", libraryFetch);
    const party = new PlaylistParty(room);

    const res = await createPlaylist(party, [song("v1"), song("v2")]);
    const { status } = await parseResponse(res);

    expect(status).toBe(201);
    expect(room._store.has("playlist")).toBe(true);
  });

  it("still returns 200 even when the library sync returns a non-OK response on delete", async () => {
    const libraryFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const room = makeRoom("test-playlist-id", libraryFetch);
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const res = await party.onRequest(makeRequest("DELETE", { ownerHostId: "host-1" }));
    expect((await parseResponse(res)).status).toBe(200);
  });
});

describe("PlaylistParty: GET — fetch playlist", () => {
  it("returns 404 when playlist does not exist", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    const res = await party.onRequest(makeRequest("GET"));
    expect((await parseResponse(res)).status).toBe(404);
  });

  it("returns the stored playlist", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);

    await createPlaylist(party, [song("v1"), song("v2", 1980)], "Weekend Hits");
    const res = await party.onRequest(makeRequest("GET"));
    const { status, body } = await parseResponse(res);

    expect(status).toBe(200);
    expect(body.name).toBe("Weekend Hits");
    expect(body.songs).toHaveLength(2);
    expect(body.songs[0].videoId).toBe("v1");
  });
});

describe("PlaylistParty: PUT action=UPDATE_SONG", () => {
  it("updates title, artist, and year of a song", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("PUT", {
      ownerHostId: "host-1",
      action: "UPDATE_SONG",
      videoId: "v1",
      title: "New Title",
      artist: "New Artist",
      year: 1985,
    });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(200);

    const getRes = await party.onRequest(makeRequest("GET"));
    const { body } = await parseResponse(getRes);
    const updated = (body.songs as EditableSong[]).find((s) => s.videoId === "v1");
    expect(updated?.title).toBe("New Title");
    expect(updated?.year).toBe(1985);
  });

  it("rejects unauthorized update", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("PUT", {
      ownerHostId: "wrong-host",
      action: "UPDATE_SONG",
      videoId: "v1",
      title: "Hacked",
    });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(403);
  });

  it("rejects invalid year", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("PUT", {
      ownerHostId: "host-1",
      action: "UPDATE_SONG",
      videoId: "v1",
      year: 1800,
    });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  it("returns 404 for unknown videoId", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("PUT", {
      ownerHostId: "host-1",
      action: "UPDATE_SONG",
      videoId: "nonexistent",
      title: "X",
    });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(404);
  });
});

describe("PlaylistParty: PUT action=DELETE_SONG", () => {
  it("removes a song from the playlist", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2"), song("v3")]);

    const req = makeRequest("PUT", { ownerHostId: "host-1", action: "DELETE_SONG", videoId: "v2" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(200);

    const getRes = await party.onRequest(makeRequest("GET"));
    const { body } = await parseResponse(getRes);
    const ids = (body.songs as EditableSong[]).map((s) => s.videoId);
    expect(ids).toEqual(["v1", "v3"]);
  });

  it("rejects delete of non-existent song", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("PUT", { ownerHostId: "host-1", action: "DELETE_SONG", videoId: "nope" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(404);
  });
});

describe("PlaylistParty: DELETE — delete playlist", () => {
  it("deletes the entire playlist", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("DELETE", { ownerHostId: "host-1" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(200);

    const getRes = await party.onRequest(makeRequest("GET"));
    expect((await parseResponse(getRes)).status).toBe(404);
  });

  it("rejects unauthorized delete", async () => {
    const room = makeRoom();
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1"), song("v2")]);

    const req = makeRequest("DELETE", { ownerHostId: "wrong-host" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(403);
  });
});

// T3 (docs/designs/full-page-focus-editor.md): closes T8, the standalone /playlists page's
// AI chat-to-diff editing. HTTP-shaped like RESOLVE_FROM_URL, not WebSocket-shaped like
// party/index.ts's handleProposeEdits — same underlying lib/ai-metadata.proposeEdits call.
describe("PlaylistParty: PUT PROPOSE_EDITS — AI chat-to-diff editing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the proposed diff without mutating the stored playlist", async () => {
    const room = makeRoom();
    room.env = { ANTHROPIC_API_KEY: "test-key" };
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1", 1999)]);

    const diff = [{ videoId: "v1", field: "year" as const, oldValue: 1999, newValue: 2000 }];
    vi.mocked(proposeEdits).mockResolvedValue(diff);

    const req = makeRequest("PUT", { ownerHostId: "host-1", action: "PROPOSE_EDITS", instruction: "fix the year" });
    const { status, body } = await parseResponse(await party.onRequest(req));

    expect(status).toBe(200);
    expect(body.diff).toEqual(diff);
    expect(proposeEdits).toHaveBeenCalledWith("fix the year", [song("v1", 1999)], "test-key");

    const stored = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect((stored.body.songs as EditableSong[])[0].year).toBe(1999); // unchanged
  });

  it("rejects a missing instruction", async () => {
    const room = makeRoom();
    room.env = { ANTHROPIC_API_KEY: "test-key" };
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1")]);

    const req = makeRequest("PUT", { ownerHostId: "host-1", action: "PROPOSE_EDITS", instruction: "  " });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("returns 503 when no Anthropic key is configured", async () => {
    const room = makeRoom(); // env: {} — no key
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1")]);

    const req = makeRequest("PUT", { ownerHostId: "host-1", action: "PROPOSE_EDITS", instruction: "fix it" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(503);
    expect(proposeEdits).not.toHaveBeenCalled();
  });

  it("rejects unauthorized requests", async () => {
    const room = makeRoom();
    room.env = { ANTHROPIC_API_KEY: "test-key" };
    const party = new PlaylistParty(room);
    await createPlaylist(party, [song("v1")]);

    const req = makeRequest("PUT", { ownerHostId: "wrong-host", action: "PROPOSE_EDITS", instruction: "fix it" });
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(403);
    expect(proposeEdits).not.toHaveBeenCalled();
  });
});

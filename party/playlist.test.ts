import { describe, it, expect, vi, beforeEach } from "vitest";
import PlaylistParty from "./playlist";
import type { EditableSong } from "../lib/game";

// ─── Mock PartyKit room ───────────────────────────────────────────────────────

function makeRoom(id = "test-playlist-id") {
  const store = new Map<string, unknown>();
  return {
    id,
    storage: {
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      put: vi.fn((key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); }),
      delete: vi.fn((key: string) => { store.delete(key); return Promise.resolve(); }),
      deleteAll: vi.fn(() => { store.clear(); return Promise.resolve(); }),
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

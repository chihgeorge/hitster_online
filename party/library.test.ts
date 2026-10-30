import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import LibraryParty from "./library";

// ─── Mock PartyKit room — same shape as party/playlist.test.ts's ──────────────

function makeRoom(id = "test-host-id") {
  const store = new Map<string, unknown>();
  return {
    id,
    storage: {
      get: vi.fn((key: string) => Promise.resolve(store.get(key))),
      put: vi.fn((key: string, val: unknown) => { store.set(key, val); return Promise.resolve(); }),
    },
    _store: store,
  } as unknown as import("./types").Room & { _store: Map<string, unknown> };
}

function makeRequest(method: string, body?: unknown, id = "test-host-id"): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  return {
    method,
    url: `http://localhost/parties/library/${id}`,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as Request;
}

async function parseResponse(res: Response) {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) };
}

describe("LibraryParty: GET — list entries", () => {
  it("returns an empty list for a host with no playlists yet", async () => {
    const party = new LibraryParty(makeRoom());
    const { status, body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(status).toBe(200);
    expect(body).toEqual({ entries: [] });
  });

  it("lists entries after an UPSERT", async () => {
    const party = new LibraryParty(makeRoom());
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "My Mix", songCount: 10 } }));
    const { body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(body.entries).toEqual([{ id: "p1", name: "My Mix", songCount: 10 }]);
  });

  it("hands out names older versions stored escaped as plain text", async () => {
    const room = makeRoom();
    room._store.set("entries", { p1: { id: "p1", name: "Rock &amp; Roll", songCount: 1 } });
    const { body } = await parseResponse(await new LibraryParty(room).onRequest(makeRequest("GET")));
    expect(body.entries[0].name).toBe("Rock & Roll");
  });
});

describe("LibraryParty: PUT UPSERT", () => {
  it("adds a new entry", async () => {
    const party = new LibraryParty(makeRoom());
    const { status } = await parseResponse(
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "Mix", songCount: 5 } }))
    );
    expect(status).toBe(200);
  });

  it("updates an existing entry in place (same id)", async () => {
    const party = new LibraryParty(makeRoom());
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "Old Name", songCount: 5 } }));
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "New Name", songCount: 8 } }));
    const { body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(body.entries).toEqual([{ id: "p1", name: "New Name", songCount: 8 }]);
  });

  it("rejects a malformed entry", async () => {
    const party = new LibraryParty(makeRoom());
    const { status, body } = await parseResponse(
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1" } }))
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/entry invalid/);
  });

  it("sanitizes the name (length cap)", async () => {
    const party = new LibraryParty(makeRoom());
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "x".repeat(200), songCount: 1 } }));
    const { body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(body.entries[0].name.length).toBeLessThanOrEqual(80);
  });

  it("rejects a new entry once the library is full (100 entries)", async () => {
    const party = new LibraryParty(makeRoom());
    for (let i = 0; i < 100; i++) {
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: `p${i}`, name: `Mix ${i}`, songCount: 1 } }));
    }
    const { status, body } = await parseResponse(
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p100", name: "One too many", songCount: 1 } }))
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/full/);
  });

  it("still allows updating an existing entry once the library is full", async () => {
    const party = new LibraryParty(makeRoom());
    for (let i = 0; i < 100; i++) {
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: `p${i}`, name: `Mix ${i}`, songCount: 1 } }));
    }
    const { status } = await parseResponse(
      await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p0", name: "Renamed", songCount: 2 } }))
    );
    expect(status).toBe(200);
  });
});

describe("LibraryParty: PUT REMOVE", () => {
  it("removes an entry by id", async () => {
    const party = new LibraryParty(makeRoom());
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "Mix", songCount: 5 } }));
    const { status } = await parseResponse(await party.onRequest(makeRequest("PUT", { action: "REMOVE", id: "p1" })));
    expect(status).toBe(200);
    const { body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(body.entries).toEqual([]);
  });

  it("is a no-op (not an error) when the id doesn't exist", async () => {
    const party = new LibraryParty(makeRoom());
    const { status } = await parseResponse(await party.onRequest(makeRequest("PUT", { action: "REMOVE", id: "nope" })));
    expect(status).toBe(200);
  });
});

describe("LibraryParty: misc", () => {
  it("rejects an unknown action", async () => {
    const party = new LibraryParty(makeRoom());
    const { status } = await parseResponse(await party.onRequest(makeRequest("PUT", { action: "WIPE" })));
    expect(status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const party = new LibraryParty(makeRoom());
    const req = { method: "PUT", url: "http://localhost/parties/library/x", headers: new Headers(), json: () => Promise.reject(new Error("bad")) } as unknown as Request;
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  // Value: protects=browser preflight lets the host page (another origin) PUT a save and send JSON; fails_when=shared CORS_HEADERS in party/http.ts drops PUT, Content-Type, or the * origin; why_new=preflight test only checked the 204 status; seam=none
  it("handles OPTIONS preflight", async () => {
    const party = new LibraryParty(makeRoom());
    const res = await party.onRequest(makeRequest("OPTIONS"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("rejects other methods", async () => {
    const party = new LibraryParty(makeRoom());
    const res = await party.onRequest(makeRequest("PATCH"));
    expect(res.status).toBe(405);
  });
});

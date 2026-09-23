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
  } as unknown as import("partykit/server").Room & { _store: Map<string, unknown> };
}

function makeRequest(method: string, body?: unknown, id = "test-host-id"): import("partykit/server").Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  return {
    method,
    url: `http://localhost/parties/library/${id}`,
    headers,
    json: () => Promise.resolve(body),
  } as unknown as import("partykit/server").Request;
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

describe("LibraryParty: PUT IMPORT (D2b migration)", () => {
  it("adds entries not already present, reports how many were added", async () => {
    const party = new LibraryParty(makeRoom());
    const { body } = await parseResponse(
      await party.onRequest(makeRequest("PUT", {
        action: "IMPORT",
        entries: [{ id: "p1", name: "A", songCount: 3 }, { id: "p2", name: "B", songCount: 4 }],
      }))
    );
    expect(body).toEqual({ ok: true, added: 2 });
  });

  it("is idempotent — never overwrites an entry already present", async () => {
    const party = new LibraryParty(makeRoom());
    await party.onRequest(makeRequest("PUT", { action: "UPSERT", entry: { id: "p1", name: "Live Name", songCount: 9 } }));
    await party.onRequest(makeRequest("PUT", {
      action: "IMPORT",
      entries: [{ id: "p1", name: "Stale Import Name", songCount: 1 }],
    }));
    const { body } = await parseResponse(await party.onRequest(makeRequest("GET")));
    expect(body.entries).toEqual([{ id: "p1", name: "Live Name", songCount: 9 }]);
  });

  it("skips malformed entries in the batch instead of failing the whole import", async () => {
    const party = new LibraryParty(makeRoom());
    const { body } = await parseResponse(
      await party.onRequest(makeRequest("PUT", {
        action: "IMPORT",
        entries: [{ id: "p1", name: "Good", songCount: 1 }, { bad: "entry" }],
      }))
    );
    expect(body).toEqual({ ok: true, added: 1 });
  });

  it("rejects a non-array entries field", async () => {
    const party = new LibraryParty(makeRoom());
    const { status } = await parseResponse(await party.onRequest(makeRequest("PUT", { action: "IMPORT", entries: "nope" })));
    expect(status).toBe(400);
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
    const req = { method: "PUT", url: "http://localhost/parties/library/x", headers: new Headers(), json: () => Promise.reject(new Error("bad")) } as unknown as import("partykit/server").Request;
    const { status } = await parseResponse(await party.onRequest(req));
    expect(status).toBe(400);
  });

  it("handles OPTIONS preflight", async () => {
    const party = new LibraryParty(makeRoom());
    const res = await party.onRequest(makeRequest("OPTIONS"));
    expect(res.status).toBe(204);
  });

  it("rejects other methods", async () => {
    const party = new LibraryParty(makeRoom());
    const res = await party.onRequest(makeRequest("PATCH"));
    expect(res.status).toBe(405);
  });
});

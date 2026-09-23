import { describe, it, expect, vi, beforeEach } from "vitest";
import { importLocalPlaylistsToLibrary } from "./playlist-library-migration";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
});

describe("importLocalPlaylistsToLibrary", () => {
  it("does nothing (no fetch call) when localStorage has no saved playlists", async () => {
    const added = await importLocalPlaylistsToLibrary("host-1", "localhost:1999");
    expect(added).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs an IMPORT action with the localStorage entries", async () => {
    localStorage.setItem("hitster_playlists", JSON.stringify([{ id: "p1", name: "Mix", songCount: 5 }]));
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, added: 1 }));

    const added = await importLocalPlaylistsToLibrary("host-1", "localhost:1999");

    expect(added).toBe(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/parties/library/host-1");
    expect(JSON.parse(init.body as string)).toEqual({
      action: "IMPORT",
      entries: [{ id: "p1", name: "Mix", songCount: 5 }],
    });
  });

  it("returns 0 and never throws when the request fails", async () => {
    localStorage.setItem("hitster_playlists", JSON.stringify([{ id: "p1", name: "Mix", songCount: 5 }]));
    mockFetch.mockRejectedValue(new Error("network down"));

    await expect(importLocalPlaylistsToLibrary("host-1", "localhost:1999")).resolves.toBe(0);
  });

  it("returns 0 when the server responds with an error status", async () => {
    localStorage.setItem("hitster_playlists", JSON.stringify([{ id: "p1", name: "Mix", songCount: 5 }]));
    mockFetch.mockResolvedValue(jsonResponse({ error: "boom" }, false, 500));

    expect(await importLocalPlaylistsToLibrary("host-1", "localhost:1999")).toBe(0);
  });

  it("ignores malformed entries in localStorage instead of throwing", async () => {
    localStorage.setItem("hitster_playlists", JSON.stringify("not an array"));
    const added = await importLocalPlaylistsToLibrary("host-1", "localhost:1999");
    expect(added).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("filters out individually malformed entries but still sends the valid ones", async () => {
    localStorage.setItem(
      "hitster_playlists",
      JSON.stringify([{ id: "p1", name: "Good", songCount: 3 }, { bad: "entry" }])
    );
    mockFetch.mockResolvedValue(jsonResponse({ ok: true, added: 1 }));

    await importLocalPlaylistsToLibrary("host-1", "localhost:1999");

    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body as string).entries).toEqual([{ id: "p1", name: "Good", songCount: 3 }]);
  });
});

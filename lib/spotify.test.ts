import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub global fetch before any module import so the module captures the stub.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── helpers ─────────────────────────────────────────────────────────────────

function tokenRes() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
  });
}

function searchRes(items: { album_type: string; release_date: string }[]) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        tracks: {
          items: items.map((i) => ({ album: i })),
        },
      }),
  });
}

function errorRes(status: number) {
  return Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) });
}

// ─── lookupReleaseYear ────────────────────────────────────────────────────────

// Use dynamic import + vi.resetModules() per test so the module-level
// `cachedToken` state is reset — otherwise token caching bleeds between tests.

describe("lookupReleaseYear", () => {
  let lookupReleaseYear: (artist: string, track: string) => Promise<number | null>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.SPOTIFY_CLIENT_ID = "cid";
    process.env.SPOTIFY_CLIENT_SECRET = "csecret";
    const mod = await import("./spotify");
    lookupReleaseYear = mod.lookupReleaseYear;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns release year on a matching artist+track search", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() =>
        searchRes([{ album_type: "album", release_date: "1985-06-01" }])
      );

    expect(await lookupReleaseYear("Frank Mills", "Music Box Dancer")).toBe(1985);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("prefers single/album items over compilation", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() =>
        searchRes([
          { album_type: "compilation", release_date: "2000-01-01" },
          { album_type: "album", release_date: "1985-06-01" },
        ])
      );

    expect(await lookupReleaseYear("Artist", "Track")).toBe(1985);
  });

  it("falls back to first item when all are compilations", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() =>
        searchRes([{ album_type: "compilation", release_date: "2000-01-01" }])
      );

    expect(await lookupReleaseYear("Artist", "Track")).toBe(2000);
  });

  it("falls back to track-only search when artist+track returns no items", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() => searchRes([]))
      .mockImplementationOnce(() =>
        searchRes([{ album_type: "single", release_date: "1990-03-15" }])
      );

    expect(await lookupReleaseYear("Artist", "Track")).toBe(1990);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("returns null when both searches return no items", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() => searchRes([]))
      .mockImplementationOnce(() => searchRes([]));

    expect(await lookupReleaseYear("Artist", "Track")).toBeNull();
  });

  it("returns null when search responds with non-ok status (not 429)", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() => errorRes(500))
      .mockImplementationOnce(() => errorRes(500));

    expect(await lookupReleaseYear("Artist", "Track")).toBeNull();
  });

  it("throws RATE_LIMITED when search responds with 429", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() => errorRes(429));

    await expect(lookupReleaseYear("Artist", "Track")).rejects.toThrow("RATE_LIMITED");
  });

  it("throws when SPOTIFY_CLIENT_ID is not set", async () => {
    delete process.env.SPOTIFY_CLIENT_ID;
    await expect(lookupReleaseYear("Artist", "Track")).rejects.toThrow();
  });

  it("throws when SPOTIFY_CLIENT_SECRET is not set", async () => {
    delete process.env.SPOTIFY_CLIENT_SECRET;
    await expect(lookupReleaseYear("Artist", "Track")).rejects.toThrow();
  });

  it("returns null when release_date year portion is non-numeric", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      // first search: returns an item but release_date is non-numeric → searchSpotify returns null
      .mockImplementationOnce(() =>
        searchRes([{ album_type: "album", release_date: "unknown" }])
      )
      // fallback search: no items → null
      .mockImplementationOnce(() => searchRes([]));

    // parseInt("unkn", 10) → NaN → null from both paths
    expect(await lookupReleaseYear("Artist", "Track")).toBeNull();
  });

  it("handles release_date with only year (YYYY format)", async () => {
    mockFetch
      .mockImplementationOnce(() => tokenRes())
      .mockImplementationOnce(() =>
        searchRes([{ album_type: "album", release_date: "1975" }])
      );

    expect(await lookupReleaseYear("Artist", "Track")).toBe(1975);
  });
});

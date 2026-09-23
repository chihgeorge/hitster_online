import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Storage as PartyStorage } from "partykit/server";
import {
  fetchAndFilterTracks,
  resolveAIWithCache,
  resolvePlaylistFromUrl,
  buildCardsFromAI,
  parseTrackMetas,
  storageBatchGet,
  type TrackItem,
} from "./playlist-resolver";

vi.mock("./youtube", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    fetchPlaylistItems: vi.fn(),
    fetchEmbeddableVideoIds: vi.fn().mockImplementation((ids: string[]) => Promise.resolve(new Set(ids))),
  };
});
vi.mock("./ai-metadata", () => ({
  resolveTracksWithAI: vi.fn().mockResolvedValue(new Map()),
}));

import { fetchPlaylistItems, fetchEmbeddableVideoIds } from "./youtube";
import { resolveTracksWithAI } from "./ai-metadata";

function fakeTrack(videoId: string, title = "Song", channelTitle = "Artist"): TrackItem {
  return { videoId, title, description: "", channelTitle };
}

/** Minimal in-memory Storage — same {get, put} shape party/index.test.ts's makeRoom() mocks. */
function fakeStorage(): PartyStorage {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(async (keys: unknown) => {
      if (Array.isArray(keys)) {
        const result = new Map<string, unknown>();
        for (const k of keys) if (data.has(k)) result.set(k, data.get(k));
        return result;
      }
      return data.get(keys as string);
    }),
    put: vi.fn(async (values: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(values)) data.set(k, v);
    }),
  } as unknown as PartyStorage;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchEmbeddableVideoIds).mockImplementation((ids: string[]) => Promise.resolve(new Set(ids)));
});

describe("fetchAndFilterTracks", () => {
  it("filters out non-embeddable videos", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1"), fakeTrack("v2"), fakeTrack("v3")]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1", "v3"]));

    const { tracks, skippedEmbeddingCount } = await fetchAndFilterTracks("PLtest", "yt-key");
    expect(tracks.map((t) => t.videoId)).toEqual(["v1", "v3"]);
    expect(skippedEmbeddingCount).toBe(1);
  });

  it("reports zero skipped when everything is embeddable", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1"), fakeTrack("v2")]);
    const { tracks, skippedEmbeddingCount } = await fetchAndFilterTracks("PLtest", "yt-key");
    expect(tracks).toHaveLength(2);
    expect(skippedEmbeddingCount).toBe(0);
  });
});

describe("resolveAIWithCache", () => {
  it("resolves fresh AI metadata and caches it under aiMeta:<videoId>", async () => {
    vi.mocked(resolveTracksWithAI).mockResolvedValue(
      new Map([["v1", { title: "Clean Title", artist: "Clean Artist", year: 1999 }]])
    );
    const storage = fakeStorage();
    const result = await resolveAIWithCache(storage, [fakeTrack("v1")], "anthropic-key");

    expect(result.get("v1")).toEqual({ title: "Clean Title", artist: "Clean Artist", year: 1999 });
    expect(storage.put).toHaveBeenCalledWith({ "aiMeta:v1": { title: "Clean Title", artist: "Clean Artist", year: 1999 } });
  });

  it("uses cached AI metadata instead of re-calling resolveTracksWithAI", async () => {
    const storage = fakeStorage();
    await storage.put({ "aiMeta:v1": { title: "Cached", artist: "Cached Artist", year: 2000 } });

    const result = await resolveAIWithCache(storage, [fakeTrack("v1")], "anthropic-key");
    expect(result.get("v1")).toEqual({ title: "Cached", artist: "Cached Artist", year: 2000 });
    expect(resolveTracksWithAI).not.toHaveBeenCalled();
  });

  it("fires onBatchDone with cached + fresh results merged", async () => {
    vi.mocked(resolveTracksWithAI).mockImplementation(async (tracks, key, onBatchDone) => {
      const fresh = new Map([["v2", { title: "Fresh", artist: "Fresh Artist", year: 2020 }]]);
      onBatchDone?.(fresh);
      return fresh;
    });
    const storage = fakeStorage();
    await storage.put({ "aiMeta:v1": { title: "Cached", artist: "Cached Artist", year: 2000 } });

    const seen: string[][] = [];
    await resolveAIWithCache(storage, [fakeTrack("v1"), fakeTrack("v2")], "anthropic-key", (accumulated) => {
      seen.push([...accumulated.keys()]);
    });
    expect(seen).toEqual([["v1", "v2"]]);
  });
});

describe("buildCardsFromAI", () => {
  it("prefers description year, then title year, then AI year", () => {
    const tracks = [fakeTrack("v1"), fakeTrack("v2"), fakeTrack("v3")];
    const metas = [
      { artist: "A", descYear: 1990, titleYear: 1991 },
      { artist: "B", descYear: null, titleYear: 1985 },
      { artist: "C", descYear: null, titleYear: null },
    ];
    const aiResults = new Map([["v3", { title: "AI Title", artist: "AI Artist", year: 2001 }]]);

    const { diagnostics } = buildCardsFromAI(tracks, metas, aiResults);
    expect(diagnostics.map((d) => [d.year, d.yearSource])).toEqual([
      [1990, "description"],
      [1985, "title"],
      [2001, "ai"],
    ]);
  });

  it("omits a song from the playable deck (but not diagnostics) when no year is resolvable", () => {
    const tracks = [fakeTrack("v1")];
    const metas = [{ artist: "A", descYear: null, titleYear: null }];
    const { songs, allSongs, diagnostics } = buildCardsFromAI(tracks, metas, new Map());
    expect(songs).toHaveLength(0);
    expect(allSongs).toHaveLength(1);
    expect(diagnostics[0].yearSource).toBeNull();
  });
});

describe("resolvePlaylistFromUrl", () => {
  it("runs the full pipeline: fetch, filter, resolve AI, build cards", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1"), fakeTrack("v2")]);
    vi.mocked(fetchEmbeddableVideoIds).mockResolvedValue(new Set(["v1"])); // v2 filtered out
    vi.mocked(resolveTracksWithAI).mockResolvedValue(new Map([["v1", { title: "T", artist: "A", year: 2010 }]]));

    const result = await resolvePlaylistFromUrl("PLtest", { youtubeKey: "yt", anthropicKey: "ai" }, fakeStorage());
    expect(result.tracks.map((t) => t.videoId)).toEqual(["v1"]);
    expect(result.skippedEmbeddingCount).toBe(1);
    expect(result.allSongs).toEqual([{ videoId: "v1", title: "T", artist: "A", year: 2010 }]);
  });

  it("fires onFetched before AI resolution, then onAIBatch during it", async () => {
    vi.mocked(fetchPlaylistItems).mockResolvedValue([fakeTrack("v1")]);
    vi.mocked(resolveTracksWithAI).mockImplementation(async (tracks, key, onBatchDone) => {
      onBatchDone?.(new Map([["v1", { title: "T", artist: "A", year: 2010 }]]));
      return new Map([["v1", { title: "T", artist: "A", year: 2010 }]]);
    });

    const order: string[] = [];
    await resolvePlaylistFromUrl(
      "PLtest",
      { youtubeKey: "yt", anthropicKey: "ai" },
      fakeStorage(),
      () => order.push("fetched"),
      () => order.push("aiBatch")
    );
    expect(order).toEqual(["fetched", "aiBatch"]);
  });
});

describe("parseTrackMetas / storageBatchGet", () => {
  it("parseTrackMetas falls back to channel-derived artist with no description or title match", () => {
    const [meta] = parseTrackMetas([fakeTrack("v1", "Some Song", "SomeArtist - Topic")]);
    expect(meta.artist).toBe("SomeArtist");
  });

  it("storageBatchGet batches requests over 128 keys and merges results", async () => {
    const storage = fakeStorage();
    const entries: Record<string, string> = {};
    for (let i = 0; i < 150; i++) entries[`k${i}`] = `v${i}`;
    await storage.put(entries);

    const result = await storageBatchGet<string>(storage, Object.keys(entries));
    expect(result.size).toBe(150);
    expect(result.get("k149")).toBe("v149");
  });
});

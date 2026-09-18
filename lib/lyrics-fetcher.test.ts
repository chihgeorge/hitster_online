import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchLyrics, fetchLyricsBatch } from "./lyrics-fetcher";

// Mock fetch so tests don't hit the network
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const LONG_LYRICS = "Today is gonna be the day that they're gonna throw it back to you\nAnd by now, you should've somehow realised what you gotta do\nI don't believe that anybody feels the way I do about you now\nBackbeat, the word was on the street that the fire in your heart is out";

function lrclibTrack(overrides: Partial<{
  trackName: string; artistName: string; plainLyrics: string | null;
}> = {}) {
  return {
    id: 1,
    trackName: overrides.trackName ?? "Wonderwall",
    artistName: overrides.artistName ?? "Oasis",
    albumName: "(What's the Story) Morning Glory?",
    plainLyrics: overrides.plainLyrics !== undefined ? overrides.plainLyrics : LONG_LYRICS,
    syncedLyrics: null,
  };
}

function mockResponse(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchLyrics", () => {
  it("returns lyrics on direct get hit", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(lrclibTrack({ plainLyrics: "Today is gonna be the day\nThat they're gonna throw it back to you\nAnd by now, you should've somehow realised what you gotta do" }))
    );

    const result = await fetchLyrics("Wonderwall", "Oasis");
    expect(result).toContain("gonna be the day");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to search when get returns non-ok", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({}, false))  // get fails
      .mockResolvedValueOnce(mockResponse([lrclibTrack()]));  // search succeeds with default long lyrics

    const result = await fetchLyrics("Wonderwall", "Oasis");
    expect(result).toContain("gonna be the day");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null when no search results match", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({}, false))
      .mockResolvedValueOnce(mockResponse([]));

    const result = await fetchLyrics("Unknown Song 12345", "Nobody");
    expect(result).toBeNull();
  });

  it("returns null when lyrics are too short (instrumentals)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(lrclibTrack({ plainLyrics: "La la la" }))
    );

    const result = await fetchLyrics("Short Song", "Artist");
    expect(result).toBeNull();
  });

  it("returns null when plainLyrics is null", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse(lrclibTrack({ plainLyrics: null }))
    );

    const result = await fetchLyrics("Instrumental", "Artist");
    expect(result).toBeNull();
  });

  it("falls back to search when get times out", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    mockFetch
      .mockRejectedValueOnce(abortError)  // get timeout
      .mockResolvedValueOnce(mockResponse([]));  // search returns empty

    const result = await fetchLyrics("Wonderwall", "Oasis");
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("prefers higher-scoring match in search results", async () => {
    const exactMatch = lrclibTrack({
      trackName: "Wonderwall",
      artistName: "Oasis",
      // LONG_LYRICS default — contains "should've"
    });
    const poorMatch = lrclibTrack({
      trackName: "Wonderwall (Cover)",
      artistName: "Unknown Cover Band",
      plainLyrics: "Today is gonna be the day that they're gonna throw it back to you and by now you should know something something something something something something extra words here",
    });

    mockFetch
      .mockResolvedValueOnce(mockResponse({}, false))
      .mockResolvedValueOnce(mockResponse([poorMatch, exactMatch]));

    const result = await fetchLyrics("Wonderwall", "Oasis");
    expect(result).toContain("should've somehow realised");
  });
});

describe("fetchLyricsBatch", () => {
  it("returns a map of videoId → lyrics for hits", async () => {
    mockFetch.mockResolvedValue(mockResponse(lrclibTrack()));  // default LONG_LYRICS

    const tracks = [
      { videoId: "v1", title: "Wonderwall", artist: "Oasis" },
      { videoId: "v2", title: "Let It Be", artist: "The Beatles" },
    ];

    const result = await fetchLyricsBatch(tracks);
    expect(result.size).toBe(2);
    expect(result.get("v1")).toContain("Backbeat");
    expect(result.get("v2")).toContain("Backbeat");
  });

  it("excludes misses from the result map", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse(lrclibTrack()))   // v1 — long lyrics hit
      .mockResolvedValueOnce(mockResponse(lrclibTrack({ plainLyrics: null })));  // v2 — null

    const tracks = [
      { videoId: "v1", title: "Wonderwall", artist: "Oasis" },
      { videoId: "v2", title: "Instrumental", artist: "Artist" },
    ];

    const result = await fetchLyricsBatch(tracks);
    expect(result.has("v1")).toBe(true);
    expect(result.has("v2")).toBe(false);
  });

  it("returns empty map for empty input", async () => {
    const result = await fetchLyricsBatch([]);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

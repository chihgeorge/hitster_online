import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPopularitySummaries } from "./lyrics-popularity";

// Mock fetch so tests don't hit the network — same pattern as lyrics-fetcher.test.ts
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, text: () => Promise.resolve("error"), json: () => Promise.resolve(body) } as Response;
}

// Mirrors the real shape: a narration text block, then the real answer after tool use.
function anthropicResponse(summary: string) {
  return mockResponse({
    content: [
      { type: "text", text: "I'll search for this song's most quoted line." },
      { type: "server_tool_use", name: "web_search" },
      { type: "web_search_tool_result" },
      { type: "text", text: `{"summary":"${summary}"}` },
    ],
  });
}

const TRACKS = [
  { videoId: "v1", title: "Song A", artist: "Artist A" },
  { videoId: "v2", title: "Song B", artist: "Artist B" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchPopularitySummaries", () => {
  it("returns a summary per track, keyed by videoId", async () => {
    mockFetch
      .mockResolvedValueOnce(anthropicResponse("最有名的一句是 A"))
      .mockResolvedValueOnce(anthropicResponse("最有名的一句是 B"));

    const result = await fetchPopularitySummaries(TRACKS, "test-key");

    expect(result.get("v1")).toBe("最有名的一句是 A");
    expect(result.get("v2")).toBe("最有名的一句是 B");
  });

  it("takes the LAST text block, not the model's search narration", async () => {
    // Regression: content[0] is "I'll search for..." — parsing that as JSON fails.
    mockFetch.mockResolvedValueOnce(anthropicResponse("real answer"));
    const result = await fetchPopularitySummaries([TRACKS[0]], "test-key");
    expect(result.get("v1")).toBe("real answer");
  });

  it("omits a song when the model found nothing (empty summary)", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(""));
    const result = await fetchPopularitySummaries([TRACKS[0]], "test-key");
    expect(result.has("v1")).toBe(false);
  });

  it("fails open per-song on API error — other songs still resolve", async () => {
    mockFetch
      .mockResolvedValueOnce(mockResponse({}, false))
      .mockResolvedValueOnce(anthropicResponse("ok"));

    const result = await fetchPopularitySummaries(TRACKS, "test-key");
    expect(result.has("v1")).toBe(false);
    expect(result.get("v2")).toBe("ok");
  });

  it("fails open on malformed JSON in the response", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ content: [{ type: "text", text: "not json at all" }] })
    );
    const result = await fetchPopularitySummaries([TRACKS[0]], "test-key");
    expect(result.has("v1")).toBe(false);
  });

  it("returns empty map with no API key or no tracks", async () => {
    expect((await fetchPopularitySummaries(TRACKS, "")).size).toBe(0);
    expect((await fetchPopularitySummaries([], "test-key")).size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends the web_search tool and no other tools", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("x"));
    await fetchPopularitySummaries([TRACKS[0]], "test-key");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveLyricsForTracks, detectLanguageHint } from "./lyrics-resolver";

// Mock fetch (used for both lrclib.net and Anthropic API calls)
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LONG_LYRICS =
  "Today is gonna be the day that they're gonna throw it back to you\n" +
  "And by now, you should've somehow realised what you gotta do\n" +
  "I don't believe that anybody feels the way I do about you now\n" +
  "Backbeat, the word was on the street that the fire in your heart is out";

function lrclibGetResponse(plainLyrics: string | null = LONG_LYRICS) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        id: 1,
        trackName: "Wonderwall",
        artistName: "Oasis",
        albumName: "Morning Glory",
        plainLyrics,
        syncedLyrics: null,
      }),
  } as Response;
}

function anthropicResponse(items: object[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(items) }],
      }),
  } as Response;
}

function anthropicError(status = 500) {
  return { ok: false, status, json: () => Promise.resolve({}) } as Response;
}

const TRACK = { videoId: "v1", title: "Wonderwall", artist: "Oasis", year: 1995 };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// detectLanguageHint
// ---------------------------------------------------------------------------

describe("detectLanguageHint", () => {
  it("returns Japanese for hiragana", () => {
    expect(detectLanguageHint("桜", "あいみょん")).toContain("Japanese");
  });
  it("returns Korean for hangul", () => {
    expect(detectLanguageHint("봄날", "BTS")).toContain("Korean");
  });
  it("returns Chinese for CJK", () => {
    expect(detectLanguageHint("九十九朵玫瑰", "丘丘合唱團")).toContain("Chinese");
  });
  it("returns English for ASCII", () => {
    expect(detectLanguageHint("Wonderwall", "Oasis")).toBe("English");
  });
});

// ---------------------------------------------------------------------------
// resolveLyricsForTracks — guard clauses
// ---------------------------------------------------------------------------

describe("resolveLyricsForTracks — guard clauses", () => {
  it("returns empty map when tracks is empty", async () => {
    const result = await resolveLyricsForTracks([], "key");
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty map when apiKey is empty string", async () => {
    const result = await resolveLyricsForTracks([TRACK], "");
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveLyricsForTracks — integration: lrclib hit path
// ---------------------------------------------------------------------------

describe("resolveLyricsForTracks — lrclib hit grounding", () => {
  it("fetches lrclib lyrics first, then passes them to Anthropic", async () => {
    // lrclib get call → returns long lyrics
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    // Anthropic call → returns parsed result
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        {
          v: "v1",
          language: "en",
          lyricContext: "I don't believe that ___\nBackbeat on the street",
          blankSentence: "anybody feels the way I do",
          acceptableVariants: [],
        },
      ])
    );

    const result = await resolveLyricsForTracks([TRACK], "test-api-key");

    expect(result.size).toBe(1);
    const item = result.get("v1")!;
    expect(item.blankSentence).toBe("anybody feels the way I do");
    expect(item.language).toBe("en");

    // Verify the Anthropic call body includes the real lyrics text
    const anthropicCall = mockFetch.mock.calls[1];
    const body = JSON.parse(anthropicCall[1].body as string);
    expect(body.messages[0].content).toContain("LYRICS:");
    expect(body.messages[0].content).toContain("Backbeat");
  });

  it("truncates lyrics longer than 1500 chars before sending to Anthropic", async () => {
    const longLyrics = "A".repeat(2000);
    mockFetch.mockResolvedValueOnce(lrclibGetResponse(longLyrics));
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        {
          v: "v1",
          language: "en",
          lyricContext: "A ___",
          blankSentence: "something",
          acceptableVariants: [],
        },
      ])
    );

    await resolveLyricsForTracks([TRACK], "key");

    const anthropicCall = mockFetch.mock.calls[1];
    const body = JSON.parse(anthropicCall[1].body as string);
    // Truncated: 1500 chars of "A" + "\n[…]" marker
    expect(body.messages[0].content).toContain("[…]");
    expect(body.messages[0].content).not.toContain("A".repeat(1600));
  });
});

// ---------------------------------------------------------------------------
// resolveLyricsForTracks — integration: lrclib miss path
// ---------------------------------------------------------------------------

describe("resolveLyricsForTracks — lrclib miss fallback", () => {
  it("sends NO_LYRICS marker when lrclib returns nothing", async () => {
    // lrclib get → non-ok, search → empty
    mockFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as Response);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);
    // Anthropic call
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        {
          v: "v1",
          language: "en",
          lyricContext: "Backbeat ___",
          blankSentence: "some phrase",
          acceptableVariants: [],
        },
      ])
    );

    await resolveLyricsForTracks([TRACK], "key");

    const anthropicCall = mockFetch.mock.calls[2];
    const body = JSON.parse(anthropicCall[1].body as string);
    expect(body.messages[0].content).toContain("NO_LYRICS");
  });

  it("excludes items with empty blankSentence (model low-confidence signal)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({}) } as Response);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "en", lyricContext: "___", blankSentence: "", acceptableVariants: [] }])
    );

    const result = await resolveLyricsForTracks([TRACK], "key");
    expect(result.size).toBe(0);
  });

  it("repairs a lyricContext missing ___ by blanking the answer, and drops one that lacks the answer", async () => {
    const miss = { ok: false, json: () => Promise.resolve({}) } as Response;
    const empty = { ok: true, json: () => Promise.resolve([]) } as Response;
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        { v: "v1", language: "en", lyricContext: "line one\nthe chorus phrase here", blankSentence: "chorus phrase", acceptableVariants: [] },
        { v: "v2", language: "en", lyricContext: "no answer in here", blankSentence: "chorus phrase", acceptableVariants: [] },
      ])
    );

    const result = await resolveLyricsForTracks([TRACK, { ...TRACK, videoId: "v2" }], "key");
    expect(result.get("v1")?.lyricContext).toBe("line one\nthe ______ ______ here");
    expect(result.has("v2")).toBe(false);
  });

  it("sizes the blank to the answer length", async () => {
    const miss = { ok: false, json: () => Promise.resolve({}) } as Response;
    const empty = { ok: true, json: () => Promise.resolve([]) } as Response;
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "zh-TW", lyricContext: "那些年___\n那些年錯過的愛情", blankSentence: "錯過的大雨", acceptableVariants: [] }])
    );
    const result = await resolveLyricsForTracks([TRACK], "key");
    expect(result.get("v1")?.lyricContext).toBe("那些年_____\n那些年錯過的愛情");
  });

  it("drops zh-TW questions containing Simplified characters and ignores punctuation when sizing the blank", async () => {
    const miss = { ok: false, json: () => Promise.resolve({}) } as Response;
    const empty = { ok: true, json: () => Promise.resolve([]) } as Response;
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        { v: "v1", language: "zh-TW", lyricContext: "又回到最初的起点\n那些年___", blankSentence: "错过的大雨", acceptableVariants: [] },
        { v: "v2", language: "zh-TW", lyricContext: "那些年___", blankSentence: "錯過的大雨！", acceptableVariants: [] },
      ])
    );
    const result = await resolveLyricsForTracks([TRACK, { ...TRACK, videoId: "v2" }], "key");
    expect(result.has("v1")).toBe(false);
    expect(result.get("v2")?.lyricContext).toBe("那些年_____");
  });

  it("drops CJK questions whose blank is not 2-6 characters, but not English ones", async () => {
    const aiReply = anthropicResponse([
        { v: "v1", language: "zh-TW", lyricContext: "那些年___", blankSentence: "錯過的大雨啊啊", acceptableVariants: [] }, // 7
        { v: "v2", language: "zh-TW", lyricContext: "那些年___", blankSentence: "愛", acceptableVariants: [] }, // 1
        { v: "v3", language: "zh-TW", lyricContext: "那些年___", blankSentence: "錯過的大雨", acceptableVariants: [] }, // 5
        { v: "v4", language: "en", lyricContext: "I want to ___", blankSentence: "remember everything", acceptableVariants: [] },
      ]);
    // lrclib lookups (parallel) all miss; only the Anthropic call returns content.
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(String(url).includes("anthropic") ? aiReply : ({ ok: false, json: () => Promise.resolve({}) } as Response))
    );
    const tracks = ["v1", "v2", "v3", "v4"].map((videoId) => ({ ...TRACK, videoId }));
    const result = await resolveLyricsForTracks(tracks, "key");
    expect([...result.keys()].sort()).toEqual(["v3", "v4"]);
    mockFetch.mockReset(); // drop the URL-based implementation so it cannot leak into later tests
  });

  it("collapses adjacent ___ placeholders into one answer-sized blank", async () => {
    const miss = { ok: false, json: () => Promise.resolve({}) } as Response;
    const empty = { ok: true, json: () => Promise.resolve([]) } as Response;
    mockFetch.mockResolvedValueOnce(miss).mockResolvedValueOnce(empty);
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "zh-TW", lyricContext: "繼續讓我 ___ ___ 陪你老", blankSentence: "多一點 愛", acceptableVariants: [] }])
    );
    const result = await resolveLyricsForTracks([TRACK], "key");
    expect(result.get("v1")?.lyricContext).toBe("繼續讓我 ___ _ 陪你老");
  });
});

// ---------------------------------------------------------------------------
// resolveLyricsForTracks — Anthropic API error handling
// ---------------------------------------------------------------------------

describe("resolveLyricsForTracks — Anthropic error handling", () => {
  it("returns empty map when Anthropic returns non-ok", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(anthropicError(500));

    const result = await resolveLyricsForTracks([TRACK], "key");
    expect(result.size).toBe(0);
  });

  it("calls onBatchDone callback after each fulfilled AI batch", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        {
          v: "v1",
          language: "en",
          lyricContext: "Today ___",
          blankSentence: "is gonna be the day",
          acceptableVariants: [],
        },
      ])
    );

    const onBatchDone = vi.fn();
    const result = await resolveLyricsForTracks([TRACK], "key", onBatchDone);

    expect(onBatchDone).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
  });
});

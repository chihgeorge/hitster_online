import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveLyricsForTracks, detectLanguageHint, givesAwayTitle } from "./lyrics-resolver";

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
        content: [{ type: "text", text: JSON.stringify({ items }) }],
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

  it("drops a round whose answer is the song title (players see the title)", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "en", lyricContext: "And after all\nYou're my ___", blankSentence: "WonderWall", acceptableVariants: [] }])
    );
    const result = await resolveLyricsForTracks([TRACK], "key");
    expect(result.has("v1")).toBe(false);
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

// docs/designs/lyrics-question-search-grounding.md — the popularitySummaries param
describe("popularity grounding (search-based blank selection)", () => {
  it("includes a POPULARITY line in the prompt when a summary is provided for the track", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([
        { v: "v1", language: "en", lyricContext: "I don't believe that ___\nBackbeat", blankSentence: "anybody feels", acceptableVariants: [] },
      ])
    );

    const summaries = new Map([["v1", "This exact line is cited as the song's most quoted moment."]]);
    await resolveLyricsForTracks([TRACK], "key", undefined, undefined, summaries);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.messages[0].content).toContain("POPULARITY: This exact line is cited");
  });

  it("omits the POPULARITY line for a track with no summary — falls back to today's prompt", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "en", lyricContext: "x ___", blankSentence: "y", acceptableVariants: [] }])
    );

    // Empty summaries map (the default) — same as not passing the param at all.
    await resolveLyricsForTracks([TRACK], "key");

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.messages[0].content).not.toContain("POPULARITY:");
  });

  it("never sends a tools param — the generation call has no search access (Approach C's core property)", async () => {
    mockFetch.mockResolvedValueOnce(lrclibGetResponse());
    mockFetch.mockResolvedValueOnce(
      anthropicResponse([{ v: "v1", language: "en", lyricContext: "x ___", blankSentence: "y", acceptableVariants: [] }])
    );

    const summaries = new Map([["v1", "some popularity signal"]]);
    await resolveLyricsForTracks([TRACK], "key", undefined, undefined, summaries);

    const body = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body.tools).toBeUndefined();
  });

  it("uses structured outputs; adaptive thinking at low effort only on the game model", async () => {
    const reply = [{ v: "v1", language: "en", lyricContext: "x ___", blankSentence: "y", acceptableVariants: [] }];
    mockFetch.mockResolvedValueOnce(lrclibGetResponse()).mockResolvedValueOnce(anthropicResponse(reply));
    await resolveLyricsForTracks([TRACK], "key", undefined, "claude-sonnet-5");
    const game = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(game.output_config.format.type).toBe("json_schema");
    expect(game.output_config.effort).toBe("low");
    expect(game.thinking).toEqual({ type: "adaptive" });

    mockFetch.mockResolvedValueOnce(lrclibGetResponse()).mockResolvedValueOnce(anthropicResponse(reply));
    await resolveLyricsForTracks([TRACK], "key");
    const bulk = JSON.parse(mockFetch.mock.calls[3][1].body as string);
    expect(bulk.output_config).toEqual({ format: game.output_config.format });
    expect(bulk.thinking).toBeUndefined();
  });
});

// Structured-outputs parse paths and the title-giveaway guard.
describe("structured outputs parsing + title guard", () => {
  const miss = () => ({ ok: false, json: () => Promise.resolve({}) }) as Response;
  function rawAnthropic(content: object[]) {
    return { ok: true, json: () => Promise.resolve({ content }) } as Response;
  }
  // lrclib misses for every lookup; only the Anthropic call returns `reply`.
  function routeFetch(reply: Response) {
    mockFetch.mockImplementation((url: string) => Promise.resolve(String(url).includes("anthropic") ? reply : miss()));
  }
  afterEach(() => mockFetch.mockReset());

  it("sends a timeout signal, and a timed-out call just yields no rounds", async () => {
    mockFetch.mockImplementation((url: string) => String(url).includes("anthropic")
      ? Promise.reject(new DOMException("timed out", "TimeoutError"))
      : Promise.resolve(miss()));
    const result = await resolveLyricsForTracks([TRACK], "key", undefined, "claude-sonnet-5");
    expect(result.size).toBe(0);
    const call = mockFetch.mock.calls.find(([url]) => String(url).includes("anthropic"))!;
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("times out thinking (game) calls at 120s and Haiku calls at 30s", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    routeFetch(anthropicResponse([]));
    await resolveLyricsForTracks([TRACK], "key", undefined, "claude-sonnet-5");
    await resolveLyricsForTracks([TRACK], "key");
    // lrclib's own 4s timeouts are filtered out; order is game call, then bulk call.
    expect(spy.mock.calls.map(([ms]) => ms).filter((ms) => ms !== 4000)).toEqual([120_000, 30_000]);
    spy.mockRestore();
  });

  it("logs a non-end_turn stop_reason (truncated batch) but not end_turn", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const withStop = (stop_reason: string) =>
      ({ ok: true, json: () => Promise.resolve({ stop_reason, content: [{ type: "text", text: '{"items":[' }] }) }) as Response;
    routeFetch(withStop("max_tokens"));
    expect((await resolveLyricsForTracks([TRACK], "key", undefined, "claude-sonnet-5")).size).toBe(0);
    expect(err).toHaveBeenCalledWith("[lyrics-resolver] claude-sonnet-5 stopped with max_tokens");
    err.mockClear();
    routeFetch({ ok: true, json: () => Promise.resolve({ stop_reason: "end_turn", content: [{ type: "text", text: '{"items":[]}' }] }) } as Response);
    await resolveLyricsForTracks([TRACK], "key");
    expect(err.mock.calls.some(([m]) => String(m).includes("stopped with"))).toBe(false);
    err.mockRestore();
  });

  it("fails open on malformed JSON, missing items, non-array items, and a thinking-only response", async () => {
    const replies = [
      rawAnthropic([{ type: "text", text: "not json" }]),
      rawAnthropic([{ type: "text", text: "{}" }]),
      rawAnthropic([{ type: "text", text: '{"items":{"v":"v1"}}' }]),
      rawAnthropic([{ type: "thinking", thinking: "..." }]), // e.g. thinking ate max_tokens
    ];
    for (const reply of replies) {
      routeFetch(reply);
      expect((await resolveLyricsForTracks([TRACK], "key")).size).toBe(0);
    }
  });

  it("sizes max_tokens per model (thinking needs headroom) and sends the {items} schema root", async () => {
    routeFetch(anthropicResponse([]));
    await resolveLyricsForTracks([TRACK], "key", undefined, "claude-sonnet-5");
    await resolveLyricsForTracks([TRACK], "key");
    const [game, bulk] = mockFetch.mock.calls
      .filter(([url]) => String(url).includes("anthropic"))
      .map((c) => JSON.parse(c[1].body as string));
    expect(game.max_tokens).toBe(16000);
    expect(bulk.max_tokens).toBe(4000);
    expect(bulk.output_config.format.schema.required).toEqual(["items"]);
  });

  const round = (v: string, blankSentence: string, language = "en") => ({
    v, language, lyricContext: "line ___", blankSentence, acceptableVariants: [],
  });

  it("drops a blank that contains the title; keeps one that only shares letters with it", async () => {
    routeFetch(anthropicResponse([round("v1", "my Wonderwall"), round("v2", "all"), round("v3", "anybody feels")]));
    const tracks = ["v1", "v2", "v3"].map((videoId) => ({ ...TRACK, videoId }));
    const result = await resolveLyricsForTracks(tracks, "key");
    expect([...result.keys()]).toEqual(["v2", "v3"]);
  });

  it("givesAwayTitle: whole title words for Latin, any part of the title for CJK", () => {
    expect(givesAwayTitle("Wonderwall", "Wonderwall")).toBe(true);
    expect(givesAwayTitle("let it be", "Let It Be")).toBe(true);
    expect(givesAwayTitle("it", "Let It Be")).toBe(true);
    expect(givesAwayTitle("day", "Yesterday")).toBe(false);
    expect(givesAwayTitle("all", "Wonderwall")).toBe(false);
    expect(givesAwayTitle("don't", "Don&#39;t Stop Me Now")).toBe(true);
    expect(givesAwayTitle("玫瑰", "九十九朵玫瑰")).toBe(true);
    expect(givesAwayTitle("放晴的那天", "晴天")).toBe(false);
  });

  it("givesAwayTitle: compares Latin answers by word, never by shared letters", () => {
    expect(givesAwayTitle("someone like you", "One")).toBe(false);
    expect(givesAwayTitle("good times", "Go")).toBe(false);
    expect(givesAwayTitle("you", "U")).toBe(false);
    expect(givesAwayTitle("my wonderwall tonight", "Wonderwall")).toBe(true);
    expect(givesAwayTitle("dont", "Don't Stop Me Now")).toBe(true);
    expect(givesAwayTitle("cafe\u0301", "Café Song")).toBe(true);
    expect(givesAwayTitle("all", "Wonderwall (中文版)")).toBe(false);
    expect(givesAwayTitle("サクラ", "さくら サクラ")).toBe(true);
    expect(givesAwayTitle("사랑", "사랑해")).toBe(true);
    expect(givesAwayTitle("good 같아", "Go")).toBe(false);
    expect(givesAwayTitle("愛情", "Love Story 愛情故事")).toBe(true);
  });

  it("givesAwayTitle: a CJK answer sharing two adjacent title characters gives it away", () => {
    expect(givesAwayTitle("幸運的", "小幸運")).toBe(true);
    expect(givesAwayTitle("氣球飛走", "告白氣球")).toBe(true);
    expect(givesAwayTitle("故事書", "Love Story 愛情故事")).toBe(true);
    expect(givesAwayTitle("放晴的那天", "晴天")).toBe(false);
    expect(givesAwayTitle("靠得那麼近", "小幸運")).toBe(false);
    expect(givesAwayTitle("絕對不放", "倔強")).toBe(false);
    expect(givesAwayTitle("幸福", "小幸運")).toBe(false);
    expect(givesAwayTitle("愛して", "恋をして")).toBe(false);
    expect(givesAwayTitle("天雨", "晴天 雨天")).toBe(false);
    expect(givesAwayTitle("사랑해요", "사랑해")).toBe(true);
  });

  it("drops a CJK blank that is part of the title", async () => {
    const zh = { videoId: "v1", title: "九十九朵玫瑰", artist: "丘丘合唱團", year: 1990 };
    routeFetch(anthropicResponse([round("v1", "玫瑰", "zh-TW")]));
    expect((await resolveLyricsForTracks([zh], "key")).size).toBe(0);
  });

  it("skips the guard when the title normalizes to empty (no letters/digits)", async () => {
    routeFetch(anthropicResponse([round("v1", "anything at all")]));
    const result = await resolveLyricsForTracks([{ ...TRACK, title: "★☆!" }], "key");
    expect(result.get("v1")?.blankSentence).toBe("anything at all");
  });
});

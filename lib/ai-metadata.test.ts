import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveTracksWithAI, proposeEdits, proposeLyricEdits } from "./ai-metadata";
import type { EditableSong, EditableLyricRound } from "./game";

// Mock fetch so tests don't hit the network — same pattern as lib/lyrics-fetcher.test.ts.
// Regression: this file didn't exist before — ai-metadata.ts was only indirectly exercised
// via party/index.test.ts's own mocks. Flagged by /plan-eng-review's Code Quality review
// (2026-09-22) when adding proposeEdits — the new function gets direct coverage, not inherited
// untested status.
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function anthropicResponse(text: string, ok = true) {
  return {
    ok,
    text: () => Promise.resolve(ok ? "" : "server error body"),
    json: () => Promise.resolve({ content: [{ type: "text", text }] }),
  } as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveTracksWithAI", () => {
  it("resolves title/artist/year for a track", async () => {
    mockFetch.mockResolvedValueOnce(
      anthropicResponse(`[{"v":"abc123","t":"Yesterday","a":"The Beatles","y":1965}]`)
    );
    const result = await resolveTracksWithAI(
      [{ videoId: "abc123", title: "The Beatles - Yesterday (Official)", description: "", channelTitle: "The Beatles" }],
      "fake-key"
    );
    expect(result.get("abc123")).toEqual({ title: "Yesterday", artist: "The Beatles", year: 1965 });
  });

  it("returns an empty Map with no API key", async () => {
    const result = await resolveTracksWithAI([{ videoId: "x", title: "t", description: "", channelTitle: "c" }], "");
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails open to an empty Map on API error", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("", false));
    const result = await resolveTracksWithAI(
      [{ videoId: "x", title: "t", description: "", channelTitle: "c" }],
      "fake-key"
    );
    expect(result.size).toBe(0);
  });
});

describe("proposeEdits", () => {
  const songs: EditableSong[] = [
    { videoId: "v1", title: "Wonderwall", artist: "Oasis", year: 1994 },
    { videoId: "v2", title: "Yesterday", artist: "The Beatles", year: 1965 },
  ];

  it("returns [] with no API key, no songs, or a blank instruction", async () => {
    expect(await proposeEdits("fix it", songs, "")).toEqual([]);
    expect(await proposeEdits("fix it", [], "key")).toEqual([]);
    expect(await proposeEdits("   ", songs, "key")).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("proposes a year fix, computing oldValue from the passed-in songs — not the model's echo", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v1","f":"year","n":1995}]`));
    const diff = await proposeEdits("the first song's year is wrong, it's 1995", songs, "fake-key");
    expect(diff).toEqual([{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }]);
  });

  it("proposes a title/artist fix", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v2","f":"artist","n":"The Beatles (remastered)"}]`));
    const diff = await proposeEdits("fix the artist name on the 2nd song", songs, "fake-key");
    expect(diff).toEqual([{ videoId: "v2", field: "artist", oldValue: "The Beatles", newValue: "The Beatles (remastered)" }]);
  });

  it("drops a no-op change (new value equals current value)", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v1","f":"year","n":1994}]`));
    const diff = await proposeEdits("check the year", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("ignores a proposed change for a videoId not in the input list — never invents a song", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"not-in-list","f":"year","n":2000}]`));
    const diff = await proposeEdits("change something", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("rejects an out-of-range year", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v1","f":"year","n":1500}]`));
    const diff = await proposeEdits("bad year", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("returns [] when the instruction doesn't map to any song (model returns [])", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[]`));
    const diff = await proposeEdits("what's the capital of France", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("fails open to [] on a whole-call API error", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("", false));
    const diff = await proposeEdits("fix it", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("fails open to [] on a malformed (non-JSON) response", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("not json at all"));
    const diff = await proposeEdits("fix it", songs, "fake-key");
    expect(diff).toEqual([]);
  });

  it("strips markdown code fences the model might add", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse('```json\n[{"v":"v1","f":"year","n":2000}]\n```'));
    const diff = await proposeEdits("fix it", songs, "fake-key");
    expect(diff).toEqual([{ videoId: "v1", field: "year", oldValue: 1994, newValue: 2000 }]);
  });
});

describe("proposeLyricEdits", () => {
  const rounds: EditableLyricRound[] = [
    { videoId: "v1", title: "愛你", artist: "Twice", lyricContext: "I want you 想要有 ___ 陪伴", blankSentence: "你的愛" },
    { videoId: "v2", title: "Dynamite", artist: "BTS", lyricContext: "Cos I, I, I'm in the ___", blankSentence: "stars" },
  ];

  it("returns [] with no API key, no rounds, or a blank instruction", async () => {
    expect(await proposeLyricEdits("fix it", rounds, "")).toEqual([]);
    expect(await proposeLyricEdits("fix it", [], "key")).toEqual([]);
    expect(await proposeLyricEdits("   ", rounds, "key")).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("proposes a blankSentence fix, computing oldValue from the passed-in rounds — not the model's echo", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v1","f":"blankSentence","n":"你的心"}]`));
    const diff = await proposeLyricEdits("the first round's answer has a typo, it's 你的心", rounds, "fake-key");
    expect(diff).toEqual([{ videoId: "v1", field: "blankSentence", oldValue: "你的愛", newValue: "你的心" }]);
  });

  it("proposes a lyricContext fix", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v2","f":"lyricContext","n":"Cos I, I, I'm in the ___ tonight"}]`));
    const diff = await proposeLyricEdits("add more context to the 2nd round", rounds, "fake-key");
    expect(diff).toEqual([{ videoId: "v2", field: "lyricContext", oldValue: "Cos I, I, I'm in the ___", newValue: "Cos I, I, I'm in the ___ tonight" }]);
  });

  it("drops a no-op change (new value equals current value)", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"v1","f":"blankSentence","n":"你的愛"}]`));
    const diff = await proposeLyricEdits("check the answer", rounds, "fake-key");
    expect(diff).toEqual([]);
  });

  it("ignores a proposed change for a videoId not in the input list — never invents a round", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[{"v":"not-in-list","f":"blankSentence","n":"x"}]`));
    const diff = await proposeLyricEdits("change something", rounds, "fake-key");
    expect(diff).toEqual([]);
  });

  it("returns [] when the instruction doesn't map to any round (model returns [])", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse(`[]`));
    const diff = await proposeLyricEdits("what's the capital of France", rounds, "fake-key");
    expect(diff).toEqual([]);
  });

  it("fails open to [] on a whole-call API error", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("", false));
    const diff = await proposeLyricEdits("fix it", rounds, "fake-key");
    expect(diff).toEqual([]);
  });

  it("fails open to [] on a malformed (non-JSON) response", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse("not json at all"));
    const diff = await proposeLyricEdits("fix it", rounds, "fake-key");
    expect(diff).toEqual([]);
  });

  it("strips markdown code fences the model might add", async () => {
    mockFetch.mockResolvedValueOnce(anthropicResponse('```json\n[{"v":"v1","f":"blankSentence","n":"新答案"}]\n```'));
    const diff = await proposeLyricEdits("fix it", rounds, "fake-key");
    expect(diff).toEqual([{ videoId: "v1", field: "blankSentence", oldValue: "你的愛", newValue: "新答案" }]);
  });
});

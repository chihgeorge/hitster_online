import { describe, it, expect } from "vitest";
import { isCorrect, computePoints, normCJK, normLatin, isCJKText } from "./fuzzy";
import type { LyricsRound, LyricsGameConfig } from "./game";

function makeRound(overrides: Partial<LyricsRound> = {}): LyricsRound {
  return {
    videoId: "vid1",
    title: "Test Song",
    artist: "Test Artist",
    language: "en",
    lyricContext: "Before ___",
    blankSentence: "Hello world",
    acceptableVariants: [],
    ...overrides,
  };
}

const cfg = (fuzzyEnabled = false): LyricsGameConfig => ({ timerSeconds: 60, totalRounds: 10, fuzzyEnabled });

describe("normLatin", () => {
  it("lowercases and strips punctuation", () => {
    expect(normLatin("Hello, World!")).toBe("hello world");
  });
  it("collapses multiple spaces", () => {
    expect(normLatin("  too   many   spaces  ")).toBe("too many spaces");
  });
});

describe("normCJK", () => {
  it("removes CJK punctuation and spaces", () => {
    expect(normCJK("你好，世界！")).toBe("你好世界");
  });
  it("removes full-width spaces", () => {
    expect(normCJK("你　好")).toBe("你好");
  });
});

describe("isCJKText", () => {
  it("detects CJK characters", () => {
    expect(isCJKText("你好")).toBe(true);
    expect(isCJKText("こんにちは")).toBe(true);
    expect(isCJKText("안녕")).toBe(true);
    expect(isCJKText("hello")).toBe(false);
  });
});

describe("isCorrect — exact match", () => {
  it("returns true for exact match", () => {
    const r = makeRound({ blankSentence: "Hello world" });
    expect(isCorrect("Hello world", r, cfg())).toBe(true);
  });

  it("returns true for case-insensitive latin match", () => {
    const r = makeRound({ blankSentence: "Hello world" });
    expect(isCorrect("HELLO WORLD", r, cfg())).toBe(true);
  });

  it("returns true for variant match", () => {
    const r = makeRound({ blankSentence: "Hello world", acceptableVariants: ["hello"] });
    expect(isCorrect("hello", r, cfg())).toBe(true);
  });
});

describe("isCorrect — fuzzy disabled", () => {
  it("rejects close-but-not-exact answer when fuzzy is off", () => {
    const r = makeRound({ blankSentence: "Hello world" });
    expect(isCorrect("Helo world", r, cfg(false))).toBe(false);
  });
});

describe("isCorrect — fuzzy enabled (D5 fix: checks variants too)", () => {
  it("accepts answer within threshold of target", () => {
    const r = makeRound({ blankSentence: "Hello world" });
    expect(isCorrect("Helo world", r, cfg(true))).toBe(true);
  });

  it("accepts answer within threshold of a variant (D5 fix)", () => {
    const r = makeRound({ blankSentence: "Hello world", acceptableVariants: ["hi world"] });
    expect(isCorrect("hi wrld", r, cfg(true))).toBe(true);
  });

  it("rejects answer too far from both target and variants", () => {
    const r = makeRound({ blankSentence: "Hello world" });
    expect(isCorrect("completely wrong", r, cfg(true))).toBe(false);
  });

  it("uses threshold=1 for CJK", () => {
    const r = makeRound({ blankSentence: "你好世界", language: "zh-TW" });
    // Distance 1 from "你好世界" (replace last char) — should be accepted
    expect(isCorrect("你好世界!", r, cfg(true))).toBe(true);
  });
});

describe("computePoints", () => {
  it("awards full points for immediate answer", () => {
    const now = Date.now();
    const pts = computePoints(now, now + 100, 60);
    expect(pts).toBe(Math.round((60 - 0.1) * Math.floor(500 / 60)));
  });

  it("awards 0 for answer after deadline", () => {
    const now = Date.now();
    expect(computePoints(now, now + 70_000, 60)).toBe(0);
  });

  it("awards partial points for mid-timer answer", () => {
    const now = 1000000;
    const pts = computePoints(now, now + 30_000, 60);
    expect(pts).toBe(Math.round(30 * Math.floor(500 / 60)));
  });

  it("never returns negative", () => {
    expect(computePoints(0, 999999, 60)).toBe(0);
  });
});

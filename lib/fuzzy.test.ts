import { describe, it, expect } from "vitest";
import { isCorrect, computePoints, normCJK, normLatin, isCJKText } from "./fuzzy";

// isCorrect now takes (answer, target, variants, fuzzyEnabled) directly — no longer coupled
// to LyricsRound/LyricsGameConfig (docs/designs/guess-mode-song-artist.md, D-eng-2). This
// helper keeps the test bodies below reading the same as before the signature widened.
function checkCorrect(answer: string, target: string, variants: string[] = [], fuzzyEnabled = false): boolean {
  return isCorrect(answer, target, variants, fuzzyEnabled);
}

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
    expect(checkCorrect("Hello world", "Hello world")).toBe(true);
  });

  it("returns true for case-insensitive latin match", () => {
    expect(checkCorrect("HELLO WORLD", "Hello world")).toBe(true);
  });

  it("returns true for variant match", () => {
    expect(checkCorrect("hello", "Hello world", ["hello"])).toBe(true);
  });
});

describe("isCorrect — fuzzy disabled", () => {
  it("rejects close-but-not-exact answer when fuzzy is off", () => {
    expect(checkCorrect("Helo world", "Hello world", [], false)).toBe(false);
  });
});

describe("isCorrect — fuzzy enabled (D5 fix: checks variants too)", () => {
  it("accepts answer within threshold of target", () => {
    expect(checkCorrect("Helo world", "Hello world", [], true)).toBe(true);
  });

  it("accepts answer within threshold of a variant (D5 fix)", () => {
    expect(checkCorrect("hi wrld", "Hello world", ["hi world"], true)).toBe(true);
  });

  it("rejects answer too far from both target and variants", () => {
    expect(checkCorrect("completely wrong", "Hello world", [], true)).toBe(false);
  });

  it("uses threshold=1 for CJK", () => {
    // Distance 1 from "你好世界" (replace last char) — should be accepted
    expect(checkCorrect("你好世界!", "你好世界", [], true)).toBe(true);
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

  // maxPoints (D-eng-2): defaults to 500 so every pre-existing caller is unaffected;
  // Guess mode's compound scorer passes a smaller cap per point category.
  it("defaults maxPoints to 500", () => {
    const now = Date.now();
    expect(computePoints(now, now + 100, 60)).toBe(computePoints(now, now + 100, 60, 500));
  });

  it("scales to a custom maxPoints", () => {
    const now = 1000000;
    const pts = computePoints(now, now + 30_000, 60, 250);
    expect(pts).toBe(Math.round(30 * Math.floor(250 / 60)));
  });
});

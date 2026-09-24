import { describe, it, expect } from "vitest";
import { scoreGuess, guessMatches, GUESS_POINTS } from "./guess-scoring";

const target = { title: "晴天", artist: "周杰倫" };
// Answered instantly (ts == roundStart) → every part scores its full max (timer 10s divides evenly).
const at0 = (title: string, artist: string) => scoreGuess({ title, artist, ts: 0 }, target, 0, 10, false);

describe("scoreGuess", () => {
  it("both correct: title + artist + bonus", () => {
    expect(at0("晴天", "周杰倫")).toEqual({
      titleCorrect: true, artistCorrect: true,
      titlePoints: GUESS_POINTS.title, artistPoints: GUESS_POINTS.artist, bonusPoints: GUESS_POINTS.bonus,
      points: GUESS_POINTS.title + GUESS_POINTS.artist + GUESS_POINTS.bonus,
    });
  });

  it("title only: no artist points, no bonus", () => {
    expect(at0("晴天", "五月天")).toMatchObject({ titleCorrect: true, artistCorrect: false, artistPoints: 0, bonusPoints: 0, points: GUESS_POINTS.title });
  });

  it("artist only: no title points, no bonus", () => {
    expect(at0("稻香", "周杰倫")).toMatchObject({ titleCorrect: false, artistCorrect: true, bonusPoints: 0, points: GUESS_POINTS.artist });
  });

  it("blank field is wrong for that field only", () => {
    expect(at0("", "周杰倫")).toMatchObject({ titleCorrect: false, artistCorrect: true, points: GUESS_POINTS.artist });
    expect(at0("   ", "")).toMatchObject({ titleCorrect: false, artistCorrect: false, points: 0 });
  });

  it("no artist metadata: title-only round, blank artist guess can't match blank target", () => {
    const s = scoreGuess({ title: "晴天", artist: "", ts: 0 }, { title: "晴天", artist: "" }, 0, 10, false);
    expect(s).toMatchObject({ titleCorrect: true, artistCorrect: false, bonusPoints: 0, points: GUESS_POINTS.title });
  });

  it("every part is speed-scaled from the one submit timestamp", () => {
    const s = scoreGuess({ title: "晴天", artist: "周杰倫", ts: 5000 }, target, 0, 10, false);
    expect(s.titlePoints).toBe(125);
    expect(s.artistPoints).toBe(125);
    expect(s.bonusPoints).toBe(50);
  });

  it("past the timer scores nothing even when correct", () => {
    const s = scoreGuess({ title: "晴天", artist: "周杰倫", ts: 11_000 }, target, 0, 10, false);
    expect(s.points).toBe(0);
  });

  it("fuzzy matching applies per field when enabled", () => {
    const latin = { title: "Bohemian Rhapsody", artist: "Queen" };
    expect(scoreGuess({ title: "Bohemian Rapsody", artist: "Quen", ts: 0 }, latin, 0, 10, false).points).toBe(0);
    expect(scoreGuess({ title: "Bohemian Rapsody", artist: "Quen", ts: 0 }, latin, 0, 10, true).bonusPoints).toBe(GUESS_POINTS.bonus);
  });
});

describe("guessMatches (review 2026-09-24 regressions)", () => {
  it("matches titles with apostrophes/ampersands, even when the target was escaped twice", () => {
    expect(guessMatches("Don&#39;t Stop", "Don&amp;#39;t Stop", false)).toBe(true); // escaped guess vs saved-playlist target
    expect(guessMatches("dont stop", "Don&#39;t Stop", false)).toBe(true);
    expect(guessMatches("Simon &amp; Garfunkel", "Simon & Garfunkel", false)).toBe(true);
  });

  it("never matches when either side normalizes to nothing, in any script", () => {
    expect(guessMatches("?", "Кино", false)).toBe(false);
    expect(guessMatches("Группа крови", "Кино", false)).toBe(false);
    expect(guessMatches("кино", "Кино", false)).toBe(true);
    expect(guessMatches("!!!", "???", true)).toBe(false);
  });

  it("fuzzy doesn't let short guesses hit short targets", () => {
    expect(guessMatches("a", "U2", true)).toBe(false);
    expect(guessMatches("Sea", "Sia", true)).toBe(false);
    expect(guessMatches("晴", "晴天", true)).toBe(false);
    expect(guessMatches("Bohemian Rapsody", "Bohemian Rhapsody", true)).toBe(true);
    expect(guessMatches("告白汽球", "告白氣球", true)).toBe(true);
  });

  it("mixed-script names ignore case and punctuation", () => {
    expect(guessMatches("五月天 mayday", "五月天 Mayday", false)).toBe(true);
    expect(guessMatches("告白氣球 live", "告白氣球 (Live)", false)).toBe(true);
  });
});

describe("scoreGuess on long timers (review 2026-09-24)", () => {
  it("still pays full points for an instant answer at the 300s max timer", () => {
    const s = scoreGuess({ title: "晴天", artist: "周杰倫", ts: 0 }, { title: "晴天", artist: "周杰倫" }, 0, 300, false);
    expect(s).toMatchObject({ titlePoints: GUESS_POINTS.title, artistPoints: GUESS_POINTS.artist, bonusPoints: GUESS_POINTS.bonus });
  });

  it("scales linearly at an uneven timer", () => {
    const s = scoreGuess({ title: "晴天", artist: "", ts: 30_000 }, { title: "晴天", artist: "" }, 0, 120, false);
    expect(s.titlePoints).toBe(Math.round(GUESS_POINTS.title * 0.75));
  });
});

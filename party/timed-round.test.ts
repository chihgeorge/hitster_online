import { describe, it, expect } from "vitest";
import * as tr from "./timed-round";
import type { TimedRoundState } from "../lib/game";

type A = { text: string; ts: number; points: number };
function fresh(): TimedRoundState<string, A> {
  return {
    phase: "preview", players: { p1: { name: "a", score: 0, connected: true }, p2: { name: "b", score: 0, connected: true } },
    rounds: ["r1", "r2"], currentRound: null, roundStart: null, timerSeconds: 10, answers: {},
    totalRounds: 2, currentRoundIndex: 0, consecutiveSkips: 3,
  };
}
const build = (text: string) => (ts: number): A => ({ text, ts, points: 0 });

describe("timed-round engine", () => {
  it("runs preview → playing → guessing → results → playing → … → ended", () => {
    const s = fresh();
    expect(tr.startRound(s, 0)).toBe(false); // wrong phase
    expect(tr.confirmPreview(s)).toBe(true);
    expect(s).toMatchObject({ phase: "playing", currentRound: "r1" });
    expect(tr.startRound(s, 1000)).toBe(true);
    expect(s).toMatchObject({ phase: "guessing", roundStart: 1000 });

    expect(tr.acceptAnswer(s, "p1", 2000, 500, build("x"))).toBe("ok");
    expect(tr.acceptAnswer(s, "p1", 2100, 500, build("y"))).toBe("ignored"); // already answered
    expect(tr.acceptAnswer(s, "ghost", 2100, 500, build("y"))).toBe("ignored");
    expect(tr.acceptAnswer(s, "p2", 1000 + 10_000 + 501, 500, build("late"))).toBe("too_late");
    expect(Object.keys(s.answers)).toEqual(["p1"]);

    expect(tr.showResults(s, (round, a) => ({ answer: { ...a, points: 7 }, points: round === "r1" ? 7 : 0 }))).toBe(true);
    expect(s.phase).toBe("results");
    expect(s.players.p1.score).toBe(7);
    expect(s.answers.p1.points).toBe(7);
    expect(s.consecutiveSkips).toBe(0);

    expect(tr.nextRound(s)).toBe(true);
    expect(s).toMatchObject({ phase: "playing", currentRound: "r2", roundStart: null, answers: {} });
    tr.startRound(s, 0);
    tr.showResults(s, (_, a) => ({ answer: a, points: 0 }));
    expect(tr.nextRound(s)).toBe(true);
    expect(s).toMatchObject({ phase: "ended", currentRound: null });
  });

  it("accepts an answer exactly at the grace deadline", () => {
    const s = fresh();
    tr.confirmPreview(s);
    tr.startRound(s, 0);
    expect(tr.acceptAnswer(s, "p1", 10_500, 500, build("x"))).toBe("ok");
  });

  it("redacts answers only during guessing", () => {
    const s = fresh();
    tr.confirmPreview(s);
    tr.startRound(s, 0);
    tr.acceptAnswer(s, "p1", 1, 0, build("secret"));
    const strip = (a: A) => ({ ...a, text: "" });
    expect(tr.publicAnswers(s, strip).p1.text).toBe("");
    expect(s.answers.p1.text).toBe("secret"); // server copy untouched
    tr.showResults(s, (_, a) => ({ answer: a, points: 0 }));
    expect(tr.publicAnswers(s, strip).p1.text).toBe("secret");
  });
});

describe("clampConfig (replaced Lyrics' inline clamping)", () => {
  it("falls back to defaults for missing, non-numeric or non-object config", () => {
    const d = { timerSeconds: tr.DEFAULT_TIMER_SECONDS, totalRounds: tr.DEFAULT_TOTAL_ROUNDS, fuzzyEnabled: false };
    expect(tr.clampConfig(undefined)).toEqual(d);
    expect(tr.clampConfig("x")).toEqual(d);
    expect(tr.clampConfig({ timerSeconds: "90", totalRounds: NaN, fuzzyEnabled: "yes" })).toEqual(d);
  });
  it("clamps to the allowed ranges", () => {
    expect(tr.clampConfig({ timerSeconds: 1, totalRounds: 0 })).toMatchObject({ timerSeconds: 10, totalRounds: 1 });
    expect(tr.clampConfig({ timerSeconds: 9999, totalRounds: 99, fuzzyEnabled: true })).toEqual({ timerSeconds: 300, totalRounds: 30, fuzzyEnabled: true });
  });
});

describe("timed-round wrong-phase refusals", () => {
  it("every transition refuses outside its phase and leaves state untouched", () => {
    const s = fresh();
    expect(tr.acceptAnswer(s, "p1", 0, 500, build("x"))).toBe("ignored"); // preview
    expect(tr.showResults(s, (_, a) => ({ answer: a, points: 1 }))).toBe(false);
    expect(tr.nextRound(s)).toBe(false);
    tr.confirmPreview(s);
    expect(tr.confirmPreview(s)).toBe(false);
    expect(s).toMatchObject({ phase: "playing", currentRound: "r1", answers: {} });
    expect(s.players.p1.score).toBe(0);
  });
});

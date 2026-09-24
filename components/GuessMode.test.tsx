import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GuessPlay, GuessScreen, GuessHostControls, guessAudioProps } from "./GuessMode";
import type { GuessAnswer, PublicGuessGameState } from "@/lib/game";

afterEach(cleanup);

const ME = "me";
function state(over: Partial<PublicGuessGameState> = {}): PublicGuessGameState {
  return {
    mode: "guess", phase: "guessing",
    players: { [ME]: { name: "Alice", score: 0, connected: true }, bob: { name: "Bob", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null },
    roundStart: Date.now(), timerSeconds: 60, answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0,
    ...over,
  };
}
const answer = (over: Partial<GuessAnswer> = {}): GuessAnswer => ({
  title: "", artist: "", ts: 0, titleCorrect: false, artistCorrect: false,
  titlePoints: 0, artistPoints: 0, bonusPoints: 0, points: 0, ...over,
});

describe("guessAudioProps", () => {
  const audio = { videoId: "abcdefghijk", roundIndex: 0 };
  it("is cued but silent before the round, audible while guessing and at results", () => {
    expect(guessAudioProps(state({ phase: "playing" }), audio)).toEqual({ videoId: audio.videoId, playing: false });
    expect(guessAudioProps(state({ phase: "guessing" }), audio)).toEqual({ videoId: audio.videoId, playing: true });
    expect(guessAudioProps(state({ phase: "results" }), audio)).toEqual({ videoId: audio.videoId, playing: true });
  });
  it("ignores a reply for a different round", () => {
    expect(guessAudioProps(state({ currentRoundIndex: 1 }), audio)).toEqual({ videoId: null, playing: false });
  });
});

describe("GuessPlay", () => {
  it("submits title and artist together", () => {
    const onSubmit = vi.fn();
    render(<GuessPlay state={state()} playerId={ME} playerName="Alice" tooLate={false} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("guess-title-input"), { target: { value: " 晴天 " } });
    fireEvent.change(screen.getByTestId("guess-artist-input"), { target: { value: "周杰倫" } });
    fireEvent.click(screen.getByTestId("guess-submit-btn"));
    expect(onSubmit).toHaveBeenCalledWith("晴天", "周杰倫");
    expect(screen.getByText(/已送出/)).toBeTruthy();
  });

  it("title-only round has no artist input", () => {
    render(<GuessPlay state={state({ currentRound: { hasArtist: false, title: null, artist: null } })} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("guess-artist-input")).toBeNull();
  });

  it("a reconnecting player who already answered sees 'submitted', not an empty form", () => {
    render(<GuessPlay state={state({ answers: { [ME]: answer() } })} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("guess-title-input")).toBeNull();
    expect(screen.getByText(/已送出/)).toBeTruthy();
  });

  it("TOO_LATE after submitting shows time's up, not submitted", () => {
    const { rerender } = render(<GuessPlay state={state()} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByTestId("guess-title-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("guess-submit-btn"));
    rerender(<GuessPlay state={state()} playerId={ME} playerName="Alice" tooLate={true} onSubmit={vi.fn()} />);
    expect(screen.getByText(/時間到/)).toBeTruthy();
  });

  it("results show the decoded answer and a per-field breakdown, omitting artist on title-only rounds", () => {
    const s = state({
      phase: "results",
      currentRound: { hasArtist: false, title: "Don&#39;t Stop", artist: "" },
      answers: { [ME]: answer({ title: "dont stop", titleCorrect: true, titlePoints: 240, points: 240 }) },
    });
    render(<GuessPlay state={s} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByTestId("guess-answer-title").textContent).toBe("Don't Stop");
    const mine = screen.getByTestId("guess-my-result");
    expect(mine.textContent).toContain("歌名");
    expect(mine.textContent).not.toContain("歌手");
    expect(mine.textContent).toContain("+240 pts");
  });
});

describe("GuessScreen", () => {
  it("never shows the answer while guessing, and shows the answered count", () => {
    render(<GuessScreen state={state({ answers: { bob: answer() } })} />);
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("results list each player's per-field marks", () => {
    const s = state({
      phase: "results",
      currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" },
      answers: { [ME]: answer({ titleCorrect: true, artistCorrect: true, points: 560 }) },
    });
    render(<GuessScreen state={s} />);
    expect(screen.getByText("晴天")).toBeTruthy();
    expect(screen.getByText("+560")).toBeTruthy();
    expect(screen.getByText("未作答")).toBeTruthy(); // Bob
  });
});

describe("GuessHostControls", () => {
  const panel = {};
  it("maps each phase to its one action, and quit asks for confirmation", () => {
    const onStartRound = vi.fn(), onReset = vi.fn();
    render(<GuessHostControls state={state({ phase: "playing" })} panel={panel} onStartRound={onStartRound} onShowResults={vi.fn()} onNext={vi.fn()} onReset={onReset} />);
    fireEvent.click(screen.getByTestId("guess-start-round-btn"));
    expect(onStartRound).toHaveBeenCalled();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
    fireEvent.click(screen.getByTestId("quit-game-btn"));
    expect(onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("quit-game-btn"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

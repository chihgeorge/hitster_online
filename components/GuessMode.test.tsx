import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { GuessPlay, GuessScreen, GuessHostControls, guessAudioProps, isLeader, REVEAL_VIDEO, SUBMIT_ACK_TIMEOUT_MS } from "./GuessMode";
import type { GuessAnswer, PublicGuessGameState } from "@/lib/game";

afterEach(cleanup);

const ME = "me";
function state(over: Partial<PublicGuessGameState> = {}): PublicGuessGameState {
  return {
    mode: "guess", phase: "guessing",
    players: { [ME]: { name: "Alice", score: 0, connected: true }, bob: { name: "Bob", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null },
    roundStart: Date.now(), timerSeconds: 60, answers: {}, totalRounds: 3, currentRoundIndex: 0,
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
    expect(guessAudioProps(state({ phase: "playing" }), audio)).toEqual({ videoId: audio.videoId, playing: false, frame: null });
    expect(guessAudioProps(state({ phase: "guessing" }), audio)).toEqual({ videoId: audio.videoId, playing: true, frame: null });
    expect(guessAudioProps(state({ phase: "results" }), audio)).toEqual({ videoId: audio.videoId, playing: true, frame: REVEAL_VIDEO });
  });
  it("shows the video only at the reveal, never while players are still guessing", () => {
    expect(guessAudioProps(state({ phase: "guessing" }), audio).frame).toBeNull();
    expect(guessAudioProps(state({ phase: "results" }), audio).frame).toBe(REVEAL_VIDEO);
    // No round info means no results layout (and no placeholder), so no floating video either.
    expect(guessAudioProps(state({ phase: "results", currentRound: null }), audio).frame).toBeNull();
  });
  it("ignores a reply for a different round", () => {
    expect(guessAudioProps(state({ currentRoundIndex: 1 }), audio)).toEqual({ videoId: null, playing: false, frame: null });
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
    // Not confirmed yet: "Sending…", no form to double-submit, and no premature ✓.
    expect(screen.getByTestId("guess-sending")).toBeTruthy();
    expect(screen.queryByText(/已送出/)).toBeNull();
    expect(screen.queryByTestId("guess-title-input")).toBeNull();
  });

  it("shows 'submitted' only once the server's state carries the answer", () => {
    const { rerender } = render(<GuessPlay state={state()} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByTestId("guess-title-input"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("guess-submit-btn"));
    rerender(<GuessPlay state={state({ answers: { [ME]: answer() } })} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByText(/已送出/)).toBeTruthy();
    expect(screen.queryByTestId("guess-sending")).toBeNull();
  });

  it("an answer the server never confirms reopens the form with a retry notice", () => {
    vi.useFakeTimers();
    try {
      const onSubmit = vi.fn();
      render(<GuessPlay state={state()} playerId={ME} playerName="Alice" tooLate={false} onSubmit={onSubmit} />);
      fireEvent.change(screen.getByTestId("guess-title-input"), { target: { value: "x" } });
      fireEvent.click(screen.getByTestId("guess-submit-btn"));
      act(() => { vi.advanceTimersByTime(SUBMIT_ACK_TIMEOUT_MS); });
      expect(screen.getByTestId("guess-send-failed")).toBeTruthy();
      expect((screen.getByTestId("guess-title-input") as HTMLInputElement).value).toBe("x"); // typed text kept
      fireEvent.click(screen.getByTestId("guess-submit-btn"));
      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("guess-send-failed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    // Even if a title somehow reached the client during guessing, the TV must not render it.
    render(<GuessScreen state={state({ answers: { bob: answer() }, currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" } })} />);
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.queryByText("晴天")).toBeNull();
    expect(screen.queryByText("周杰倫")).toBeNull();
    expect(screen.queryByTestId("guess-video-slot")).toBeNull();
  });

  it("reserves the video spot at the reveal, where the screen's player shows the song", () => {
    render(<GuessScreen state={state({ phase: "results", currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" } })} />);
    const slot = screen.getByTestId("guess-video-slot");
    expect(slot.style.top).toBe(`${REVEAL_VIDEO.top}px`);
    expect(slot.style.width).toBe(`${REVEAL_VIDEO.width}px`);
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
    vi.useFakeTimers();
    render(<GuessHostControls state={state({ phase: "playing" })} panel={panel} onStartRound={onStartRound} onShowResults={vi.fn()} onNext={vi.fn()} onReset={onReset} />);
    vi.advanceTimersByTime(500); // past the post-phase-change tap window
    fireEvent.click(screen.getByTestId("guess-start-round-btn"));
    vi.useRealTimers();
    expect(onStartRound).toHaveBeenCalled();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
    fireEvent.click(screen.getByTestId("quit-game-btn"));
    expect(onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("quit-game-btn"));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("GuessHostControls: double-tap can't skip the reveal (/ship review D2)", () => {
  it("ignores a second tap in the same phase and a tap right after the phase changes", () => {
    vi.useFakeTimers();
    const onShowResults = vi.fn(), onNext = vi.fn();
    const props = { panel: {}, onStartRound: vi.fn(), onShowResults, onNext, onReset: vi.fn() };
    const { rerender } = render(<GuessHostControls state={state({ phase: "guessing" })} {...props} />);
    vi.advanceTimersByTime(500);
    fireEvent.click(screen.getByTestId("guess-show-results-btn"));
    fireEvent.click(screen.getByTestId("guess-show-results-btn"));
    expect(onShowResults).toHaveBeenCalledTimes(1);
    // Server answers fast: results arrive, and the double-tap's second tap lands on "Next".
    rerender(<GuessHostControls state={state({ phase: "results", currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" } })} {...props} />);
    fireEvent.click(screen.getByTestId("guess-next-btn"));
    expect(onNext).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    fireEvent.click(screen.getByTestId("guess-next-btn"));
    expect(onNext).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("isLeader (DESIGN.md: gold = current leader only)", () => {
  const players = (a: number, b: number) => ({ players: { me: { score: a }, other: { score: b } } });
  it("is gold only for a top scorer with points", () => {
    expect(isLeader(players(10, 5), "me")).toBe(true);
    expect(isLeader(players(5, 10), "me")).toBe(false);
    expect(isLeader(players(0, 0), "me")).toBe(false); // nobody leads at 0-0
  });

  it("on tied points only the faster player is gold", () => {
    const tied = (meMs: number, otherMs: number) => ({ players: { me: { score: 7, timeMs: meMs }, other: { score: 7, timeMs: otherMs } } });
    expect(isLeader(tied(4_000, 9_000), "me")).toBe(true);
    expect(isLeader(tied(4_000, 9_000), "other")).toBe(false);
    expect(isLeader(tied(9_000, 4_000), "me")).toBe(false);
  });
});

describe("Guess ended screens: a tie on points", () => {
  const tiedEnd = state({ phase: "ended", currentRound: null, players: {
    [ME]: { name: "Alice", score: 500, connected: true, timeMs: 30_000 },
    bob: { name: "Bob", score: 500, connected: true, timeMs: 12_000 },
  } });
  it("names one winner (the faster player) and says time decided it", () => {
    const { unmount } = render(<GuessPlay state={tiedEnd} playerId="bob" playerName="Bob" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByText("WINNER!")).toBeTruthy();
    expect(screen.getByTestId("won-on-time")).toBeTruthy();
    unmount();
    render(<GuessPlay state={tiedEnd} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByText(/#2 — 500 pts/)).toBeTruthy();
    expect(screen.queryByText("WINNER!")).toBeNull();
  });

  it("the TV shows the faster player as winner, and no note when the scores differ", () => {
    const { unmount } = render(<GuessScreen state={tiedEnd} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Bob");
    expect(screen.getByTestId("won-on-time")).toBeTruthy();
    unmount();
    render(<GuessScreen state={{ ...tiedEnd, players: { ...tiedEnd.players, bob: { ...tiedEnd.players.bob, score: 600 } } }} />);
    expect(screen.queryByTestId("won-on-time")).toBeNull();
  });
});

describe("Guess ended screens (/ship review D3)", () => {
  const ended = state({ phase: "ended", currentRound: null, players: { [ME]: { name: "Alice", score: 300, connected: true }, bob: { name: "Bob", score: 900, connected: true } } });
  it("phone shows rank for a non-winner and WINNER for the winner", () => {
    const { unmount } = render(<GuessPlay state={ended} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByText(/#2 — 300 pts/)).toBeTruthy();
    unmount();
    render(<GuessPlay state={ended} playerId="bob" playerName="Bob" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByText("WINNER!")).toBeTruthy();
  });
  it("TV shows the winner and standings; host offers Play Again", () => {
    render(<GuessScreen state={ended} />);
    expect(screen.getByRole("heading", { name: "Bob" })).toBeTruthy();
    expect(screen.getByText("#2")).toBeTruthy();
    cleanup();
    const onReset = vi.fn();
    render(<GuessHostControls state={ended} panel={{}} onStartRound={vi.fn()} onShowResults={vi.fn()} onNext={vi.fn()} onReset={onReset} />);
    fireEvent.click(screen.getByTestId("guess-play-again-btn"));
    expect(onReset).toHaveBeenCalled();
  });
  it("last round's results button says See Rankings", () => {
    render(<GuessHostControls state={state({ phase: "results", currentRoundIndex: 2, totalRounds: 3, currentRound: { hasArtist: false, title: "晴天", artist: "" } })} panel={{}} onStartRound={vi.fn()} onShowResults={vi.fn()} onNext={vi.fn()} onReset={vi.fn()} />);
    expect(screen.getByTestId("guess-next-btn").textContent).toContain("查看排名");
  });
});

describe("/ship adversarial fixes", () => {
  it("a lost tap can't leave the host button disabled: any new snapshot re-arms it", () => {
    vi.useFakeTimers();
    const onNext = vi.fn();
    const results = () => state({ phase: "results", currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" } });
    const props = { panel: {}, onStartRound: vi.fn(), onShowResults: vi.fn(), onNext, onReset: vi.fn() };
    const { rerender } = render(<GuessHostControls state={results()} {...props} />);
    vi.advanceTimersByTime(500);
    fireEvent.click(screen.getByTestId("guess-next-btn")); // message lost with a dropping socket
    expect((screen.getByTestId("guess-next-btn") as HTMLButtonElement).disabled).toBe(true);
    rerender(<GuessHostControls state={results()} {...props} />); // reconnect resends the same phase
    expect((screen.getByTestId("guess-next-btn") as HTMLButtonElement).disabled).toBe(false);
    vi.advanceTimersByTime(2000); // the host retries a moment later
    fireEvent.click(screen.getByTestId("guess-next-btn"));
    expect(onNext).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a correct answer that scored 0 (grace window) isn't shown as a miss", () => {
    const s = state({
      phase: "results", currentRound: { hasArtist: true, title: "晴天", artist: "周杰倫" },
      answers: { [ME]: answer({ title: "晴天", titleCorrect: true, points: 0 }) },
    });
    render(<GuessPlay state={s} playerId={ME} playerName="Alice" tooLate={false} onSubmit={vi.fn()} />);
    expect(screen.getByTestId("guess-my-result").textContent).not.toContain("沒猜中");
  });
});

it("a single quick tap right after the button appears is not ignored (e2e regression)", () => {
  const onStartRound = vi.fn();
  render(<GuessHostControls state={state({ phase: "playing" })} panel={{}} onStartRound={onStartRound} onShowResults={vi.fn()} onNext={vi.fn()} onReset={vi.fn()} />);
  fireEvent.click(screen.getByTestId("guess-start-round-btn"));
  expect(onStartRound).toHaveBeenCalledTimes(1);
});

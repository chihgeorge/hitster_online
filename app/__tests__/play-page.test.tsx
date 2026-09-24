import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { PublicLyricsGameState, GameState } from "@/lib/game";

// Mock the socket + router: capture the page's onMessage so tests can play the server's part.
let socketOpts: { onMessage: (e: MessageEvent) => void; onOpen?: () => void };
const sendSpy = vi.fn();
vi.mock("partysocket/react", () => ({
  default: (opts: typeof socketOpts) => {
    socketOpts = opts;
    return { send: sendSpy };
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ code: "ABCD" }),
  useSearchParams: () => new URLSearchParams("name=QA"),
}));

import PlayPage from "@/app/room/[code]/play/page";

const PLAYER = "11111111-1111-4111-8111-111111111111";

const lobbyState: GameState = {
  phase: "lobby", players: {}, targetCardCount: 10, currentRound: 0, playlistId: "", songs: [],
  currentSong: null, placements: {}, activePlayerId: null, hostId: "", hostClaimed: false, winner: null,
};

function lyricsState(over: Partial<PublicLyricsGameState> = {}): PublicLyricsGameState {
  return {
    mode: "lyrics", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    rounds: [], currentRound: {
      videoId: "v1", title: "那些年", artist: "胡夏", language: "zh-TW",
      lyricContext: "那些年錯過的__", blankSentence: null,
    },
    roundStart: Date.now(), timerSeconds: 20, answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0,
    ...over,
  } as PublicLyricsGameState;
}

function serverSends(msg: object) {
  act(() => { socketOpts.onMessage({ data: JSON.stringify(msg) } as MessageEvent); });
}

const hasInput = () => screen.queryByPlaceholderText(/Fill in the blank/) !== null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
  localStorage.setItem("hitster_player_id", PLAYER);
  sendSpy.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("PlayPage: Lyrics Mode guessing", () => {
  it("shows the answer input while time remains", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    expect(hasInput()).toBe(true);
    expect(screen.queryByText(/Time's up/)).toBeNull();
  });

  // Regression: ISSUE-001 — after the countdown hit 0 the player could still submit and saw "Submitted!"
  // Found by /qa on 2026-09-21
  it("replaces the input with Time's up when the countdown reaches 0", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ roundStart: Date.now() - 19_000 }) });
    expect(hasInput()).toBe(true);
    act(() => { vi.advanceTimersByTime(1_500); }); // crosses the 20s deadline
    expect(screen.getByText(/Time's up/)).toBeTruthy();
    expect(hasInput()).toBe(false);
  });

  it("does not send an answer once the countdown is at 0", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ roundStart: Date.now() - 19_000 }) });
    act(() => { vi.advanceTimersByTime(1_500); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes("SUBMIT_LYRICS_ANSWER"))).toHaveLength(0);
  });

  it("swaps Submitted for Time's up when the server answers TOO_LATE", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    const input = screen.getByPlaceholderText(/Fill in the blank/);
    act(() => { (input as HTMLInputElement).focus(); });
    // type + submit via the same handler the button uses
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "愛情");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { screen.getByText(/送出/).closest("button")!.click(); });
    expect(screen.getByText(/Submitted/)).toBeTruthy();
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes("SUBMIT_LYRICS_ANSWER"))).toHaveLength(1);

    serverSends({ type: "TOO_LATE" });
    expect(screen.queryByText(/Submitted/)).toBeNull();
    expect(screen.getByText(/Time's up/)).toBeTruthy();
  });

  it("clears the too-late flag when the next round starts", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText(/Time's up/)).toBeTruthy();
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing", currentRoundIndex: 1, roundStart: null }) });
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ currentRoundIndex: 1, roundStart: Date.now() }) });
    expect(hasInput()).toBe(true);
    expect(screen.queryByText(/Time's up/)).toBeNull();
  });
});

describe("PlayPage: timeline placement double-submit guard", () => {
  // Regression: handlePlace had no local pending flag — hasPlaced only flips true on the
  // server's PLACEMENT_ACK, so a fast double-click before that round trip completed could
  // send a second PLACE at a different position, silently overwriting the first with no
  // error (party/index.ts's handlePlace unconditionally overwrites placements[playerId]).
  const guessingState: GameState = {
    ...lobbyState,
    phase: "guessing",
    activePlayerId: PLAYER,
    currentSong: { id: "s1", videoId: "s1", title: "Song", artist: "Artist", year: 2000 },
    players: { [PLAYER]: { name: "QA", cardCount: 1, timeline: [{ id: "c1", videoId: "c1", title: "Old", artist: "A", year: 1990 }], connected: true } },
  };

  function selectFirstDropZone() {
    // DropZone renders a plain <button> showing "+" when unselected — no dedicated testid.
    act(() => { screen.getAllByText("+")[0].click(); });
  }

  it("sends only one PLACE on a rapid double-click, before the server acks", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    const placeBtn = screen.getByTestId("place-btn");
    act(() => { placeBtn.click(); });
    act(() => { placeBtn.click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(1);
  });

  it("re-enables placement once the server ack arrives, and can place again next round", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(1);

    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER });
    // Round resolves and the next one starts — hasPlaced/pendingPlace both reset when phase
    // re-enters "guessing" (the effect watches state?.phase, so it must actually transition
    // away and back, not just stay "guessing" with different placements).
    serverSends({ type: "STATE", state: { ...guessingState, phase: "reveal" } });
    serverSends({ type: "STATE", state: { ...guessingState, placements: {} } });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(2);
  });
});

describe("PlayPage: lobby wrong-code warning", () => {
  // Regression: TODOS.md "Joining a nonexistent room code shows 'waiting for host' forever" —
  // found by /qa on 2026-09-21. PartyKit can't distinguish a wrong code from "host hasn't
  // started yet" (any code is a valid room), so the fix is an honest nudge with an actual way
  // out, not a hard error.
  it("shows no warning before 90 seconds of waiting", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: lobbyState });
    act(() => { vi.advanceTimersByTime(89_000); });
    expect(screen.queryByText(/等待超過 90 秒/)).toBeNull();
  });

  it("shows an actionable back-to-homepage link after 90 seconds in the lobby", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: lobbyState });
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.getByText(/等待超過 90 秒/)).toBeTruthy();
    const link = screen.getByText(/Back to homepage/).closest("a");
    expect(link?.getAttribute("href")).toBe("/");
  });

  it("does not warn once the game actually starts before the 90s mark", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: lobbyState });
    serverSends({ type: "STATE", state: { ...lobbyState, phase: "guessing" } });
    act(() => { vi.advanceTimersByTime(90_000); });
    expect(screen.queryByText(/等待超過 90 秒/)).toBeNull();
  });
});

describe("PlayPage: LYRICS_ABORTED", () => {
  // Regression: ISSUE-002 — players stayed on the WINNER screen after Play Again
  it("drops the ended screen and returns to the waiting lobby", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: lobbyState });
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "ended", currentRound: null }) });
    expect(screen.getByText(/WINNER/)).toBeTruthy();
    serverSends({ type: "LYRICS_ABORTED" });
    expect(screen.queryByText(/WINNER/)).toBeNull();
    expect(screen.getByText(/等待主持人開始遊戲/)).toBeTruthy();
  });
});

// Guess mode page wiring (/ship review D3): a TOO_LATE must not lock the player out of later rounds.
describe("PlayPage: Guess Mode TOO_LATE resets on the next round", () => {
  const guess = (over: object = {}) => ({
    mode: "guess", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null }, roundStart: Date.now(), timerSeconds: 60,
    answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0, ...over,
  });
  it("shows time's up after TOO_LATE, then the inputs again next round", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText(/時間到/)).toBeTruthy();
    serverSends({ type: "GUESS_STATE", state: guess({ phase: "playing", currentRoundIndex: 1, roundStart: null }) });
    serverSends({ type: "GUESS_STATE", state: guess({ currentRoundIndex: 1, roundStart: Date.now() }) });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
  });
  it("sends SUBMIT_GUESS with both fields", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    act(() => { (screen.getByTestId("guess-title-input") as HTMLInputElement).focus(); });
    const set = (id: string, v: string) => act(() => {
      const el = screen.getByTestId(id) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    set("guess-title-input", "晴天");
    set("guess-artist-input", "周杰倫");
    act(() => { screen.getByTestId("guess-submit-btn").click(); });
    const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent).toContainEqual({ type: "SUBMIT_GUESS", playerId: PLAYER, title: "晴天", artist: "周杰倫" });
  });
});

describe("PlayPage: Guess TOO_LATE is per round (/ship adversarial #3)", () => {
  const guess = (over: object = {}) => ({
    mode: "guess", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null }, roundStart: Date.now(), timerSeconds: 60,
    answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0, ...over,
  });
  it("reconnecting straight into the next round's guessing still shows the inputs", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    serverSends({ type: "TOO_LATE" });
    // No "playing" snapshot seen (phone was offline) — lands directly in round 1 guessing.
    serverSends({ type: "GUESS_STATE", state: guess({ currentRoundIndex: 1 }) });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
  });
});

describe("PlayPage: Guess TOO_LATE doesn't leak into the next game (/land-and-deploy review)", () => {
  const guess = (over: object = {}) => ({
    mode: "guess", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null }, roundStart: Date.now(), timerSeconds: 60,
    answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0, ...over,
  });
  it("after the host quits and restarts, round 0 of the new game shows the inputs", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText(/時間到/)).toBeTruthy();
    serverSends({ type: "GUESS_ABORTED" }); // host quit
    serverSends({ type: "GUESS_STATE", state: guess() }); // new game, same round index 0
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
  });
});

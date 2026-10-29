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
import { resetServerClock } from "@/lib/server-clock";

const PLAYER = "11111111-1111-4111-8111-111111111111";

const lobbyState: GameState = {
  phase: "lobby", players: {}, targetCardCount: 10, currentRound: 0, playlistId: "", songs: [],
  currentSong: null, dealSeq: 0, placements: {}, activePlayerId: null, hostId: "", hostClaimed: false, winner: null,
};

function lyricsState(over: Partial<PublicLyricsGameState> = {}): PublicLyricsGameState {
  return {
    mode: "lyrics", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    rounds: [], currentRound: {
      videoId: "v1", title: "那些年", artist: "胡夏", language: "zh-TW",
      lyricContext: "那些年錯過的__", blankSentence: null,
    },
    roundStart: Date.now(), timerSeconds: 20, answers: {}, totalRounds: 3, currentRoundIndex: 0,
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
afterEach(() => { cleanup(); vi.useRealTimers(); resetServerClock(); });

describe("PlayPage: countdown follows the server clock", () => {
  // The phone's clock is 90s fast. The round started on the server just now with 20s to go, which
  // the phone's own clock would read as 70s past the deadline.
  const serverTime = () => Date.now() - 90_000;

  it("Lyrics: shows the input and the server's time left, not Time's up", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ roundStart: serverTime() }), serverNow: serverTime() });
    act(() => { vi.advanceTimersByTime(300); });
    expect(hasInput()).toBe(true);
    expect(screen.queryByText(/Time's up/)).toBeNull();
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("Guess: shows the form and the server's time left, not Time's up", () => {
    render(<PlayPage />);
    const guess = {
      mode: "guess", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
      currentRound: { hasArtist: true, title: null, artist: null }, roundStart: serverTime(), timerSeconds: 20,
      answers: {}, totalRounds: 3, currentRoundIndex: 0,
    };
    serverSends({ type: "GUESS_STATE", state: guess, serverNow: serverTime() });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
    expect(screen.queryByText(/Time's up/)).toBeNull();
    expect(screen.getByText("20")).toBeTruthy();
  });
});

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

  function typeAndSubmit(text: string) {
    const input = screen.getByPlaceholderText(/Fill in the blank/);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => { screen.getByText(/送出/).closest("button")!.click(); });
  }
  const submits = () => sendSpy.mock.calls.filter((c) => String(c[0]).includes("SUBMIT_LYRICS_ANSWER"));
  const redacted = { text: "", ts: 0, correct: false, points: 0 };

  it("shows Sending… until the server's state carries the answer, then Submitted", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    typeAndSubmit("愛情");
    expect(submits()).toHaveLength(1);
    expect(screen.getByText(/Sending/)).toBeTruthy();
    expect(screen.queryByText(/Submitted/)).toBeNull();
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ answers: { [PLAYER]: redacted } }) });
    expect(screen.getByText(/Submitted/)).toBeTruthy();
  });

  it("swaps Sending… for Time's up when the server answers TOO_LATE", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    typeAndSubmit("愛情");
    serverSends({ type: "TOO_LATE" });
    expect(screen.queryByText(/Sending|Submitted/)).toBeNull();
    expect(screen.getByText(/Time's up/)).toBeTruthy();
  });

  it("an answer the server never confirms reopens the input with a retry notice", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState() });
    typeAndSubmit("愛情");
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(hasInput()).toBe(true);
    expect(screen.getByText(/try again/)).toBeTruthy();
    act(() => { screen.getByRole("button", { name: /Submit/ }).click(); });
    expect(submits()).toHaveLength(2);
  });

  it("a reconnecting player who already answered sees Submitted, not the input", () => {
    render(<PlayPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ answers: { [PLAYER]: redacted } }) });
    expect(hasInput()).toBe(false);
    expect(screen.getByText(/Submitted/)).toBeTruthy();
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
    // Blanked id/title/artist/videoId as sanitizedState sends a phone during guessing.
    currentSong: { id: "", videoId: "", title: "", artist: "", year: 0 },
    dealSeq: 1,
    players: { [PLAYER]: { name: "QA", timeline: [{ id: "c1", videoId: "c1", title: "Old", artist: "A", year: 1990 }], connected: true } },
  };

  function selectFirstDropZone() {
    // DropZone renders a plain <button> showing "+" when unselected — no dedicated testid.
    act(() => { screen.getAllByText("+")[0].click(); });
  }

  it("a lost PLACEMENT_ACK self-heals from the next STATE's placements", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    // The ack never arrives (socket blip); the reconnect STATE already records the placement.
    serverSends({ type: "STATE", state: { ...guessingState, placements: { [PLAYER]: 0 } } });
    expect(screen.getByText("已放置 ✓ 等待主持人揭曉")).toBeTruthy();
    expect(screen.queryByText("送出中…")).toBeNull();
  });

  it("after a mid-turn reload, a placement the server holds keeps the picker closed", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: { ...guessingState, placements: { [PLAYER]: 0 } } });
    expect(screen.getByText("已放置 ✓ 等待主持人揭曉")).toBeTruthy();
    expect(screen.queryAllByText("+")).toHaveLength(0);
  });

  it("a phone that slept through the reveal wakes into its next turn with the picker open", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: { ...guessingState, currentRound: 1 } });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER });
    // Reveal and next deal missed while asleep: guessing → guessing, but a new round.
    serverSends({ type: "STATE", state: { ...guessingState, currentRound: 2, placements: {} } });
    expect(screen.queryByText("已放置 ✓ 等待主持人揭曉")).toBeNull();
    expect(screen.getAllByText("+").length).toBeGreaterThan(0);
  });

  it("re-sends a pending PLACE right after REJOIN on reconnect, so the tap still counts", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    sendSpy.mockClear();
    act(() => { socketOpts.onOpen?.(); });
    const types = sendSpy.mock.calls.map(([m]) => JSON.parse(m as string).type);
    // partysocket flushed the queued PLACE before onopen, ahead of REJOIN; the server refuses that
    // one (not yet bound), so the PLACE must follow the REJOIN.
    expect(types).toEqual(["REJOIN", "PLACE"]);
    expect(screen.getByText("送出中…")).toBeTruthy();
  });

  // Value: protects=a reconnect after an acked placement doesn't re-place; fails_when=the onOpen re-send drops its
  // pendingPlace check (a reconnect after the reveal would re-send and draw a false 太晚了！); why_new=only the
  // pending case was tested; seam=none; no_claim=server handling of a repeat PLACE
  it("does not re-send PLACE on reconnect once the placement was acked", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER });
    sendSpy.mockClear();
    act(() => { socketOpts.onOpen?.(); });
    expect(sendSpy.mock.calls.map(([m]) => JSON.parse(m as string).type)).toEqual(["REJOIN"]);
  });

  it("a PLACE that beat its REJOIN is refused, then the re-sent one lands", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    act(() => { socketOpts.onOpen?.(); }); // reconnect: the queued PLACE beat the REJOIN
    serverSends({ type: "ERROR", error: "not_bound" }); // ...so the server refused it
    serverSends({ type: "STATE", state: guessingState });
    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER }); // the re-sent PLACE lands
    expect(screen.queryByText("送出中…")).toBeNull();
    expect(screen.getByText("已放置 ✓ 等待主持人揭曉")).toBeTruthy();
  });

  it("an ERROR after the tap drops 送出中… and lets the player place again", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(screen.getByText("送出中…")).toBeTruthy();
    serverSends({ type: "ERROR", error: "invalid_position" });
    expect(screen.queryByText("送出中…")).toBeNull();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(2);
  });

  it("sends only one PLACE on a rapid double-click, before the server acks", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    const placeBtn = screen.getByTestId("place-btn");
    act(() => { placeBtn.click(); });
    act(() => { placeBtn.click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(1);
  });

  it("a Timeline skip (same phase, new song) lets the player place again and shows the notice", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER });
    serverSends({ type: "ROUND_SKIPPED", mode: "timeline" });
    serverSends({ type: "STATE", state: { ...guessingState, currentSong: { id: "s2", videoId: "s2", title: "Next", artist: "B", year: 2005 } } });
    expect(screen.getByTestId("round-skipped")).toBeTruthy();
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes('"type":"PLACE"'))).toHaveLength(2);
  });

  it("says 送出中… after the tap and 已放置 ✓ only once the server acks", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    expect(screen.getByText("送出中…")).toBeTruthy();
    expect(screen.queryByText("已放置 ✓ 等待主持人揭曉")).toBeNull();
    serverSends({ type: "PLACEMENT_ACK", playerId: PLAYER });
    expect(screen.getByText("已放置 ✓ 等待主持人揭曉")).toBeTruthy();
  });

  // Real server order: the host reveals (STATE reveal is broadcast), then the late PLACE gets TOO_LATE.
  it("shows 太晚了！ when TOO_LATE arrives after the reveal STATE, and clears it next round", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    serverSends({ type: "STATE", state: { ...guessingState, phase: "reveal" } });
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText("太晚了！")).toBeTruthy();
    // The next round clears it, and the player can place again.
    serverSends({ type: "STATE", state: { ...guessingState, placements: {} } });
    expect(screen.queryByText("太晚了！")).toBeNull();
    selectFirstDropZone();
    expect(screen.getByTestId("place-btn")).toBeTruthy();
  });

  // Value: protects=a skip the phone missed offline can't turn its old tap into the new song's guess; fails_when=the
  // reset stops watching dealSeq, or PLACE stops carrying it; why_new=the skip test only covers a phone that
  // got ROUND_SKIPPED; seam=none; no_claim=server refusal (party/index.test.ts stale_song)
  it("a skip missed offline reopens the picker, and the re-sent PLACE names the skipped deal", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    const places = () => sendSpy.mock.calls.map(([m]) => JSON.parse(m as string)).filter((m) => m.type === "PLACE");
    act(() => { socketOpts.onOpen?.(); });
    expect(places().map((m) => m.dealSeq)).toEqual([1, 1]);
    // No ROUND_SKIPPED reached this phone: only the next deal's STATE, same round and phase, and the
    // song blanked exactly as before, so dealSeq is the only thing that changed.
    serverSends({ type: "STATE", state: { ...guessingState, dealSeq: 2 } });
    expect(screen.queryByText("送出中…")).toBeNull();
    expect(screen.getAllByText("+").length).toBeGreaterThan(0);
  });

  // Value: protects=a player whose other tab took the binding can still place from this one; fails_when=the ERROR
  // handler drops the not_bound rebind (every tap is refused, silently); why_new=not_bound was only tested on
  // reconnect; seam=none; no_claim=server rebinding on REJOIN (party/index.test.ts)
  it("not_bound takes the binding back once and re-sends the tap; a second refusal unlocks the picker", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    sendSpy.mockClear();
    serverSends({ type: "ERROR", error: "not_bound" });
    expect(sendSpy.mock.calls.map(([m]) => JSON.parse(m as string).type)).toEqual(["REJOIN", "PLACE"]);
    expect(screen.getByText("送出中…")).toBeTruthy();
    serverSends({ type: "ERROR", error: "not_bound" });
    expect(screen.queryByText("送出中…")).toBeNull();
    expect(sendSpy.mock.calls).toHaveLength(2);
  });

  // Value: protects=no 太晚了！ for a placement that counted; fails_when=tooLate ignores STATE.placements (a re-sent
  // PLACE after a lost ack draws TOO_LATE in the reveal); why_new=TOO_LATE was only tested with no placement;
  // seam=none; no_claim=none beyond protects
  it("a TOO_LATE for a re-sent PLACE whose first copy counted shows no 太晚了！", () => {
    render(<PlayPage />);
    serverSends({ type: "STATE", state: guessingState });
    selectFirstDropZone();
    act(() => { screen.getByTestId("place-btn").click(); });
    // The ack was lost; the reveal STATE still lists the placement, then the re-send gets TOO_LATE.
    serverSends({ type: "STATE", state: { ...guessingState, phase: "reveal", placements: { [PLAYER]: 0 } } });
    serverSends({ type: "TOO_LATE" });
    expect(screen.queryByText("太晚了！")).toBeNull();
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
    answers: {}, totalRounds: 3, currentRoundIndex: 0, ...over,
  });
  it("shows time's up after TOO_LATE, then the inputs again next round", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText(/時間到/)).toBeTruthy();
    serverSends({ type: "GUESS_STATE", state: guess({ phase: "playing", currentRoundIndex: 1, roundStart: null }) });
    serverSends({ type: "GUESS_STATE", state: guess({ currentRoundIndex: 1, roundStart: Date.now() + 90_000 }) });
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
    answers: {}, totalRounds: 3, currentRoundIndex: 0, ...over,
  });
  it("reconnecting straight into the next round's guessing still shows the inputs", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    serverSends({ type: "TOO_LATE" });
    // No "playing" snapshot seen (phone was offline) — lands directly in round 1 guessing.
    serverSends({ type: "GUESS_STATE", state: guess({ currentRoundIndex: 1, roundStart: Date.now() + 90_000 }) });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
  });

  it("offline through a host reset (no GUESS_ABORTED), round 0 of the new game still shows the inputs", () => {
    render(<PlayPage />);
    serverSends({ type: "GUESS_STATE", state: guess() });
    serverSends({ type: "TOO_LATE" });
    expect(screen.getByText(/時間到/)).toBeTruthy();
    // Reconnect snapshot: a brand-new game, same round index, a later round start.
    serverSends({ type: "GUESS_STATE", state: guess({ roundStart: Date.now() + 120_000 }) });
    expect(screen.getByTestId("guess-title-input")).toBeTruthy();
  });

  it("a snapshot of the same round keeps showing time's up", () => {
    render(<PlayPage />);
    const round = guess();
    serverSends({ type: "GUESS_STATE", state: round });
    serverSends({ type: "TOO_LATE" });
    serverSends({ type: "GUESS_STATE", state: { ...round, answers: {} } });
    expect(screen.getByText(/時間到/)).toBeTruthy();
  });
});

describe("PlayPage: Guess TOO_LATE doesn't leak into the next game (/land-and-deploy review)", () => {
  const guess = (over: object = {}) => ({
    mode: "guess", phase: "guessing", players: { [PLAYER]: { name: "QA", score: 0, connected: true } },
    currentRound: { hasArtist: true, title: null, artist: null }, roundStart: Date.now(), timerSeconds: 60,
    answers: {}, totalRounds: 3, currentRoundIndex: 0, ...over,
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

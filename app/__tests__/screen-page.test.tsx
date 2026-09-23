import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { GameState, PublicLyricsGameState } from "@/lib/game";

// Regression: ISSUE (coverage gap) — app/room/[code]/screen/page.tsx shipped with zero tests.
// Found by /ship's coverage audit on 2026-09-22.

// Mock the socket + router the same way app/__tests__/play-page.test.tsx does: capture onMessage
// so tests can play the server's part.
let socketOpts: { onMessage: (e: MessageEvent) => void; onOpen?: () => void };
const sendSpy = vi.fn();
vi.mock("partysocket/react", () => ({
  default: (opts: typeof socketOpts) => {
    socketOpts = opts;
    return { send: sendSpy };
  },
}));
let searchParamsValue = new URLSearchParams("");
vi.mock("next/navigation", () => ({
  useParams: () => ({ code: "ABCD" }),
  useSearchParams: () => searchParamsValue,
}));

// MusicPlayer/LyricsPlayer's own video-loading behavior is already covered by their own test
// files — stub the default export so this page's own conditional-rendering logic is what's
// under test, but keep the real (pure, already-tested) helper exports LyricsPlayer provides.
vi.mock("@/components/MusicPlayer", () => ({
  default: (props: { phase: string; currentSong: { videoId: string } | null }) => (
    <div data-testid="music-player" data-phase={props.phase} data-video={props.currentSong?.videoId ?? ""} />
  ),
}));
vi.mock("@/components/LyricsPlayer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/LyricsPlayer")>();
  return {
    ...actual,
    default: (props: { videoId: string | null; playing: boolean }) => (
      <div data-testid="lyrics-player" data-video={props.videoId ?? ""} data-playing={String(props.playing)} />
    ),
  };
});
// Same reasoning — VictoryPlayer's own single-creation/autoplay-blocked behavior is covered by
// its own test file; here only the winner screen's wiring (that it's passed the right id) matters.
vi.mock("@/components/VictoryPlayer", () => ({
  default: (props: { videoId: string | null }) => <div data-testid="victory-player" data-video={props.videoId ?? ""} />,
}));

import ScreenPage from "@/app/room/[code]/screen/page";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

const lobbyState: GameState = {
  phase: "lobby", players: {}, targetCardCount: 10, currentRound: 0, playlistId: "", songs: [],
  currentSong: null, placements: {}, activePlayerId: null, hostId: "", hostClaimed: false, winner: null,
};

const guessingState: GameState = {
  ...lobbyState,
  phase: "guessing",
  currentRound: 2,
  players: { [P1]: { name: "Alice", cardCount: 1, timeline: [], connected: true } },
  activePlayerId: P1,
  currentSong: { id: "v1", videoId: "v1", title: "那些年", artist: "胡夏", year: 2012 },
};

function lyricsState(over: Partial<PublicLyricsGameState> = {}): PublicLyricsGameState {
  return {
    mode: "lyrics", phase: "guessing",
    players: { [P1]: { name: "Alice", score: 10, connected: true }, [P2]: { name: "Bob", score: 5, connected: true } },
    rounds: [],
    currentRound: { videoId: "", title: "那些年", artist: "胡夏", language: "zh-TW", lyricContext: "那些年錯過的__", blankSentence: null },
    roundStart: Date.now(), timerSeconds: 20, answers: {}, totalRounds: 3, currentRoundIndex: 0, consecutiveSkips: 0,
    ...over,
  } as PublicLyricsGameState;
}

function serverSends(msg: object) {
  act(() => { socketOpts.onMessage({ data: JSON.stringify(msg) } as MessageEvent); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T12:00:00Z"));
  sendSpy.mockClear();
  localStorage.clear();
  searchParamsValue = new URLSearchParams(""); // default: not the creator
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("ScreenPage: waiting / lobby", () => {
  it("shows the join QR and room code before any game starts", () => {
    render(<ScreenPage />);
    expect(screen.getByText(/掃描加入/)).toBeTruthy();
    expect(screen.getByText("ABCD")).toBeTruthy();
  });

  it("shows no player chips before anyone has joined", () => {
    render(<ScreenPage />);
    // Reassurance chips only render once state.players is non-empty (see lobbyState above).
    expect(screen.queryByText("A")).toBeNull(); // Alice's avatar initial, if it existed
  });

  it("shows a chip with each joined player's name as they join, while still in the lobby", () => {
    render(<ScreenPage />);
    serverSends({
      type: "STATE",
      state: { ...lobbyState, players: { [P1]: { name: "Alice", cardCount: 0, timeline: [], connected: true } } },
    });
    expect(screen.getByText("Alice")).toBeTruthy();
    // Still the waiting screen, not gameplay — the QR/join prompt stays visible alongside the chips.
    expect(screen.getByText(/掃描加入/)).toBeTruthy();
  });

  it("shows a chip per player once several have joined", () => {
    render(<ScreenPage />);
    serverSends({
      type: "STATE",
      state: {
        ...lobbyState,
        players: {
          [P1]: { name: "Alice", cardCount: 0, timeline: [], connected: true },
          [P2]: { name: "Bob", cardCount: 0, timeline: [], connected: true },
        },
      },
    });
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });

  it("shows the private manage-as-host link only for the connection that created the room", () => {
    searchParamsValue = new URLSearchParams("created=1");
    render(<ScreenPage />);
    const link = screen.getByTestId("manage-as-host-link");
    expect(link.getAttribute("href")).toBe("/room/ABCD/host");
  });

  it("hides the manage-as-host link for a connection that did not create the room", () => {
    render(<ScreenPage />); // searchParamsValue defaults to no ?created=1 (see beforeEach)
    expect(screen.queryByTestId("manage-as-host-link")).toBeNull();
  });

  // Outside-voice finding from /plan-eng-review: the private link must never resurface mid-game.
  it("hides the manage-as-host link once the game leaves the lobby, even for the creator", () => {
    searchParamsValue = new URLSearchParams("created=1");
    render(<ScreenPage />);
    serverSends({ type: "STATE", state: guessingState });
    expect(screen.queryByTestId("manage-as-host-link")).toBeNull();
  });

  // Cross-device host handoff (docs/designs, /plan-eng-review 2026-09-22): closes the
  // stale-tab race — once host is claimed from ANY device (hostClaimed: true), this creator
  // tab's own link disappears too, even though it's still in the lobby and still the creator.
  it("hides the manage-as-host link once host is claimed elsewhere, even while still in the lobby", () => {
    searchParamsValue = new URLSearchParams("created=1");
    render(<ScreenPage />);
    expect(screen.getByTestId("manage-as-host-link")).toBeTruthy();
    serverSends({ type: "STATE", state: { ...lobbyState, hostClaimed: true } });
    expect(screen.queryByTestId("manage-as-host-link")).toBeNull();
  });

  // Regression for TODOS.md P2 "Timeline mode exposes the real video id to all players" — the
  // screen must claim its screenId on connect, mode-independent, or it never becomes privileged
  // during a Timeline-mode game (which never sends GET_LYRICS_AUDIO). See handleJoinScreen.
  it("claims the screen credential on connect with its persisted screenId", () => {
    render(<ScreenPage />);
    act(() => socketOpts.onOpen?.());
    const sent = JSON.parse(sendSpy.mock.calls.at(-1)?.[0] as string);
    expect(sent.type).toBe("JOIN_SCREEN");
    expect(sent.screenId).toBe(localStorage.getItem("hitster_screen_id"));
    expect(sent.screenId).toBeTruthy();
  });
});

describe("ScreenPage: Timeline mode", () => {
  it("renders the video player and PlayerList during guessing, with the active player's turn", () => {
    render(<ScreenPage />);
    serverSends({ type: "STATE", state: guessingState });
    expect(screen.getByTestId("music-player").getAttribute("data-phase")).toBe("guessing");
    expect(screen.getByText(/Alice 的回合/)).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy(); // from PlayerList
  });

  // Coverage gap found by /ship's coverage audit: the redaction/privilege logic is tested at the
  // server boundary (party/index.test.ts), but nothing confirmed the client actually WIRES the
  // videoId it receives into MusicPlayer — this is the user-visible payoff of the whole fix.
  it("passes currentSong.videoId through to MusicPlayer once the server sends it", () => {
    render(<ScreenPage />);
    serverSends({ type: "STATE", state: guessingState });
    expect(screen.getByTestId("music-player").getAttribute("data-video")).toBe(guessingState.currentSong?.videoId);
  });

  it("shows the winner heading when the game ends", () => {
    render(<ScreenPage />);
    serverSends({ type: "STATE", state: { ...guessingState, phase: "ended", winner: P1 } });
    expect(screen.getByText(/Winner!/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Alice" })).toBeTruthy();
  });

  // Integration coverage gap found by /ship's audit: nothing verified the confetti/trophy/victory
  // music actually wire up on the winner screen, only that the winner's name renders.
  it("shows confetti, a trophy, and the victory music on the winner screen", () => {
    render(<ScreenPage />);
    serverSends({ type: "STATE", state: { ...guessingState, phase: "ended", winner: P1 } });
    expect(screen.getByText("🏆")).toBeTruthy();
    expect(screen.getByTestId("victory-player")).toBeTruthy();
    // The victory song is hardcoded in the page (VICTORY_VIDEO_ID), not server state — just prove
    // VictoryPlayer is actually mounted with a non-empty id, not silently passed null.
    expect(screen.getByTestId("victory-player").getAttribute("data-video")).not.toBe("");
  });
});

describe("ScreenPage: Lyrics mode", () => {
  it("shows the AI-preparing message during loading", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "loading", currentRound: null }) });
    expect(screen.getByText(/AI 正在準備歌詞/)).toBeTruthy();
  });

  it("shows the lyric context and a live countdown during guessing", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "guessing", roundStart: Date.now() - 15_000, timerSeconds: 20 }) });
    expect(screen.getByText(/那些年錯過的/)).toBeTruthy();
    expect(screen.getByText("05")).toBeTruthy(); // 20s timer, 15s elapsed -> 5 left, zero-padded
  });

  it("shows both players' scores during a round", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing" }) });
    expect(screen.getByText("Alice:")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.getByText("Bob:")).toBeTruthy();
  });

  it("shows the revealed answer and per-player results", () => {
    render(<ScreenPage />);
    serverSends({
      type: "LYRICS_STATE",
      state: lyricsState({
        phase: "results",
        currentRound: { videoId: "", title: "那些年", artist: "胡夏", language: "zh-TW", lyricContext: "那些年錯過的__", blankSentence: "大雨" },
        answers: { [P1]: { text: "大雨", ts: Date.now(), correct: true, points: 300 } },
      }),
    });
    expect(screen.getByText("大雨")).toBeTruthy();
    expect(screen.getByText("+300")).toBeTruthy();
    expect(screen.getByText("未作答")).toBeTruthy(); // Bob never answered
  });

  it("shows the leader as the winner when the game ends", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "ended", currentRound: null }) });
    expect(screen.getByText(/Lyrics Mode Over/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Alice" })).toBeTruthy(); // higher score
  });

  it("clears the countdown and returns to the waiting screen on LYRICS_ABORTED", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "guessing" }) });
    expect(screen.queryByText(/那些年錯過的/)).toBeTruthy();
    serverSends({ type: "LYRICS_ABORTED" });
    expect(screen.queryByText(/那些年錯過的/)).toBeNull();
    expect(screen.getByText(/掃描加入/)).toBeTruthy();
  });
});

describe("ScreenPage: audio request (needsLyricsAudio retry)", () => {
  it("requests audio with its own screenId once a round starts playing", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing" }) });
    const calls = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const req = calls.find((m) => m.type === "GET_LYRICS_AUDIO");
    expect(req).toBeDefined();
    expect(typeof req.screenId).toBe("string");
    expect(req.screenId.length).toBeGreaterThan(0);
  });

  it("does not re-request once the server has answered for the current round", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing", currentRoundIndex: 0 }) });
    sendSpy.mockClear();
    serverSends({ type: "LYRICS_AUDIO", videoId: "real-video-id", roundIndex: 0 });
    // A reply for the current round must not trigger another request.
    expect(sendSpy.mock.calls.filter((c) => String(c[0]).includes("GET_LYRICS_AUDIO"))).toHaveLength(0);
    expect(screen.getByTestId("lyrics-player").getAttribute("data-video")).toBe("real-video-id");
  });

  it("re-requests when a new round starts without a matching reply", () => {
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing", currentRoundIndex: 0 }) });
    serverSends({ type: "LYRICS_AUDIO", videoId: "v0", roundIndex: 0 });
    sendSpy.mockClear();
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing", currentRoundIndex: 1 }) });
    const calls = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(calls.some((m) => m.type === "GET_LYRICS_AUDIO")).toBe(true);
  });

  it("persists the same screenId across a request and a later reconnect-style remount", () => {
    const { unmount } = render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing" }) });
    const firstId = (sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string)).find((m) => m.type === "GET_LYRICS_AUDIO"))?.screenId;
    unmount();
    sendSpy.mockClear();
    render(<ScreenPage />);
    serverSends({ type: "LYRICS_STATE", state: lyricsState({ phase: "playing" }) });
    const secondId = (sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string)).find((m) => m.type === "GET_LYRICS_AUDIO"))?.screenId;
    expect(secondId).toBe(firstId); // localStorage-backed, not regenerated per mount
  });
});

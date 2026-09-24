import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { GameState } from "@/lib/game";

// Mock the socket + router: capture the page's onMessage so tests can play the server's part.
// Same pattern as app/__tests__/play-page.test.tsx.
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
}));

import HostPage from "@/app/room/[code]/host/page";

function serverSends(msg: object) {
  act(() => { socketOpts.onMessage({ data: JSON.stringify(msg) } as MessageEvent); });
}

// happy-dom (unlike jsdom/real browsers) doesn't auto-submit a form when a type="submit"
// button inside it is clicked — fire the form's submit event directly instead.
function clickStartGame() {
  const btn = screen.getByTestId("start-game-btn");
  fireEvent.submit(btn.closest("form")!);
}

const lobbyStateWithPlayer: GameState = {
  phase: "lobby", players: { p1: { name: "Alice", cardCount: 0, timeline: [], connected: true } },
  targetCardCount: 10, currentRound: 0, playlistId: "", songs: [], currentSong: null,
  placements: {}, activePlayerId: null, hostId: "host-uuid", hostClaimed: true, winner: null,
};

beforeEach(() => {
  sendSpy.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ entries: [] }) }));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const lobbyStateEmpty: GameState = { ...lobbyStateWithPlayer, players: {} };

/** Drives the page far enough to have a loaded Lyrics-mode playlist with a Haiku preview
 * ready and a joined player — the exact state the "Start Lyrics" button needs to be enabled. */
function loadLyricsPlaylistWithPlayer() {
  render(<HostPage />);
  // Real pages get an initial lobby STATE the instant the socket connects, before the host
  // does anything — without it, page.tsx's STATE handler treats the *next* lobby STATE (the
  // player-join broadcast below) as a "game just reset to lobby" transition and wipes
  // lyricsPreview/readySongs. Sending this first mirrors real connect order.
  serverSends({ type: "STATE", state: lobbyStateEmpty });
  fireEvent.click(screen.getByText("🎵 歌詞模式"));
  fireEvent.change(screen.getByPlaceholderText(/youtube.com\/playlist/), { target: { value: "hitster://cpop-test" } });
  fireEvent.click(screen.getByText("載入 Load"));
  serverSends({
    type: "PLAYLIST_READY", songCount: 2,
    songs: [{ videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 }, { videoId: "v2", title: "Song B", artist: "Artist B", year: 2001 }],
  });
  serverSends({
    type: "LYRICS_PREVIEW", loading: false,
    rounds: [
      { videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" },
      { videoId: "v2", title: "Song B", artist: "Artist B", language: "en", lyricContext: "Some ___", blankSentence: "thing" },
    ],
  });
  serverSends({ type: "STATE", state: lobbyStateWithPlayer });
}

describe("HostPage: Lyrics mode Start-Lyrics race (T2, docs/designs/full-page-focus-editor.md)", () => {
  it("hides the Ask AI box and makes fields read-only immediately after clicking Start, before lyricsState arrives", async () => {
    loadLyricsPlaylistWithPlayer();

    await waitFor(() => expect(screen.getByText(/^✨ Ask AI$/)).toBeTruthy());
    clickStartGame();

    // Server hasn't replied with LYRICS_STATE yet — the START_LYRICS_GAME send is the only
    // thing that's happened. Without the T2 fix, the table would still be editable here.
    const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent.some((m) => m.type === "START_LYRICS_GAME")).toBe(true);
    expect(screen.queryByText(/^✨ Ask AI$/)).toBeNull();
  });

  it("becomes editable again if the server rejects the start with an ERROR", async () => {
    loadLyricsPlaylistWithPlayer();
    await waitFor(() => expect(screen.getByText(/^✨ Ask AI$/)).toBeTruthy());
    clickStartGame();
    expect(screen.queryByText(/^✨ Ask AI$/)).toBeNull();

    serverSends({ type: "ERROR", error: "not_enough_songs" });

    await waitFor(() => expect(screen.getByText(/^✨ Ask AI$/)).toBeTruthy());
  });

  it("stays hidden once lyricsState arrives and locks the real deck in", async () => {
    loadLyricsPlaylistWithPlayer();
    await waitFor(() => expect(screen.getByText(/^✨ Ask AI$/)).toBeTruthy());
    clickStartGame();

    serverSends({
      type: "LYRICS_STATE",
      state: {
        mode: "lyrics", phase: "preview",
        players: { p1: { name: "Alice", score: 0, connected: true } },
        rounds: [{ videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" }],
        currentRound: null, roundStart: null, timerSeconds: 60, answers: {}, totalRounds: 1, currentRoundIndex: 0, consecutiveSkips: 0,
      },
    });

    expect(screen.queryByText(/^✨ Ask AI$/)).toBeNull();
  });
});

// T6 (docs/designs/full-page-focus-editor.md): the Lyrics Focus mode entry point must be
// gated exactly like the table/Ask-AI box — reachable only before "Start Lyrics" is ever
// clicked (lyricsState === null) and not mid-flight (pendingLyricsStart, T2).
describe("HostPage: Lyrics Focus mode entry point gating (T6)", () => {
  it("shows the Focus mode button once the preview is ready", async () => {
    loadLyricsPlaylistWithPlayer();
    await waitFor(() => expect(screen.getByText(/Focus 模式/)).toBeTruthy());
  });

  it("hides the Focus mode button once Start is clicked, before lyricsState arrives", async () => {
    loadLyricsPlaylistWithPlayer();
    await waitFor(() => expect(screen.getByText(/Focus 模式/)).toBeTruthy());
    clickStartGame();
    expect(screen.queryByText(/Focus 模式/)).toBeNull();
  });

  it("stays hidden once lyricsState arrives", async () => {
    loadLyricsPlaylistWithPlayer();
    await waitFor(() => expect(screen.getByText(/Focus 模式/)).toBeTruthy());
    clickStartGame();
    serverSends({
      type: "LYRICS_STATE",
      state: {
        mode: "lyrics", phase: "preview",
        players: { p1: { name: "Alice", score: 0, connected: true } },
        rounds: [{ videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" }],
        currentRound: null, roundStart: null, timerSeconds: 60, answers: {}, totalRounds: 1, currentRoundIndex: 0, consecutiveSkips: 0,
      },
    });
    expect(screen.queryByText(/Focus 模式/)).toBeNull();
  });
});

// Regression (host testing feedback): a song with no AI-generated lyricContext/blankSentence
// used to be silently excluded from the Ask-AI request entirely — so asking AI to fill in a
// song it couldn't auto-generate for always returned nothing, with no visible reason why.
describe("HostPage: Ask AI includes songs with no existing lyrics data (regression)", () => {
  it("sends every ready song in the PROPOSE_LYRIC_EDITS payload, including ones AI couldn't auto-generate for", async () => {
    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateEmpty });
    fireEvent.click(screen.getByText("🎵 歌詞模式"));
    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/playlist/), { target: { value: "hitster://cpop-test" } });
    fireEvent.click(screen.getByText("載入 Load"));
    serverSends({
      type: "PLAYLIST_READY", songCount: 3,
      songs: [
        { videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 },
        { videoId: "v2", title: "Song B (no data)", artist: "Artist B", year: 2001 },
      ],
    });
    // Only v1 gets a round back — v2 is the "AI couldn't confidently generate one" case.
    serverSends({
      type: "LYRICS_PREVIEW", loading: false,
      rounds: [{ videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" }],
    });
    serverSends({ type: "STATE", state: lobbyStateWithPlayer });

    await waitFor(() => expect(screen.getByText(/^✨ Ask AI$/)).toBeTruthy());

    const instructionInput = screen.getByPlaceholderText(/round 2's answer has a typo/);
    fireEvent.change(instructionInput, { target: { value: "give me the full chorus for Song B" } });
    fireEvent.click(screen.getByText(/^✨ Ask AI$/));

    const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const propose = sent.find((m) => m.type === "PROPOSE_LYRIC_EDITS");
    expect(propose).toBeDefined();
    const videoIds = propose.rounds.map((r: { videoId: string }) => r.videoId);
    expect(videoIds).toContain("v2"); // the no-data song — previously silently dropped
    expect(videoIds).toContain("v1");
  });
});

// Regression (TODOS.md P2): saving the same YouTube playlist URL again in a later session
// used to always create a brand-new library entry — the same playlist duplicated endlessly.
describe("HostPage: cross-session playlist dedup by source URL", () => {
  const sourceUrl = "https://www.youtube.com/playlist?list=PLdupe";

  it("skips the save POST and reuses the existing entry when sourceUrl already matches a saved playlist", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/parties/library/") && (!init || init.method === undefined)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ entries: [{ id: "existing-id", name: "Old Save", songCount: 2, sourceUrl }] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateEmpty });
    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/playlist/), { target: { value: sourceUrl } });
    fireEvent.click(screen.getByText("載入 Load"));
    serverSends({
      type: "PLAYLIST_READY", songCount: 2,
      songs: [{ videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 }, { videoId: "v2", title: "Song B", artist: "Artist B", year: 2001 }],
    });

    await waitFor(() => expect(screen.getByText("儲存播放清單")).toBeTruthy());
    fetchMock.mockClear();

    fireEvent.click(screen.getByText("儲存播放清單"));
    fireEvent.change(screen.getByPlaceholderText("播放清單名稱"), { target: { value: "Same playlist again" } });
    fireEvent.click(screen.getByText("儲存 (2)"));

    // No POST to /parties/playlist/... — the dedup check short-circuited before any network call.
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/parties/playlist/"), expect.anything());
    await waitFor(() => expect(screen.getByTitle("existing-id")).toBeTruthy());
  });
});

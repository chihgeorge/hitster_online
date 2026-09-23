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

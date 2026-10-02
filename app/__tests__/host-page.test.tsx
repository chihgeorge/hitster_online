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
const params = vi.hoisted(() => ({ code: "ABCD" }));
vi.mock("next/navigation", () => ({
  useParams: () => params,
}));

import HostPage from "@/app/room/[code]/host/page";
import { announceScreen } from "@/lib/screen-presence";

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
  phase: "lobby", players: { p1: { name: "Alice", timeline: [], connected: true } },
  targetCardCount: 10, currentRound: 0, playlistId: "", songs: [], currentSong: null,
  placements: {}, activePlayerId: null, hostId: "host-uuid", hostClaimed: true, winner: null,
};

beforeEach(() => {
  sendSpy.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ entries: [] }) }));
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
    type: "PLAYLIST_READY",
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

describe("HostPage: lobby vinyl background is lobby-only (DESIGN.md)", () => {
  const guess = (phase: string) => ({
    mode: "guess", phase, players: {}, currentRound: { hasArtist: true, title: null, artist: null },
    roundStart: null, timerSeconds: 60, answers: {}, totalRounds: 3, currentRoundIndex: 0,
  });
  it("shows the pattern in the lobby and drops it once a Guess game is running", () => {
    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateWithPlayer });
    expect(screen.getByTestId("host-root").className).toContain("bg-vinyl-pattern");
    serverSends({ type: "GUESS_STATE", state: guess("playing"), serverNow: Date.now() });
    expect(screen.getByTestId("host-root").className).not.toContain("bg-vinyl-pattern");
    serverSends({ type: "GUESS_ABORTED" });
    expect(screen.getByTestId("host-root").className).toContain("bg-vinyl-pattern");
  });

  it("keeps the pattern while a Lyrics game is still loading or in preview", () => {
    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateWithPlayer });
    const lyrics = (phase: string) => ({ ...guess(phase), mode: "lyrics", rounds: [], currentRound: null });
    serverSends({ type: "LYRICS_STATE", state: lyrics("loading"), serverNow: Date.now() });
    expect(screen.getByTestId("host-root").className).toContain("bg-vinyl-pattern");
    serverSends({ type: "LYRICS_STATE", state: lyrics("playing"), serverNow: Date.now() });
    expect(screen.getByTestId("host-root").className).not.toContain("bg-vinyl-pattern");
  });
});

describe("HostPage: loaded-playlist line matches the game mode", () => {
  const load = (modeLabel: string | null) => {
    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateEmpty });
    if (modeLabel) fireEvent.click(screen.getByText(modeLabel));
    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/playlist/), { target: { value: "hitster://cpop-test" } });
    fireEvent.click(screen.getByText("載入 Load"));
    serverSends({
      type: "PLAYLIST_READY",
      songs: [
        { videoId: "v1", title: "A", artist: "X", year: 2000 },
        { videoId: "v2", title: "B", artist: "X", year: 2001 },
        { videoId: "v3", title: "C", artist: "X", year: null },
      ],
    });
  };

  it("Timeline counts every song and says how many have a confirmed year", () => {
    load(null);
    expect(screen.getByText("已載入 — 3 首歌曲，2 首有確認年份")).toBeTruthy();
  });

  it("Lyrics mode doesn't talk about release years", () => {
    load("🎵 歌詞模式");
    expect(screen.getByText("已載入 — 3 首歌曲")).toBeTruthy();
    expect(screen.queryByText(/確認年份/)).toBeNull();
  });
});

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
        currentRound: null, roundStart: null, timerSeconds: 60, answers: {}, totalRounds: 1, currentRoundIndex: 0,
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
        currentRound: null, roundStart: null, timerSeconds: 60, answers: {}, totalRounds: 1, currentRoundIndex: 0,
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
      type: "PLAYLIST_READY",
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
      type: "PLAYLIST_READY",
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

// Guess mode start lifecycle (/ship review D3): a rejected start must not leave Start disabled.
describe("HostPage: Guess Mode start", () => {
  it("sends START_GUESS_GAME with the songs, disables Start until the reply, and re-enables on ERROR", () => {
    render(<HostPage />);
    serverSends({ type: "STATE", state: lobbyStateEmpty });
    fireEvent.click(screen.getByText("🎧 猜歌模式"));
    fireEvent.change(screen.getByPlaceholderText(/youtube.com\/playlist/), { target: { value: "hitster://cpop-test" } });
    fireEvent.click(screen.getByText("載入 Load"));
    serverSends({ type: "PLAYLIST_READY", songs: [{ videoId: "v1", title: "Song A", artist: "A", year: 2000 }, { videoId: "v2", title: "Song B", artist: "B", year: 2001 }] });
    serverSends({ type: "STATE", state: lobbyStateWithPlayer });
    clickStartGame();
    const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const start = sent.find((m) => m.type === "START_GUESS_GAME");
    expect(start?.songs).toHaveLength(2);
    expect((screen.getByTestId("start-game-btn") as HTMLButtonElement).disabled).toBe(true);
    serverSends({ type: "ERROR", error: "not_enough_songs" });
    expect((screen.getByTestId("start-game-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});

// Value: protects=each Lyrics/Timeline host button sends its own command (a swapped command silently stalls the game); fails_when=a hostSend("…") call site names the wrong command; why_new=Lyrics round buttons and Timeline Play Again had no test at any layer (Guess buttons and Reveal/Next are e2e-covered); seam=none
describe("HostPage: host step buttons send their command", () => {
  const round = { videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" };
  const lyrics = (phase: string) => ({
    type: "LYRICS_STATE", serverNow: Date.now(),
    state: {
      mode: "lyrics", phase, players: { p1: { name: "Alice", score: 0, connected: true, timeMs: 0 } },
      rounds: [round], currentRound: round, roundStart: phase === "guessing" ? Date.now() : null,
      timerSeconds: 60, answers: {}, totalRounds: 2, currentRoundIndex: 0,
    },
  });
  const lastSent = () => JSON.parse(sendSpy.mock.calls.at(-1)![0] as string);

  it("Lyrics confirm / Cut / Show Results / Next, and Timeline Play Again", () => {
    loadLyricsPlaylistWithPlayer();
    serverSends(lyrics("preview"));
    fireEvent.click(screen.getByTestId("start-game-btn"));
    expect(lastSent()).toEqual({ type: "CONFIRM_LYRICS_PREVIEW", hostId: expect.any(String) });

    serverSends(lyrics("playing"));
    fireEvent.click(screen.getByText(/Cut!/));
    expect(lastSent().type).toBe("START_LYRICS_ROUND");

    serverSends(lyrics("guessing"));
    fireEvent.click(screen.getByText(/Show Results/));
    expect(lastSent().type).toBe("SHOW_LYRICS_RESULTS");

    serverSends(lyrics("results"));
    fireEvent.click(screen.getByText(/Next Round/));
    expect(lastSent().type).toBe("NEXT_LYRICS_ROUND");

    serverSends({ type: "LYRICS_ABORTED" });
    serverSends({ type: "STATE", state: { ...lobbyStateWithPlayer, phase: "ended", winner: "p1" } });
    fireEvent.click(screen.getByText(/Play Again/));
    expect(lastSent()).toEqual({ type: "RESET_GAME", hostId: expect.any(String) });
  });
});

describe("HostPage: screen link", () => {
  it("shows the full screen URL as a link to one named screen tab, and keeps it after the game starts", async () => {
    render(<HostPage />);
    const link = await waitFor(() => screen.getByTestId("screen-link"));
    expect(link.getAttribute("href")).toBe("/room/ABCD/screen");
    expect(link.getAttribute("target")).toBe("hitster-screen-ABCD"); // named: repeat taps reuse one tab
    await waitFor(() => expect(link.getAttribute("aria-label")).toBe(`在電視掃描，或點此開啟大螢幕：${window.location.origin}/room/ABCD/screen`));
    await waitFor(() => expect(link.textContent).toContain(`${window.location.origin}/room/ABCD/screen`));
    serverSends({ type: "STATE", state: { ...lobbyStateWithPlayer, phase: "guessing" } });
    expect(screen.getByTestId("screen-link").getAttribute("href")).toBe("/room/ABCD/screen");
  });
});

describe("HostPage: screen link edges", () => {
  it("QR encodes the same full screen URL as the link, once origin is known", async () => {
    const QRCode = (await import("qrcode")).default;
    const spy = vi.spyOn(QRCode, "toDataURL");
    render(<HostPage />);
    await waitFor(() => screen.getByAltText("大螢幕 QR"));
    expect(spy.mock.calls.map((c) => c[0])).toContain(`${window.location.origin}/room/ABCD/screen`);
    expect(spy.mock.calls.every((c) => String(c[0]).startsWith(window.location.origin))).toBe(true); // never "" or a bare path
    expect(screen.getByTestId("screen-link").getAttribute("rel")).toBeNull(); // noopener would defeat the named tab
  });

  it("server render has no origin: placeholder instead of QR, link text is the bare path (hydration-safe)", async () => {
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(<HostPage />);
    expect(html).not.toContain("大螢幕 QR");
    expect(html).not.toContain(window.location.origin);
    expect(html).toMatch(/data-testid="screen-link"[^>]*>[\s\S]*>\/room\/ABCD\/screen(<!-- -->)? <span[^>]*>↗</);
  });
});

describe("HostPage: screen link reuses an open screen tab", () => {
  it("focuses an already-open screen tab instead of reloading it", async () => {
    const tab = { location: { pathname: "/room/ABCD/screen", href: "keep" }, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<HostPage />);
    fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
    expect(window.open).toHaveBeenCalledWith("", "hitster-screen-ABCD");
    expect(tab.location.href).toBe("keep"); // not navigated again
    expect(tab.focus).toHaveBeenCalled();
  });

  it("focuses, not reloads, when the room code is percent-encoded in the tab's pathname", async () => {
    params.code = "AB C";
    try {
      const tab = { location: { pathname: "/room/AB%20C/screen", href: "keep" }, focus: vi.fn() };
      vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      render(<HostPage />);
      fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
      expect(tab.location.href).toBe("keep");
      expect(tab.focus).toHaveBeenCalled();
    } finally {
      params.code = "ABCD";
    }
  });

  it("points a fresh tab at the screen page", async () => {
    const tab = { location: { pathname: "blank", href: "about:blank" }, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<HostPage />);
    fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
    expect(tab.location.href).toBe("/room/ABCD/screen");
  });

  // Host page reloaded/reopened: it's no longer the screen tab's opener, so window.open("", name)
  // makes a new blank tab even though a screen is already playing in another one.
  it("closes the new blank tab and says so when a screen is already open in a tab it can't reach", async () => {
    const stop = announceScreen("ABCD");
    try {
      const tab = { location: { pathname: "blank", href: "about:blank" }, focus: vi.fn(), close: vi.fn() };
      vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      render(<HostPage />);
      const link = await waitFor(() => screen.getByTestId("screen-link"));
      await new Promise((r) => setTimeout(r, 20)); // the screen answers the host's ping
      const notPrevented = fireEvent.click(link);
      expect(notPrevented).toBe(false);
      expect(tab.close).toHaveBeenCalled();
      expect(tab.location.href).toBe("about:blank"); // no second screen
      expect(screen.getByTestId("screen-elsewhere").textContent).toContain("already open in another tab");
    } finally {
      stop();
    }
  });

  it("still focuses the screen tab it can reach, even while that tab announces itself", async () => {
    const stop = announceScreen("ABCD");
    try {
      const tab = { location: { pathname: "/room/ABCD/screen", href: "keep" }, focus: vi.fn(), close: vi.fn() };
      vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
      render(<HostPage />);
      const link = await waitFor(() => screen.getByTestId("screen-link"));
      await new Promise((r) => setTimeout(r, 20));
      fireEvent.click(link);
      expect(tab.close).not.toHaveBeenCalled();
      expect(tab.focus).toHaveBeenCalled();
      expect(screen.queryByTestId("screen-elsewhere")).toBeNull();
    } finally {
      stop();
    }
  });
});

describe("HostPage: screen link when popups are blocked", () => {
  it("falls back to the plain link (default not prevented) when window.open returns null", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<HostPage />);
    let prevented: boolean | undefined;
    // Bubble listener runs after React's handler: record, then stop happy-dom actually navigating.
    const spyNav = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
    document.addEventListener("click", spyNav);
    fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
    document.removeEventListener("click", spyNav);
    expect(window.open).toHaveBeenCalledWith("", "hitster-screen-ABCD");
    expect(prevented).toBe(false); // browser follows href/target itself
  });

  it("prevents the default navigation when it handled the tab itself", async () => {
    const tab = { location: { pathname: "blank", href: "about:blank" }, focus: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<HostPage />);
    const notPrevented = fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
    expect(notPrevented).toBe(false);
    expect(tab.focus).toHaveBeenCalled();
  });
});

describe("HostPage: screen link edge clicks", () => {
  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }])(
    "leaves a modified click (%o) to the browser",
    async (mod) => {
      const open = vi.spyOn(window, "open");
      render(<HostPage />);
      const link = await waitFor(() => screen.getByTestId("screen-link"));
      // Stop happy-dom from actually navigating; record whether the page cancelled the default.
      let prevented: boolean | undefined;
      const stop = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault(); };
      document.addEventListener("click", stop);
      fireEvent.click(link, mod);
      document.removeEventListener("click", stop);
      expect(open).not.toHaveBeenCalled();
      expect(prevented).toBe(false);
    },
  );

  it("re-points a screen tab that moved to another origin instead of doing nothing", async () => {
    const tab = { focus: vi.fn(), location: { href: "https://www.youtube.com/watch" } };
    Object.defineProperty(tab.location, "pathname", { get: () => { throw new DOMException("cross-origin", "SecurityError"); } });
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<HostPage />);
    fireEvent.click(await waitFor(() => screen.getByTestId("screen-link")));
    expect(tab.location.href).toBe("/room/ABCD/screen");
    expect(tab.focus).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import MusicPlayer from "./MusicPlayer";
import type { Card } from "@/lib/game";

// Timeline-mode player: one persistent YouTube player for the component's lifetime, songs switch
// via loadVideoById (mirrors LyricsPlayer's pattern). See the root-cause comment in MusicPlayer.tsx —
// recreating `new YT.Player(...)` per song reused an already-consumed (detached) target element and
// silently produced a player with no video loaded, whenever the current song arrived redacted (empty
// videoId, not yet privileged) before the real one — i.e. /screen opened after the round had started.
const song = (videoId: string): Card => ({ id: videoId, videoId, title: "t", artist: "a", year: 2000 });
const w = window as unknown as { YT?: unknown; onYouTubeIframeAPIReady?: () => void };
const props = { phase: "guessing" as const };

// Mimics the real YouTube IFrame API: player methods only exist after onReady.
type Events = {
  onReady?: () => void;
  onAutoplayBlocked?: () => void;
  onStateChange?: (e: { data: number }) => void;
  onError?: (e: { data: number }) => void;
};
class FakePlayer {
  static instances: FakePlayer[] = [];
  events: Events;
  loadVideoById!: ReturnType<typeof vi.fn>;
  playVideo!: ReturnType<typeof vi.fn>;
  destroy = vi.fn();
  constructor(_el: unknown, opts: { events: Events }) {
    this.events = opts.events;
    FakePlayer.instances.push(this);
  }
  ready() {
    this.loadVideoById = vi.fn();
    this.playVideo = vi.fn();
    act(() => { this.events.onReady?.(); });
  }
}

const player = () => FakePlayer.instances[0];

beforeEach(() => {
  FakePlayer.instances = [];
  delete w.YT;
  delete w.onYouTubeIframeAPIReady;
  vi.spyOn(document.head, "appendChild").mockImplementation(((n: HTMLElement) => n) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete w.YT; });

describe("MusicPlayer", () => {
  it("creates one player and loads the current song once the API is ready", () => {
    render(<MusicPlayer currentSong={song("s1")} {...props} />);
    expect(FakePlayer.instances).toHaveLength(0);
    w.YT = { Player: FakePlayer };
    act(() => { w.onYouTubeIframeAPIReady!(); });
    expect(FakePlayer.instances).toHaveLength(1);
    player().ready();
    expect(player().loadVideoById).toHaveBeenCalledWith("s1");
  });

  it("does not touch the player before it is ready", () => {
    w.YT = { Player: FakePlayer };
    expect(() => render(<MusicPlayer currentSong={song("s1")} {...props} />)).not.toThrow();
  });

  it("creates no player if unmounted before the API loads", () => {
    const { unmount } = render(<MusicPlayer currentSong={song("s1")} {...props} />);
    unmount();
    w.YT = { Player: FakePlayer };
    act(() => { w.onYouTubeIframeAPIReady!(); });
    expect(FakePlayer.instances).toHaveLength(0);
  });

  it("does not throw when a not-yet-ready player (no destroy yet) is unmounted", () => {
    w.YT = { Player: class { constructor() { /* real API: no methods until onReady */ } } };
    const { unmount } = render(<MusicPlayer currentSong={song("s1")} {...props} />);
    expect(() => unmount()).not.toThrow();
  });

  it("destroys the player on unmount", () => {
    w.YT = { Player: FakePlayer };
    const { unmount } = render(<MusicPlayer currentSong={song("s1")} {...props} />);
    player().ready();
    unmount();
    expect(player().destroy).toHaveBeenCalled();
  });

  // Root-cause regression: this exact sequence (a redacted "" videoId on first mount, followed by the
  // real id once JOIN_SCREEN privileges the connection) is precisely how /screen mounts MusicPlayer
  // when opened after the round is already running. Before the fix this silently produced zero working
  // players. Now: no load attempt for "", exactly one player ever created, then loaded with the real id.
  it("never loads an empty (not-yet-privileged) videoId, and loads the real one once it arrives — single player, no recreation", () => {
    w.YT = { Player: FakePlayer };
    const { rerender } = render(<MusicPlayer currentSong={song("")} {...props} />);
    expect(FakePlayer.instances).toHaveLength(1);
    player().ready();
    expect(player().loadVideoById).not.toHaveBeenCalled(); // "" is not a real id — never attempted

    rerender(<MusicPlayer currentSong={song("REAL_ID")} {...props} />);
    expect(FakePlayer.instances).toHaveLength(1); // still the same player — no second construction
    expect(player().loadVideoById).toHaveBeenCalledWith("REAL_ID");
  });

  it("switches songs across rounds via loadVideoById without recreating the player", () => {
    w.YT = { Player: FakePlayer };
    const { rerender } = render(<MusicPlayer currentSong={song("round1")} {...props} />);
    player().ready();
    expect(player().loadVideoById).toHaveBeenCalledWith("round1");

    rerender(<MusicPlayer currentSong={song("round2")} {...props} />);
    expect(FakePlayer.instances).toHaveLength(1);
    expect(player().loadVideoById).toHaveBeenCalledWith("round2");

    // Same song again (e.g. a rerender with no round change) must not reload it.
    player().loadVideoById.mockClear();
    rerender(<MusicPlayer currentSong={song("round2")} {...props} />);
    expect(player().loadVideoById).not.toHaveBeenCalled();
  });

  // Regression: the YouTube API throws "Invalid video id" for a malformed id. Inside the effect that took
  // down the whole host page in round 2 of a saved-playlist game (found by the e2e suite).
  it("keeps the page alive when the YouTube API throws creating the player", () => {
    w.YT = { Player: class { constructor() { throw new Error("Invalid video id"); } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let view: ReturnType<typeof render> | undefined;
    // window.YT already exists, so whenYouTubeApiReady calls create() synchronously in the effect.
    expect(() => { view = render(<MusicPlayer currentSong={song("sv_0")} {...props} />); }).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(() => view!.unmount()).not.toThrow(); // cleanup after a failed init must not throw either
  });

  it("shows the can't-play message in the DOM when the embed reports an error, and clears it on a new song", () => {
    w.YT = { Player: FakePlayer };
    const { rerender } = render(<MusicPlayer currentSong={song("bad")} {...props} />);
    player().ready();
    expect(screen.queryByTestId("music-audio-error")).toBeNull();
    act(() => { player().events.onError?.({ data: 100 }); });
    expect(screen.getByTestId("music-audio-error")).toBeTruthy();
    // Failing hides the guessing overlay too — nothing should claim to be "playing" behind a dead player.
    expect(screen.queryByText(/聆聽中/)).toBeNull();
    // The error is scoped to the id that failed — a new song clears it even before the load resolves.
    rerender(<MusicPlayer currentSong={song("good-id-001")} {...props} />);
    expect(screen.queryByTestId("music-audio-error")).toBeNull();
    expect(FakePlayer.instances).toHaveLength(1); // still no recreation
  });

  // sync()'s own try/catch (loadVideoById throwing) is a distinct code path from create()'s
  // constructor-throw test above — a malformed id can pass construction fine and only fail on load.
  it("shows the can't-play message when loadVideoById itself throws", () => {
    w.YT = {
      Player: class {
        loadVideoById = vi.fn(() => { throw new Error("Invalid video id"); });
        constructor(_el: unknown, opts: { events: Events }) {
          // Simulates the real API calling onReady once the player is ready to load a video.
          opts.events.onReady?.();
        }
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<MusicPlayer currentSong={song("bad")} {...props} />);
    expect(warn).toHaveBeenCalled();
    expect(screen.getByTestId("music-audio-error")).toBeTruthy();
  });

  // The autoplay-blocked fallback added in this diff (mirrors LyricsPlayer's) had zero coverage.
  describe("autoplay blocked", () => {
    it("shows a tap-to-play button, hides the guessing overlay while blocked, and unblocks on click", () => {
      w.YT = { Player: FakePlayer };
      render(<MusicPlayer currentSong={song("s1")} {...props} />);
      player().ready();
      expect(screen.queryByTestId("music-play-btn")).toBeNull();

      act(() => { player().events.onAutoplayBlocked?.(); });
      expect(screen.getByTestId("music-play-btn")).toBeTruthy();
      expect(screen.queryByText(/聆聽中/)).toBeNull(); // overlay hidden — the button covers the video instead

      fireEvent.click(screen.getByTestId("music-play-btn"));
      expect(player().playVideo).toHaveBeenCalled();
      expect(screen.queryByTestId("music-play-btn")).toBeNull();
      expect(screen.getByText(/聆聽中/)).toBeTruthy(); // overlay is back once unblocked
    });

    it("clears the blocked flag once the video actually starts playing (onStateChange)", () => {
      w.YT = { Player: FakePlayer };
      render(<MusicPlayer currentSong={song("s1")} {...props} />);
      player().ready();
      act(() => { player().events.onAutoplayBlocked?.(); });
      expect(screen.getByTestId("music-play-btn")).toBeTruthy();

      act(() => { player().events.onStateChange?.({ data: 1 }); }); // 1 = playing
      expect(screen.queryByTestId("music-play-btn")).toBeNull();
    });

    it("does not show the blocked button once the song has already failed", () => {
      w.YT = { Player: FakePlayer };
      render(<MusicPlayer currentSong={song("bad")} {...props} />);
      player().ready();
      act(() => { player().events.onError?.({ data: 100 }); });
      act(() => { player().events.onAutoplayBlocked?.(); });
      expect(screen.getByTestId("music-audio-error")).toBeTruthy();
      expect(screen.queryByTestId("music-play-btn")).toBeNull();
    });
  });
});

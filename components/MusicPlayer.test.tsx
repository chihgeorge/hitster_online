import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import MusicPlayer from "./MusicPlayer";
import type { Card } from "@/lib/game";

// Timeline-mode player: covers the shared-loader refactor (create when ready, not after unmount, safe early unmount)
const song = (videoId: string): Card => ({ id: videoId, videoId, title: "t", artist: "a", year: 2000, yearSource: "manual" });
const w = window as unknown as { YT?: unknown; onYouTubeIframeAPIReady?: () => void };

class FakePlayer {
  static instances: FakePlayer[] = [];
  opts: { videoId: string };
  destroy = vi.fn();
  constructor(_el: unknown, opts: { videoId: string }) { this.opts = opts; FakePlayer.instances.push(this); }
}

const props = { phase: "guessing" as const, placementCount: 0, onReveal: () => {}, onNextRound: () => {} };

beforeEach(() => {
  FakePlayer.instances = [];
  delete w.YT;
  delete w.onYouTubeIframeAPIReady;
  vi.spyOn(document.head, "appendChild").mockImplementation(((n: HTMLElement) => n) as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete w.YT; });

describe("MusicPlayer", () => {
  it("creates the player for the current song once the API is ready", () => {
    render(<MusicPlayer currentSong={song("s1")} {...props} />);
    expect(FakePlayer.instances).toHaveLength(0);
    w.YT = { Player: FakePlayer };
    act(() => { w.onYouTubeIframeAPIReady!(); });
    expect(FakePlayer.instances).toHaveLength(1);
    expect(FakePlayer.instances[0].opts.videoId).toBe("s1");
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

  it("destroys a ready player on unmount", () => {
    w.YT = { Player: FakePlayer };
    const { unmount } = render(<MusicPlayer currentSong={song("s1")} {...props} />);
    unmount();
    expect(FakePlayer.instances[0].destroy).toHaveBeenCalled();
  });

  // Regression: the YouTube API throws "Invalid video id" for a malformed id. Inside the effect that took
  // down the whole host page in round 2 of a saved-playlist game (found by the e2e suite).
  it("keeps the page alive when the YouTube API throws for a malformed video id", () => {
    w.YT = { Player: class { constructor() { throw new Error("Invalid video id"); } } };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => render(<MusicPlayer currentSong={song("sv_0")} {...props} />)).not.toThrow();
  });

  it("recovers on the next song after a malformed one", () => {
    let calls = 0;
    w.YT = { Player: class { constructor() { if (calls++ === 0) throw new Error("Invalid video id"); FakePlayer.instances.push(this as never); } destroy = vi.fn(); } };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { rerender } = render(<MusicPlayer currentSong={song("bad")} {...props} />);
    expect(() => rerender(<MusicPlayer currentSong={song("good-id-001")} {...props} />)).not.toThrow();
    expect(FakePlayer.instances).toHaveLength(1);
  });
});

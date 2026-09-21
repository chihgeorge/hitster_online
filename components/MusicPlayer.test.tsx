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
});

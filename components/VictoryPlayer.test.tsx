import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import VictoryPlayer from "./VictoryPlayer";

// Same safe single-creation pattern as MusicPlayer/LyricsPlayer — see the root-cause comment in
// MusicPlayer.tsx for why a YT.Player must never be reused across constructions.
type Events = { onAutoplayBlocked?: () => void };
class FakePlayer {
  static instances: FakePlayer[] = [];
  events: Events;
  playVideo = vi.fn();
  destroy = vi.fn();
  constructor(_el: unknown, opts: { events: Events; videoId: string }) {
    this.events = opts.events;
    FakePlayer.instances.push(this);
  }
}

const w = window as unknown as { YT?: unknown };

beforeEach(() => {
  FakePlayer.instances = [];
  w.YT = { Player: FakePlayer };
  vi.spyOn(document.head, "appendChild").mockImplementation(((n: HTMLElement) => n) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete w.YT;
  delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
});

describe("VictoryPlayer", () => {
  it("renders nothing and creates no player when no song is configured", () => {
    const { container } = render(<VictoryPlayer videoId={null} />);
    expect(container.firstChild).toBeNull();
    expect(FakePlayer.instances).toHaveLength(0);
  });

  it("creates exactly one player for the configured song", () => {
    render(<VictoryPlayer videoId="vid-1" />);
    expect(FakePlayer.instances).toHaveLength(1);
  });

  it("shows a tap-to-play button when the browser blocks autoplay, and plays on click", () => {
    render(<VictoryPlayer videoId="vid-1" />);
    expect(screen.queryByTestId("victory-play-btn")).toBeNull();
    const instance = FakePlayer.instances[0];
    act(() => { instance.events.onAutoplayBlocked?.(); });
    expect(screen.getByTestId("victory-play-btn")).toBeTruthy();
    fireEvent.click(screen.getByTestId("victory-play-btn"));
    expect(instance.playVideo).toHaveBeenCalled();
    expect(screen.queryByTestId("victory-play-btn")).toBeNull();
  });

  it("destroys the player on unmount", () => {
    const { unmount } = render(<VictoryPlayer videoId="vid-1" />);
    const instance = FakePlayer.instances[0];
    unmount();
    expect(instance.destroy).toHaveBeenCalled();
  });

  it("keeps the page alive when the YouTube API throws creating the player", () => {
    w.YT = { Player: class { constructor() { throw new Error("Invalid video id"); } } };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => render(<VictoryPlayer videoId="bad-id" />)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("does not create a player if unmounted before the API is ready", () => {
    delete w.YT; // API not loaded yet — whenYouTubeApiReady queues create() instead of calling it
    const { unmount } = render(<VictoryPlayer videoId="vid-1" />);
    unmount();
    w.YT = { Player: FakePlayer };
    // Simulate the API finishing its load after unmount — create() must be a no-op (cancelled).
    (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady?.();
    expect(FakePlayer.instances).toHaveLength(0);
  });
});

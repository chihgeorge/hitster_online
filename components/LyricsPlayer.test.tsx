import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import LyricsPlayer from "./LyricsPlayer";

// Mimics the real YouTube IFrame API: player methods only exist after onReady.
type Events = { onReady?: () => void; onAutoplayBlocked?: () => void };
class FakePlayer {
  static instances: FakePlayer[] = [];
  events: Events;
  loadVideoById!: ReturnType<typeof vi.fn>;
  cueVideoById!: ReturnType<typeof vi.fn>;
  playVideo!: ReturnType<typeof vi.fn>;
  pauseVideo!: ReturnType<typeof vi.fn>;
  destroy = vi.fn();
  constructor(_el: unknown, opts: { events: Events }) {
    this.events = opts.events;
    FakePlayer.instances.push(this);
  }
  ready() {
    this.loadVideoById = vi.fn();
    this.cueVideoById = vi.fn();
    this.playVideo = vi.fn();
    this.pauseVideo = vi.fn();
    act(() => { this.events.onReady?.(); });
  }
}

const player = () => FakePlayer.instances[0];

beforeEach(() => {
  FakePlayer.instances = [];
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer };
});
afterEach(() => { cleanup(); delete (window as unknown as { YT?: unknown }).YT; });

describe("LyricsPlayer", () => {
  it("autoplays the round's video once the API is ready", () => {
    render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    expect(player().loadVideoById).toHaveBeenCalledWith("vid-1");
  });

  it("does not touch the player before it is ready", () => {
    expect(() => render(<LyricsPlayer videoId="vid-1" playing />)).not.toThrow();
  });

  it("pauses on Cut and resumes on results without reloading the same song", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId="vid-1" playing={false} />); // Cut -> guessing
    expect(player().pauseVideo).toHaveBeenCalled();
    rerender(<LyricsPlayer videoId="vid-1" playing />); // results
    expect(player().playVideo).toHaveBeenCalled();
    expect(player().loadVideoById).toHaveBeenCalledTimes(1);
  });

  it("loads the next song when the round changes", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId="vid-2" playing />);
    expect(player().loadVideoById).toHaveBeenLastCalledWith("vid-2");
  });

  it("pauses when there is no video (lobby, preview, ended)", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId={null} playing={false} />);
    expect(player().pauseVideo).toHaveBeenCalled();
  });

  it("offers a play button when the browser blocks autoplay, and plays on click", () => {
    render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    expect(screen.queryByTestId("lyrics-play-btn")).toBeNull();
    act(() => { player().events.onAutoplayBlocked?.(); });
    fireEvent.click(screen.getByTestId("lyrics-play-btn"));
    expect(player().playVideo).toHaveBeenCalled();
    expect(screen.queryByTestId("lyrics-play-btn")).toBeNull();
  });

  it("destroys the player on unmount", () => {
    const { unmount } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    unmount();
    expect(player().destroy).toHaveBeenCalled();
  });
});

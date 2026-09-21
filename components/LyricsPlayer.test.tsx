import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import LyricsPlayer, { lyricsAudioProps, needsLyricsAudio, isAudioPhase } from "./LyricsPlayer";

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

  it("cues (does not load) a new song that arrives while paused, then loads nothing extra on resume", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId="vid-2" playing={false} />);
    expect(player().cueVideoById).toHaveBeenCalledWith("vid-2");
    expect(player().loadVideoById).toHaveBeenCalledTimes(1);
    rerender(<LyricsPlayer videoId="vid-2" playing />);
    expect(player().playVideo).toHaveBeenCalled();
    expect(player().loadVideoById).toHaveBeenCalledTimes(1);
  });

  it("applies only the latest props when they change before the player is ready", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    rerender(<LyricsPlayer videoId="vid-2" playing={false} />);
    rerender(<LyricsPlayer videoId="vid-3" playing />);
    player().ready();
    expect(player().loadVideoById).toHaveBeenCalledTimes(1);
    expect(player().loadVideoById).toHaveBeenCalledWith("vid-3");
    expect(player().cueVideoById).not.toHaveBeenCalled();
  });

  it("does not load anything for a null videoId at mount", () => {
    render(<LyricsPlayer videoId={null} playing={false} />);
    player().ready();
    expect(player().loadVideoById).not.toHaveBeenCalled();
    expect(player().cueVideoById).not.toHaveBeenCalled();
  });

  it("hides the play button when blocked but the host has cut the song", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    act(() => { player().events.onAutoplayBlocked?.(); });
    expect(screen.getByTestId("lyrics-play-btn")).toBeTruthy();
    rerender(<LyricsPlayer videoId="vid-1" playing={false} />);
    expect(screen.queryByTestId("lyrics-play-btn")).toBeNull();
  });

  describe("when the YouTube API is not loaded yet", () => {
    const scripts = () => document.querySelectorAll('script[src*="youtube.com/iframe_api"]');
    const w = window as unknown as { YT?: unknown; onYouTubeIframeAPIReady?: () => void };
    // happy-dom logs an error when a real <script src> is attached; swallow the append and inspect the node instead.
    let appended: HTMLScriptElement[];
    beforeEach(() => {
      delete w.YT; delete w.onYouTubeIframeAPIReady; scripts().forEach((n) => n.remove());
      appended = [];
      vi.spyOn(document.head, "appendChild").mockImplementation(((n: HTMLScriptElement) => { appended.push(n); return n; }) as never);
    });
    afterEach(() => { vi.restoreAllMocks(); delete w.onYouTubeIframeAPIReady; scripts().forEach((n) => n.remove()); });

    it("injects the API script once, chains a previous ready callback, then creates the player", () => {
      const previous = vi.fn();
      w.onYouTubeIframeAPIReady = previous;
      render(<LyricsPlayer videoId="vid-1" playing />);
      expect(appended).toHaveLength(1);
      expect(appended[0].src).toContain("youtube.com/iframe_api");
      expect(FakePlayer.instances).toHaveLength(0);
      w.YT = { Player: FakePlayer };
      act(() => { w.onYouTubeIframeAPIReady!(); });
      expect(previous).toHaveBeenCalledTimes(1);
      player().ready();
      expect(player().loadVideoById).toHaveBeenCalledWith("vid-1");
    });

    it("does not add a duplicate script tag when one is already present", () => {
      const tag = document.createElement("script");
      tag.type = "text/plain";
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
      render(<LyricsPlayer videoId="vid-1" playing />);
      expect(appended).toHaveLength(0);
    });

    it("creates no player if unmounted before the API becomes ready", () => {
      const { unmount } = render(<LyricsPlayer videoId="vid-1" playing />);
      unmount();
      w.YT = { Player: FakePlayer };
      expect(() => act(() => { w.onYouTubeIframeAPIReady!(); })).not.toThrow();
      expect(FakePlayer.instances).toHaveLength(0);
    });
  });
});

// ── Host wiring helpers and review regressions ───────────────────────────────


describe("lyricsAudioProps (phase + host audio reply -> player props)", () => {
  const audio = { videoId: "vid-1", roundIndex: 2 };
  const at = (phase: string, roundIndex = 2) => ({ phase, currentRoundIndex: roundIndex });
  it.each([
    ["lobby", { videoId: null, playing: false }],
    ["loading", { videoId: null, playing: false }],
    ["preview", { videoId: null, playing: false }],
    ["playing", { videoId: "vid-1", playing: true }],
    ["guessing", { videoId: "vid-1", playing: false }], // Cut pauses
    ["results", { videoId: "vid-1", playing: true }],   // resumes on results
    ["ended", { videoId: null, playing: false }],
  ])("%s -> %j", (phase, expected) => {
    expect(lyricsAudioProps(at(phase), audio)).toEqual(expected);
  });

  it("ignores an audio reply that belongs to another round (stale after Next Round)", () => {
    expect(lyricsAudioProps(at("playing", 3), audio)).toEqual({ videoId: null, playing: false });
  });

  it("is silent without a game or without an audio reply", () => {
    expect(lyricsAudioProps(null, audio)).toEqual({ videoId: null, playing: false });
    expect(lyricsAudioProps(at("playing"), null)).toEqual({ videoId: null, playing: false });
    expect(lyricsAudioProps(at("playing"), { videoId: null, roundIndex: 2 })).toEqual({ videoId: null, playing: false });
  });
});

describe("LyricsPlayer: review fixes", () => {
  // Regression: after Play Again the same song could come first; it resumed mid-song instead of restarting
  it("reloads the same video after a null gap instead of resuming", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId={null} playing={false} />);
    rerender(<LyricsPlayer videoId="vid-1" playing />);
    expect(player().loadVideoById).toHaveBeenCalledTimes(2);
    expect(player().playVideo).not.toHaveBeenCalled();
  });

  // Regression: the real API has no destroy() until onReady; unmounting early must not throw
  it("unmounts safely before the player is ready (no destroy yet)", () => {
    const { unmount } = render(<LyricsPlayer videoId="vid-1" playing />);
    (player() as unknown as { destroy?: unknown }).destroy = undefined;
    expect(() => unmount()).not.toThrow();
  });

  it("gives every create its own connected element (StrictMode remounts)", () => {
    const targets: HTMLElement[] = [];
    (window as unknown as { YT: unknown }).YT = {
      Player: class extends FakePlayer {
        constructor(el: HTMLElement, opts: { events: Events }) { super(el, opts); targets.push(el); }
      },
    };
    const first = render(<LyricsPlayer videoId="vid-1" playing />);
    expect(targets[0].isConnected).toBe(true);
    first.unmount();
    render(<LyricsPlayer videoId="vid-1" playing />);
    expect(targets[1].isConnected).toBe(true);
    expect(targets[1]).not.toBe(targets[0]);
  });

  it("clears the blocked flag once the video is actually playing", () => {
    render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    act(() => { player().events.onAutoplayBlocked?.(); });
    expect(screen.getByTestId("lyrics-play-btn")).toBeTruthy();
    act(() => { player().events.onStateChange?.({ data: 1 }); });
    expect(screen.queryByTestId("lyrics-play-btn")).toBeNull();
  });
});

describe("LyricsPlayer: can't-play notice and fallback button", () => {
  it("tells the host when the video can't be played, and clears it for the next song", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    expect(screen.queryByTestId("lyrics-audio-error")).toBeNull();
    act(() => { player().events.onError?.({ data: 101 }); });
    expect(screen.getByTestId("lyrics-audio-error")).toBeTruthy();
    rerender(<LyricsPlayer videoId="vid-2" playing />);
    expect(screen.queryByTestId("lyrics-audio-error")).toBeNull();
  });

  it("keeps the fallback button visible via a fixed status region", () => {
    render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    act(() => { player().events.onAutoplayBlocked?.(); });
    expect(screen.getByRole("status").contains(screen.getByTestId("lyrics-play-btn"))).toBe(true);
  });
});

describe("needsLyricsAudio (when the host must ask for the video id)", () => {
  const at = (phase: string, roundIndex = 1) => ({ phase, currentRoundIndex: roundIndex });
  it("asks in a running round when there is no reply yet", () => {
    expect(needsLyricsAudio(at("playing"), null)).toBe(true);
  });
  it("asks again when the reply belongs to an earlier round", () => {
    expect(needsLyricsAudio(at("playing", 2), { videoId: "v", roundIndex: 1 })).toBe(true);
  });
  it("does not ask once this round has a reply, even a null one (no retry loop)", () => {
    expect(needsLyricsAudio(at("guessing"), { videoId: "v", roundIndex: 1 })).toBe(false);
    expect(needsLyricsAudio(at("guessing"), { videoId: null, roundIndex: 1 })).toBe(false);
  });
  it.each(["lobby", "loading", "preview", "ended"])("never asks in %s", (phase) => {
    expect(needsLyricsAudio(at(phase), null)).toBe(false);
  });
  it("never asks without a game", () => {
    expect(needsLyricsAudio(null, null)).toBe(false);
    expect(isAudioPhase(null)).toBe(false);
  });
});

describe("LyricsPlayer: notice and banner precedence", () => {
  it("shows only the error notice when an error arrives while the play button is showing", () => {
    render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    act(() => { player().events.onAutoplayBlocked?.(); });
    expect(screen.getByTestId("lyrics-play-btn")).toBeTruthy();
    act(() => { player().events.onError?.({ data: 150 }); });
    expect(screen.getByTestId("lyrics-audio-error")).toBeTruthy();
    expect(screen.queryByTestId("lyrics-play-btn")).toBeNull();
  });

  it("stays on the same player while the round changes (persistent across rounds)", () => {
    const { rerender } = render(<LyricsPlayer videoId="vid-1" playing />);
    player().ready();
    rerender(<LyricsPlayer videoId={null} playing={false} />); // between rounds, reply not here yet
    rerender(<LyricsPlayer videoId="vid-2" playing />);
    expect(FakePlayer.instances).toHaveLength(1);
    expect(player().loadVideoById).toHaveBeenLastCalledWith("vid-2");
  });
});

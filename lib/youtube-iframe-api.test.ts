import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { whenYouTubeApiReady } from "./youtube-iframe-api";

const w = window as unknown as { YT?: unknown; onYouTubeIframeAPIReady?: () => void };
let appended: HTMLElement[];

beforeEach(() => {
  delete w.YT;
  delete w.onYouTubeIframeAPIReady;
  appended = [];
  // Record injected script tags without letting happy-dom try to fetch them
  vi.spyOn(document.head, "appendChild").mockImplementation(((node: HTMLElement) => { appended.push(node); return node; }) as never);
  document.querySelectorAll('script[src*="youtube.com/iframe_api"]').forEach((n) => n.remove());
});
afterEach(() => { vi.restoreAllMocks(); });

describe("whenYouTubeApiReady", () => {
  it("runs the callback immediately, without a script tag, when the API is already loaded", () => {
    w.YT = { Player: class {} };
    const cb = vi.fn();
    whenYouTubeApiReady(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(0);
  });

  it("injects one script for two callers and fires both callbacks once, in order", () => {
    const order: string[] = [];
    whenYouTubeApiReady(() => order.push("a"));
    const tag = appended[0] as HTMLScriptElement;
    document.body.appendChild(tag); // so the second call sees the script already present
    whenYouTubeApiReady(() => order.push("b"));
    expect(appended).toHaveLength(1);
    expect(tag.src).toContain("youtube.com/iframe_api");
    w.YT = { Player: class {} };
    w.onYouTubeIframeAPIReady!();
    expect(order).toEqual(["a", "b"]);
  });

  it("chains a handler that was registered before it", () => {
    const earlier = vi.fn();
    w.onYouTubeIframeAPIReady = earlier;
    const cb = vi.fn();
    whenYouTubeApiReady(cb);
    w.YT = { Player: class {} };
    w.onYouTubeIframeAPIReady!();
    expect(earlier).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("still runs the callback when an earlier handler throws", () => {
    w.onYouTubeIframeAPIReady = () => { throw new Error("boom"); };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cb = vi.fn();
    whenYouTubeApiReady(cb);
    w.YT = { Player: class {} };
    w.onYouTubeIframeAPIReady!();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

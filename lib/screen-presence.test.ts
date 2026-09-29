import { describe, it, expect, vi, afterEach } from "vitest";
import { announceScreen, watchScreens, PING_GRACE_MS } from "./screen-presence";

// Real BroadcastChannel (Node's): messages are delivered asynchronously, across instances.
const tick = () => new Promise((r) => setTimeout(r, 20));
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((c) => c()); vi.useRealTimers(); });

function watch(code = "ABCD") {
  const onChange = vi.fn();
  cleanups.push(watchScreens(code, onChange));
  return { onChange, last: () => onChange.mock.calls.at(-1)?.[0] };
}

describe("screen presence", () => {
  it("sees a screen tab that was already open when the host page loads", async () => {
    cleanups.push(announceScreen("ABCD"));
    await tick();
    const w = watch(); // the ping is answered
    await tick();
    expect(w.last()).toBe(true);
  });

  it("sees a screen tab opened after the host page, and loses it when that tab closes", async () => {
    const w = watch();
    const stop = announceScreen("ABCD");
    await tick();
    expect(w.last()).toBe(true);
    stop();
    await tick();
    expect(w.last()).toBe(false);
  });

  it("stays open while any of several screen tabs is open", async () => {
    const w = watch();
    const a = announceScreen("ABCD");
    cleanups.push(announceScreen("ABCD"));
    await tick();
    a();
    await tick();
    expect(w.last()).toBe(true);
  });

  it("ignores screens for other rooms", async () => {
    const w = watch("ABCD");
    cleanups.push(announceScreen("WXYZ"));
    await tick();
    expect(w.onChange).not.toHaveBeenCalledWith(true);
  });

  it("a tab that stops answering (discarded, no pagehide) drops out after the grace period", async () => {
    const w = watch();
    // A tab that announced itself, then was discarded without a "gone" (no pagehide).
    const ghost = new BroadcastChannel("hitster-screen-ABCD");
    ghost.postMessage({ type: "here", id: "ghost" });
    ghost.close();
    await tick();
    expect(w.last()).toBe(true);
    window.dispatchEvent(new Event("focus")); // host tab regains focus → re-ping
    await tick();
    expect(w.last()).toBe(true); // still counted during the grace period
    await new Promise((r) => setTimeout(r, PING_GRACE_MS));
    expect(w.last()).toBe(false);
  });

  it("keeps a live screen through a re-ping", async () => {
    const w = watch();
    cleanups.push(announceScreen("ABCD"));
    await tick();
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, PING_GRACE_MS + 50));
    expect(w.last()).toBe(true);
  });

  it("re-announces when the screen page comes back from the back/forward cache", async () => {
    cleanups.push(announceScreen("ABCD"));
    const w = watch();
    await tick();
    window.dispatchEvent(new Event("pagehide"));
    await tick();
    expect(w.last()).toBe(false);
    const e = new Event("pageshow") as Event & { persisted: boolean };
    Object.defineProperty(e, "persisted", { value: true });
    window.dispatchEvent(e);
    await tick();
    expect(w.last()).toBe(true);
  });

  it("does nothing where BroadcastChannel is missing", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    try {
      const onChange = vi.fn();
      expect(() => { watchScreens("ABCD", onChange)(); announceScreen("ABCD")(); }).not.toThrow();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

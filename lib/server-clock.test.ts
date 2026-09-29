import { describe, it, expect, vi, afterEach } from "vitest";
import { syncServerClock, serverNow, resetServerClock } from "./server-clock";

afterEach(() => { resetServerClock(); vi.useRealTimers(); });

describe("server clock", () => {
  it("matches the device clock until the server reports its time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(serverNow()).toBe(1_000_000);
  });

  it("applies the server's offset and keeps it as time passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    syncServerClock(1_000_000 - 90_000); // device clock 90s fast
    expect(serverNow()).toBe(910_000);
    vi.advanceTimersByTime(5_000);
    expect(serverNow()).toBe(915_000);
  });

  it("ignores a missing or malformed server time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    syncServerClock(5_000);
    for (const bad of [undefined, null, "123", NaN, Infinity]) syncServerClock(bad);
    expect(serverNow()).toBe(5_000);
  });
});

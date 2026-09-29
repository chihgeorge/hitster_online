// Timed-round countdowns compare the server's roundStart with "now". A phone or TV whose clock is
// off would show the wrong time left (inputs hidden early, or TOO_LATE while time still shows), so
// every LYRICS_STATE / GUESS_STATE carries the server's clock and countdowns use serverNow().
// The offset ignores one-way latency, which only makes the device think slightly less time has
// passed — ANSWER_GRACE_MS on the server covers that.

let offsetMs = 0;

/** Records the server clock from a state message. Ignores anything that isn't a finite number. */
export function syncServerClock(serverNow: unknown) {
  if (typeof serverNow === "number" && Number.isFinite(serverNow)) offsetMs = serverNow - Date.now();
}

/** The current time on the server's clock, as best this device knows it. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** Tests only: forget the recorded offset. */
export function resetServerClock() {
  offsetMs = 0;
}

/**
 * The paid party (daily budget + shared AI cache, party/paid.ts) is only for the server's own
 * calls. The worker (party/server.ts) must turn every public request and socket away.
 */
import { test, expect } from "@playwright/test";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

test.describe("paid party is not public", () => {
  // Value: protects=nobody can spend the daily budget down or write fake cached answers; fails_when=the worker's paid gate is dropped; why_new=the gate moved from PartyKit's onBeforeRequest to party/server.ts; seam=none; no_claim=the HTTP 404s alone (PaidParty's own token check also 404s; the gate itself is unit-tested in party/room.test.ts), the token check inside PaidParty (paid.test.ts)
  test("HTTP and WebSocket to /parties/paid get nothing", async ({ request, page }) => {
    for (const path of ["/budget", "/cache/get", "/cache/put"]) {
      const res = await request.post(`http://${PARTYKIT_HOST}/parties/paid/global${path}`, { data: {} });
      expect(res.status()).toBe(404);
    }
    await page.goto("about:blank");
    const opened = await page.evaluate((url) => new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
    }), `ws://${PARTYKIT_HOST}/parties/paid/global`);
    expect(opened).toBe(false);
  });
});

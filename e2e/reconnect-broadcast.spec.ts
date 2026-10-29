/**
 * partysocket reconnects with the same `_pk`, which PartyServer uses as the connection id. The
 * old socket's close must not cut the reconnected one off from room broadcasts (party/server.ts).
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

function open(url: string, messages: string[] = []): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`ws failed: ${url}`));
    ws.onmessage = (e) => messages.push(String(e.data));
  });
}

test.describe("reconnect keeps broadcasts", () => {
  // Value: protects=a phone that reconnects mid-game (Wi-Fi drop, screen lock) still gets STATE; fails_when=broadcast goes back to PartyServer's id-keyed list; why_new=PartyKit didn't share that list; seam=none; no_claim=partysocket's own reconnect timing (simulated with two raw sockets, from Node, not a page)
  test("an old socket closing after its reconnect doesn't drop the new one", async () => {
    const room = `RC${randomUUID().slice(0, 4).toUpperCase()}`;
    const url = (pk: string) => `ws://${PARTYKIT_HOST}/parties/main/${room}?_pk=${pk}`;
    const pk = randomUUID();
    const old = await open(url(pk));
    const freshMessages: string[] = [];
    const fresh = await open(url(pk), freshMessages);
    old.close();
    await new Promise((r) => setTimeout(r, 500)); // wrangler dev doesn't echo the close back, so just give the server time
    freshMessages.length = 0;

    // A JOIN from someone else broadcasts STATE to the whole room.
    const other = await open(url(randomUUID()));
    other.send(JSON.stringify({ type: "JOIN", playerId: randomUUID(), name: "Bea" }));
    await expect.poll(() => freshMessages.some((m) => JSON.parse(m).type === "STATE"), { timeout: 3000 }).toBe(true);
    fresh.close();
    other.close();
  });
});

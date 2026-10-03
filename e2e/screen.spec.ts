/**
 * Host / players / TV split in Timeline mode (TODOS: e2e coverage for the 3-role flows).
 *
 * Only the TV may receive the playing song: its video id, and during guessing its id/title/artist
 * (a real card's id IS its video id; a title is a search away from the year). Only the host gets
 * its song lists (DIAGNOSTIC/PLAYLIST_READY). Nobody gets the deck. Only the TV may
 * load YouTube, a reopened TV tab gets the video back, and a TV tab on a player's phone gets
 * neither. Cards already in a timeline keep theirs: their year is public by then.
 */

import { test, expect, type Page } from "@playwright/test";
import { createRoomAsHost } from "./helpers";

type Song = { id: string; videoId: string; title: string; artist: string; year: number };

const YOUTUBE = /youtube\.com|ytimg\.com|googlevideo\.com/;
// Song lists only the host page reads: each carries the titles (DIAGNOSTIC also the years).
const HOST_ONLY = new Set(["DIAGNOSTIC", "PLAYLIST_READY"]);

/** Records, for one page, whether its game socket got any of the answer key or the playing video's id, and whether it hit YouTube. */
function watch(page: Page) {
  const seen = { answerKey: false, video: false, youtube: false };
  page.on("websocket", (ws) => ws.on("framereceived", (f) => {
    let msg: { type?: string; state?: { phase: string; currentSong: Song | null; songs: Song[]; playlistId?: string } };
    try { msg = JSON.parse(String(f.payload)); } catch { return; }
    if (msg.type && HOST_ONLY.has(msg.type)) seen.answerKey = true;
    if (msg.type !== "STATE" || !msg.state) return;
    const { phase, currentSong: cur, songs, playlistId } = msg.state;
    if (cur?.videoId) seen.video = true;
    if ((songs?.length ?? 0) > 0 || playlistId || cur?.videoId || (phase === "guessing" && (cur?.id || cur?.title || cur?.artist || cur?.year))) seen.answerKey = true;
  }));
  page.on("request", (r) => { if (YOUTUBE.test(r.url())) seen.youtube = true; });
  return seen;
}

async function joinRoom(page: Page, name: string, code: string) {
  await page.goto("/");
  await page.locator("[data-testid='join-name-input']").fill(name);
  await page.locator("[data-testid='join-code-input']").fill(code);
  await page.locator("[data-testid='join-room-btn']").click();
  await page.waitForURL(/\/room\/[A-Z]+\/play/);
}

test.describe("TV screen in Timeline mode", () => {
  // Value: protects=the year guess (a phone that gets the video id or title can look the song up) and the one-TV rule; fails_when=a phone gets the deck, a host-only song list, the video id, or the id/title/artist mid-guess, the host gets the video id, the host or play page mounts a video player, a reopened TV tab loses its screen claim, or a second device can claim the TV; why_new=party/index.test.ts checks redaction per message but nothing drives /screen, /host and /play together in a real browser; seam=none
  test("only the TV gets the video, a reopened TV tab gets it back, a player's phone can't become the TV", async ({ browser }) => {
    test.setTimeout(120_000);
    const [hostCtx, aliceCtx, bobCtx] = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    // Abort YouTube: the checks only need to know the TV asked for it, not a real stream.
    for (const c of [hostCtx, aliceCtx, bobCtx]) await c.route(YOUTUBE, (route) => route.abort());
    const [host, alice, bob] = await Promise.all([hostCtx.newPage(), aliceCtx.newPage(), bobCtx.newPage()]);
    // The TV shares the room creator's browser, as when opened from the host page's screen link.
    const screen = await hostCtx.newPage();
    const seen = { host: watch(host), alice: watch(alice), bob: watch(bob), screen: watch(screen) };

    try {
      const code = await createRoomAsHost(host);
      await screen.goto(`/room/${code}/screen`);
      // Loading the playlist claims the host before anyone joins, so the TV's claim (which carries
      // the host's id) holds however its socket races the players'.
      const url = host.locator('input[type="url"]');
      await url.click();
      await url.pressSequentially("hitster://cpop-test"); // real-song seed: START_GAME sends the host its song list (DIAGNOSTIC)
      await host.locator("[data-testid='load-playlist-btn']").click();
      await expect(host.getByText(/已載入/)).toBeVisible({ timeout: 5_000 });
      await joinRoom(alice, "Alice", code);
      await joinRoom(bob, "Bob", code);
      await expect(screen.getByText("Bob")).toBeVisible({ timeout: 10_000 });
      await host.locator("[data-testid='start-game-btn']").click();

      // ── Round 1 guessing: the TV shows whose turn it is and loads the video ──
      await expect(screen.getByText("第 1 回合 · Alice 的回合")).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => seen.screen.youtube, { timeout: 10_000 }).toBe(true);
      expect(seen.screen.video).toBe(true);

      await expect(alice.getByText(/Listen and place it on your timeline/i)).toBeVisible({ timeout: 15_000 });
      const drops = alice.locator("button").filter({ hasText: /^\+$/ });
      await drops.nth((await drops.count()) - 1).click();
      await alice.locator("[data-testid='place-btn']").click();
      await expect(host.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
      await host.locator("[data-testid='reveal-btn']").click();
      await expect(alice.getByText("答案 · The Answer")).toBeVisible({ timeout: 10_000 });

      // ── TV tab closed and reopened mid-game: same browser, so it's still the TV ──
      await screen.close();
      const screen2 = await hostCtx.newPage();
      const seen2 = watch(screen2);
      await screen2.goto(`/room/${code}/screen`);
      await expect(screen2.getByText("第 1 回合 · Alice 的回合")).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => seen2.video, { timeout: 10_000 }).toBe(true);
      await expect(screen2.locator("[data-testid='not-the-tv']")).toHaveCount(0);

      // ── A TV tab on Alice's phone: refused, told why, never gets the id ──
      const fake = await aliceCtx.newPage();
      const seenFake = watch(fake);
      await fake.goto(`/room/${code}/screen`);
      await expect(fake.locator("[data-testid='not-the-tv']")).toBeVisible({ timeout: 10_000 });
      await expect(fake.getByText("第 1 回合 · Alice 的回合")).toBeVisible();

      // ── Round 2: every page sees a fresh deal, so a late leak to the refused tab would show up ──
      await host.locator("[data-testid='next-round-btn']").click();
      await expect(fake.getByText("第 2 回合 · Bob 的回合")).toBeVisible({ timeout: 10_000 });
      await expect(screen2.getByText("第 2 回合 · Bob 的回合")).toBeVisible();
      await expect(bob.getByText(/Listen and place it on your timeline/i)).toBeVisible({ timeout: 15_000 });

      // Through two deals and a reveal, no phone got any answer key and nothing but the TV touched
      // YouTube. The refused TV tab still mounts its (empty) player, so its YouTube script may load.
      expect(seen.alice.answerKey).toBe(false);
      expect(seen.bob.answerKey).toBe(false);
      expect(seenFake.answerKey).toBe(false);
      expect(seen.host.video).toBe(false); // the host page never plays it, so only the TV holds it
      expect(seen.host.youtube || seen.alice.youtube || seen.bob.youtube).toBe(false);
    } finally {
      await Promise.all([hostCtx, aliceCtx, bobCtx].map((c) => c.close()));
    }
  });
});

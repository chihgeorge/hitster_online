/**
 * Guess Mode E2E (docs/designs/guess-mode-song-artist.md, eng-review test plan critical path):
 * host + two phones + TV screen play a round, then the host quits mid-game.
 *
 * The deck is shuffled server-side, so the test can't know each round's answer in advance —
 * correct-answer scoring is covered by lib/guess-scoring.test.ts and party/index.test.ts. This
 * spec proves the wiring across all three surfaces, that no seed title is on screen before the
 * reveal, and that quitting returns everyone to the lobby.
 */

import { test, expect, type Page } from "@playwright/test";
import { createRoomAsHost } from "./helpers";

const CPOP_TITLES = ["那些年", "可惜沒如果", "小幸運", "告白氣球", "光年之外", "你，好不好？", "體面", "年少有為"];

async function joinRoom(page: Page, name: string, code: string) {
  await page.goto("/");
  await page.locator("[data-testid='join-name-input']").fill(name);
  await page.locator("[data-testid='join-code-input']").fill(code);
  await page.locator("[data-testid='join-room-btn']").click();
  await page.waitForURL(/\/room\/[A-Z]+\/play/);
}

// The host's Play / Show Results / Next button ignores a tap within 400ms of the previous one
// (double-tap guard, components/GuessMode.tsx). Playwright taps faster than any human, so pace
// host taps like a person would.
async function hostTap(host: Page, testId: string) {
  await host.waitForTimeout(450);
  await host.locator(`[data-testid='${testId}']`).click();
}

async function expectNoTitle(page: Page) {
  const text = await page.locator("body").innerText();
  for (const t of CPOP_TITLES) expect(text, `answer "${t}" visible before reveal`).not.toContain(t);
}

test.describe("Guess Mode", () => {
  test("host, two phones and the TV play a round; the host can quit mid-game", async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
    const [host, alice, bob] = await Promise.all(ctx.map((c) => c.newPage()));
    // The TV tab shares the creator's browser, as when opened from the host page's screen link:
    // the room creator's device holds the screen role, which the video needs (see TODOS P2).
    const screen = await ctx[0].newPage();
    // Now that the TV holds the screen role it gets the video: block YouTube so a real stream
    // doesn't starve the specs running in parallel. The reveal checks only need the frame boxes.
    await ctx[0].route(/youtube\.com|ytimg\.com|googlevideo\.com/, (route) => route.abort());

    try {
      const code = await createRoomAsHost(host);
      await screen.goto(`/room/${code}/screen`);
      await joinRoom(alice, "Alice", code);
      await joinRoom(bob, "Bob", code);
      await expect(host.getByText("Bob")).toBeVisible({ timeout: 10_000 });

      // ── Set up Guess mode with 3 rounds ──────────────────────────────────
      await host.getByText("🎧 猜歌模式").click();
      const url = host.locator('input[type="url"]');
      await url.click();
      await url.pressSequentially("hitster://cpop-test");
      await host.locator("[data-testid='load-playlist-btn']").click();
      await expect(host.getByText(/已載入/)).toBeVisible({ timeout: 5_000 });
      await host.locator("[data-testid='rounds-range']").fill("3");
      await expect(host.getByText("回合數：3")).toBeVisible();
      await host.locator("[data-testid='start-game-btn']").click();

      // ── Waiting for the host to play ─────────────────────────────────────
      await expect(alice.getByText(/準備猜歌/)).toBeVisible({ timeout: 10_000 });
      await expect(screen.getByText(/準備好了嗎/)).toBeVisible({ timeout: 10_000 });
      await expect(host.getByText("第 1 / 3 回合 · 猜歌模式")).toBeVisible();

      // ── Guessing ──────────────────────────────────────────────────────────
      await hostTap(host, "guess-start-round-btn");
      await expect(alice.locator("[data-testid='guess-title-input']")).toBeVisible({ timeout: 10_000 });
      await expect(screen.getByText("🎧 這是什麼歌？")).toBeVisible();
      await expectNoTitle(screen);
      await expectNoTitle(alice);
      // The song's video stays hidden while players guess (it would show the answer).
      await expect(screen.locator("[data-testid='lyrics-player-frame']")).toHaveAttribute("aria-hidden", "true");

      await alice.locator("[data-testid='guess-title-input']").fill("不是這首歌");
      await alice.locator("[data-testid='guess-artist-input']").fill("路人甲");
      await alice.locator("[data-testid='guess-submit-btn']").click();
      await expect(alice.getByText(/已送出/)).toBeVisible();
      await expect(screen.getByText("1 / 2")).toBeVisible({ timeout: 10_000 });
      await expect(host.getByText(/已作答 1 \/ 2/)).toBeVisible();
      await expectNoTitle(bob); // Bob still guessing: Alice's answer and the real one both hidden

      // ── Reveal ───────────────────────────────────────────────────────────
      await hostTap(host, "guess-show-results-btn");
      const answer = alice.locator("[data-testid='guess-answer-title']");
      await expect(answer).toBeVisible({ timeout: 10_000 });
      const title = (await answer.innerText()).trim();
      expect(CPOP_TITLES).toContain(title);
      await expect(screen.getByText(title)).toBeVisible();
      await expect(alice.locator("[data-testid='guess-my-result']")).toContainText("沒猜中");
      await expect(bob.getByText("未作答")).toBeVisible();
      await expect(screen.getByText("未作答")).toBeVisible(); // Bob's row
      // The reveal shows the song's video in its reserved spot on the TV.
      const video = screen.locator("[data-testid='lyrics-player-frame']");
      await expect(video).toHaveAttribute("aria-hidden", "false");
      const [vBox, slotBox] = await Promise.all([video.boundingBox(), screen.locator("[data-testid='guess-video-slot']").boundingBox()]);
      expect(vBox && slotBox && [vBox.x - slotBox.x, vBox.y - slotBox.y, vBox.width - slotBox.width, vBox.height - slotBox.height].every((d) => Math.abs(d) < 2)).toBe(true);
      // The answer card sits under the video, on screen, with the title and artist fully shown.
      const card = screen.locator("[data-testid='guess-answer-card']");
      const cardBox = await card.boundingBox();
      const viewport = screen.viewportSize()!;
      expect(cardBox && vBox && cardBox.y >= vBox.y + vBox.height && cardBox.y + cardBox.height <= viewport.height).toBe(true);
      expect(await card.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      await expect(card).toContainText(title);

      // ── Next round, then quit ─────────────────────────────────────────────
      await hostTap(host, "guess-next-btn");
      await expect(host.getByText("第 2 / 3 回合 · 猜歌模式")).toBeVisible({ timeout: 10_000 });
      host.once("dialog", (d) => void d.accept());
      await host.locator("[data-testid='quit-game-btn']").click();

      await expect(host.getByText("設定遊戲 · Set Up Game")).toBeVisible({ timeout: 10_000 });
      await expect(alice.getByText("等待主持人開始遊戲…")).toBeVisible({ timeout: 10_000 });
      await expect(screen.getByText("掃描加入 · Scan to join")).toBeVisible({ timeout: 10_000 });
    } finally {
      await Promise.all(ctx.map((c) => c.close()));
    }
  });
});

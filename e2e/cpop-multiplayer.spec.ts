/**
 * C-pop multiplayer E2E test with metadata verification.
 *
 * Uses `hitster://cpop-test` playlist — 8 real C-pop songs with hardcoded YTM-sourced
 * metadata (correct music release years), no API calls, deterministic song order.
 *
 * Song order (sorted by year):
 *   0: 那些年  2012 → Alice's starting card
 *   1: 可惜沒如果 2014 → Bob's starting card (splice idx 1 after Alice's card removed)
 *   2: 小幸運  2015 → Round 1 current song (Alice's turn)
 *   3: 告白氣球 2016 → Round 2 current song (Bob's turn)
 *   4: 光年之外 2016 → Round 3 current song (Alice's turn)
 *   5: 你，好不好？2016
 *   6: 體面    2017
 *   7: 年少有為 2018
 *
 * Placement math (always append at end — years are ascending):
 *   Round 1 (Alice): 小幸運 2015 > 那些年 2012 → correct → Alice = [2012, 2015]
 *   Round 2 (Bob):   告白氣球 2016 > 可惜沒如果 2014 → correct → Bob = [2014, 2016]
 *   Round 3 (Alice): 光年之外 2016 > 小幸運 2015 → correct → Alice = [2012, 2015, 2016] → WINS
 */

import { test, expect, type Page } from "@playwright/test";

// ── helpers ──────────────────────────────────────────────────────────────────

async function joinRoom(page: Page, name: string, code: string) {
  await page.goto("/");
  await page.getByPlaceholder("你的名字").fill(name);
  await page.getByPlaceholder("房間代碼").fill(code);
  await page.getByRole("button", { name: /加入/i }).click();
  await page.waitForURL(/\/room\/[A-Z]+\/play/);
}

/** Place by appending at the end of the player's timeline. */
async function appendCard(page: Page) {
  await expect(page.getByText(/Listen and place it on your timeline/i)).toBeVisible({ timeout: 15_000 });
  const dropZones = page.locator("button").filter({ hasText: /^\+$/ });
  const count = await dropZones.count();
  await dropZones.nth(count - 1).click();
  await page.getByRole("button", { name: /確認放置/i }).click();
  await expect(page.getByRole("button", { name: /確認放置/i })).not.toBeVisible({ timeout: 5_000 });
}

/** Verify a page shows the spectator banner during guessing phase. */
async function expectSpectating(page: Page, activePlayerName: string) {
  await expect(
    page.getByText(new RegExp(`${activePlayerName}.*正在猜測中`)),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /確認放置/i })).not.toBeVisible();
}

// ── test ─────────────────────────────────────────────────────────────────────

test.describe("C-pop multiplayer with metadata verification", () => {
  test(
    "verifies YTM metadata in diagnostic panel and completes a full 3-round game",
    async ({ browser }) => {
      test.setTimeout(120_000);

      const hostCtx = await browser.newContext();
      const p1Ctx = await browser.newContext();
      const p2Ctx = await browser.newContext();

      const hostPage = await hostCtx.newPage();
      const p1Page = await p1Ctx.newPage();
      const p2Page = await p2Ctx.newPage();

      try {
        // ── 1. Create room ───────────────────────────────────────────────────
        await hostPage.goto("/");
        await hostPage.getByRole("button", { name: /Create a Room/i }).click();
        await hostPage.waitForURL(/\/room\/[A-Z]+\/host$/);
        const roomCode = hostPage.url().match(/\/room\/([A-Z]+)\/host$/)![1];
        expect(roomCode).toHaveLength(4);

        // ── 2. Alice joins first, Bob second ─────────────────────────────────
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText("Alice")).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByText("Bob")).toBeVisible({ timeout: 10_000 });

        // ── 3. Start game with C-pop test seed ───────────────────────────────
        const urlInput = hostPage.locator('input[type="url"]');
        await urlInput.click();
        await urlInput.pressSequentially("hitster://cpop-test");
        await hostPage.getByRole("button", { name: /Load/i }).click();
        await expect(hostPage.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });
        await hostPage.getByRole("button", { name: /Start Game/i }).click();

        // ── 4. Metadata verification ─────────────────────────────────────────
        // After game starts, the diagnostic panel button appears in the host page.
        const metadataToggle = hostPage.getByText(/歌曲資料/i);
        await expect(metadataToggle).toBeVisible({ timeout: 10_000 });
        await metadataToggle.click();

        // All 8 songs should be resolved (shown as "YT Music" source in the table).
        await expect(hostPage.getByText("YT Music").first()).toBeVisible();

        // Spot-check specific songs in the table (use .first() — titles appear in both the p card and td cell)
        await expect(hostPage.getByText("那些年").first()).toBeVisible();
        await expect(hostPage.getByText("2012").first()).toBeVisible();
        await expect(hostPage.getByText("體面").first()).toBeVisible();
        await expect(hostPage.getByText("2017").first()).toBeVisible();
        await expect(hostPage.getByText("年少有為").first()).toBeVisible();
        await expect(hostPage.getByText("2018").first()).toBeVisible();

        // ── 5. Round 1: Alice's turn ─────────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(
          hostPage.getByRole("button", { name: /reveal/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        await expect(
          hostPage.getByRole("button", { name: /next round/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /next round/i }).click();

        // ── 6. Round 2: Bob's turn ────────────────────────────────────────────
        await appendCard(p2Page);
        await expectSpectating(p1Page, "Bob");

        await expect(
          hostPage.getByRole("button", { name: /reveal/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        await expect(
          hostPage.getByRole("button", { name: /next round/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /next round/i }).click();

        // ── 7. Round 3: Alice's turn again ───────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(
          hostPage.getByRole("button", { name: /reveal/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // ── 8. Game over: Alice wins ──────────────────────────────────────────
        await expect(p1Page.getByRole("heading", { name: "WINNER!" })).toBeVisible({ timeout: 10_000 });
        await expect(p2Page.getByText(/Alice.*贏了/i)).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByText(/Winner!/i)).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByRole("heading", { name: "Alice" })).toBeVisible({ timeout: 10_000 });
      } finally {
        await hostCtx.close();
        await p1Ctx.close();
        await p2Ctx.close();
      }
    },
  );
});

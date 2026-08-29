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
  await page.getByRole("button", { name: /join a room/i }).click();
  await page.getByPlaceholder(/your name/i).fill(name);
  await page.getByPlaceholder(/room code/i).fill(code);
  await page.getByRole("button", { name: /^join$/i }).click();
  await page.waitForURL(/\/room\/[A-Z]+\/play/);
}

/** Place by appending at the end of the player's timeline. */
async function appendCard(page: Page) {
  await expect(page.getByText(/tap a position/i)).toBeVisible({ timeout: 15_000 });
  const dropZones = page.getByText("+ Place here");
  const count = await dropZones.count();
  await dropZones.nth(count - 1).click();
  await page.getByRole("button", { name: "Place here →" }).click();
  await expect(page.getByText(/host will reveal/i)).toBeVisible({ timeout: 5_000 });
}

/** Verify a page shows the spectator banner during guessing phase. */
async function expectSpectating(page: Page, activePlayerName: string) {
  await expect(
    page.getByText(new RegExp(`${activePlayerName}.*guessing`, "i")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("+ Place here")).not.toBeVisible();
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
        await hostPage.getByRole("button", { name: /create a room/i }).click();
        await hostPage.waitForURL(/\/room\/[A-Z]+\/host$/);
        const roomCode = hostPage.url().match(/\/room\/([A-Z]+)\/host$/)?.[1]!;
        expect(roomCode).toHaveLength(4);

        // ── 2. Alice joins first, Bob second ─────────────────────────────────
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText(/2 players/i)).toBeVisible({ timeout: 10_000 });

        // ── 3. Start game with C-pop test seed ───────────────────────────────
        await hostPage.getByPlaceholder(/youtube/i).fill("hitster://cpop-test");
        await hostPage.getByRole("button", { name: /start game/i }).click();

        // Wait for game to enter guessing phase (seed is instant — no API calls).
        await hostPage.waitForFunction(
          () => !document.querySelector("[data-testid='starting']"),
          null,
          { timeout: 10_000 },
        ).catch(() => {}); // ok if the attribute isn't used — just wait for state transition

        // ── 4. Metadata verification ─────────────────────────────────────────
        // The cpop-test seed broadcasts a DIAGNOSTIC message with 8 songs.
        // The host page shows a collapsible "Song metadata" panel after game starts.
        const metadataToggle = hostPage.getByText(/song metadata/i);
        await expect(metadataToggle).toBeVisible({ timeout: 10_000 });
        await metadataToggle.click();

        // All 8 songs should be resolved (shown as "YT Music" source in the table).
        await expect(hostPage.getByText("8")).toBeVisible(); // "8/8 years resolved"
        await expect(hostPage.getByText("YT Music").first()).toBeVisible();

        // Spot-check specific songs and years in the table.
        await expect(hostPage.getByText("那些年")).toBeVisible();
        await expect(hostPage.getByText("2012").first()).toBeVisible();
        await expect(hostPage.getByText("體面")).toBeVisible();
        await expect(hostPage.getByText("2017").first()).toBeVisible();
        await expect(hostPage.getByText("年少有為")).toBeVisible();
        await expect(hostPage.getByText("2018").first()).toBeVisible();

        // ── 5. Round 1: Alice's turn ─────────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(
          hostPage.getByRole("button", { name: /1 placed/i }),
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
          hostPage.getByRole("button", { name: /1 placed/i }),
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
          hostPage.getByRole("button", { name: /1 placed/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // ── 8. Game over: Alice wins ──────────────────────────────────────────
        await expect(p1Page.getByText(/you won/i)).toBeVisible({ timeout: 10_000 });
        await expect(
          p2Page.getByRole("heading", { name: /winner.*alice/i }),
        ).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByText(/winner!/i)).toBeVisible({ timeout: 10_000 });
        await expect(
          hostPage.getByRole("heading", { name: "Alice" }),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await hostCtx.close();
        await p1Ctx.close();
        await p2Ctx.close();
      }
    },
  );
});

/**
 * Two-player full-game E2E test.
 *
 * Uses `hitster://test` playlist — 20 deterministic songs (years 1960, 1963, 1966, …),
 * no shuffle, targetCardCount = 3.
 *
 * Turn-based rule: each round only the active player guesses; the other spectates.
 * Active player rotates round-robin in join order.
 *
 * Seed math:
 *   Alice (joins first)  → starting card 1960
 *   Bob   (joins second) → starting card 1966
 *   Round 1 (Alice's turn): song 1963 — Alice appends → correct → Alice = 2 cards
 *   Round 2 (Bob's turn):   song 1969 — Bob  appends → correct → Bob  = 2 cards
 *   Round 3 (Alice's turn): song 1972 — Alice appends → correct → Alice = 3 cards → WINS
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

/** Place by appending to the end of the player's timeline (always correct with ascending years). */
async function appendCard(page: Page) {
  await expect(page.getByText(/tap a position/i)).toBeVisible({ timeout: 15_000 });
  const dropZones = page.getByText("+ Place here");
  const count = await dropZones.count();
  await dropZones.nth(count - 1).click();
  await page.getByRole("button", { name: "Place here →" }).click();
  await expect(page.getByText(/host will reveal/i)).toBeVisible({ timeout: 5_000 });
}

/** Verify a page shows the spectator banner (not the placement UI) during guessing. */
async function expectSpectating(page: Page, activePlayerName: string) {
  await expect(
    page.getByText(new RegExp(`${activePlayerName}.*guessing`, "i")),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("+ Place here")).not.toBeVisible();
}

// ── test ─────────────────────────────────────────────────────────────────────

test.describe("Two-player full game", () => {
  test(
    "players take turns guessing each round, and the first to reach the target card count wins",
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

        // ── 2. Alice joins first, then Bob (order determines starting cards) ─
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText(/2 players/i)).toBeVisible({ timeout: 10_000 });

        // ── 3. Start game with deterministic test seed ────────────────────────
        await hostPage.getByPlaceholder(/youtube/i).fill("hitster://test");
        await hostPage.getByRole("button", { name: /start game/i }).click();

        // ── Round 1: Alice's turn ─────────────────────────────────────────────
        // Alice sees placement UI; Bob sees spectator banner
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        // Host: 1 placement received — reveal enabled
        await expect(
          hostPage.getByRole("button", { name: /1 placed/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // Alice now has 2 cards; no winner yet
        await expect(
          hostPage.getByRole("button", { name: /next round/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /next round/i }).click();

        // ── Round 2: Bob's turn ───────────────────────────────────────────────
        // Bob sees placement UI; Alice sees spectator banner
        await appendCard(p2Page);
        await expectSpectating(p1Page, "Bob");

        await expect(
          hostPage.getByRole("button", { name: /1 placed/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // Bob now has 2 cards; still no winner
        await expect(
          hostPage.getByRole("button", { name: /next round/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /next round/i }).click();

        // ── Round 3: Alice's turn again ───────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(
          hostPage.getByRole("button", { name: /1 placed/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // ── 4. Game over: Alice wins with 3 cards ─────────────────────────────
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

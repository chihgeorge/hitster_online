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
  await page.getByPlaceholder("你的名字").fill(name);
  await page.getByPlaceholder("房間代碼").fill(code);
  await page.getByRole("button", { name: /加入/i }).click();
  await page.waitForURL(/\/room\/[A-Z]+\/play/);
}

/** Place by appending to the end of the player's timeline (always correct with ascending years). */
async function appendCard(page: Page) {
  // Wait for the "Now Playing" banner — signals it's this player's turn to guess
  await expect(page.getByText(/Listen and place it on your timeline/i)).toBeVisible({ timeout: 15_000 });
  // Click the last "+" drop-zone button (appending at the end)
  const dropZones = page.locator("button").filter({ hasText: /^\+$/ });
  const count = await dropZones.count();
  await dropZones.nth(count - 1).click();
  // Confirm placement
  await page.getByRole("button", { name: /確認放置/i }).click();
  // CTA bar disappears when server ACKs placement (canPlace becomes false)
  await expect(page.getByRole("button", { name: /確認放置/i })).not.toBeVisible({ timeout: 5_000 });
}

/** Verify a page shows the spectator notice (not the placement UI) during guessing. */
async function expectSpectating(page: Page, activePlayerName: string) {
  await expect(
    page.getByText(new RegExp(`${activePlayerName}.*正在猜測中`)),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /確認放置/i })).not.toBeVisible();
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
        await hostPage.getByRole("button", { name: /Create a Room/i }).click();
        await hostPage.waitForURL(/\/room\/[A-Z]+\/host$/);
        const roomCode = hostPage.url().match(/\/room\/([A-Z]+)\/host$/)![1];
        expect(roomCode).toHaveLength(4);

        // ── 2. Alice joins first, then Bob (order determines starting cards) ─
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText("Alice")).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByText("Bob")).toBeVisible({ timeout: 10_000 });

        // ── 3. Start game with deterministic test seed ────────────────────────
        const urlInput = hostPage.locator('input[type="url"]');
        await urlInput.click();
        await urlInput.pressSequentially("hitster://test");
        await hostPage.getByRole("button", { name: /Load/i }).click();
        await expect(hostPage.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });
        await hostPage.getByRole("button", { name: /Start Game/i }).click();

        // ── Round 1: Alice's turn ─────────────────────────────────────────────
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

        // ── Round 2: Bob's turn ───────────────────────────────────────────────
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

        // ── Round 3: Alice's turn again ───────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(
          hostPage.getByRole("button", { name: /reveal/i }),
        ).toBeVisible({ timeout: 10_000 });
        await hostPage.getByRole("button", { name: /reveal/i }).click();

        // ── 4. Game over: Alice wins with 3 cards ─────────────────────────────
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

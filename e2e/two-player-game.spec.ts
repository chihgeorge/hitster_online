/**
 * Two-player full-game E2E tests.
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

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createRoomAsHost } from "./helpers";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";
const PARTY_URL = (id: string) => `http://${PARTYKIT_HOST}/parties/playlist/${id}`;

// ── helpers ──────────────────────────────────────────────────────────────────

async function joinRoom(page: Page, name: string, code: string) {
  await page.goto("/");
  await page.locator("[data-testid='join-name-input']").fill(name);
  await page.locator("[data-testid='join-code-input']").fill(code);
  await page.locator("[data-testid='join-room-btn']").click();
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
  await page.locator("[data-testid='place-btn']").click();
  // CTA bar disappears when server ACKs placement (canPlace becomes false)
  await expect(page.locator("[data-testid='place-btn']")).not.toBeVisible({ timeout: 5_000 });
}

/** Verify a page shows the spectator notice (not the placement UI) during guessing. */
async function expectSpectating(page: Page, activePlayerName: string) {
  await expect(
    page.getByText(new RegExp(`${activePlayerName}.*正在猜測中`)),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-testid='place-btn']")).not.toBeVisible();
}

// ── test ─────────────────────────────────────────────────────────────────────

/**
 * Create a saved playlist via the HTTP API and return its ID.
 * Avoids needing to go through the host UI save flow in each test.
 */
async function createSavedPlaylist(request: APIRequestContext): Promise<string> {
  const id = crypto.randomUUID();
  const songs = Array.from({ length: 20 }, (_, i) => ({
    videoId: `svid${String(i).padStart(7, "0")}`, // 11 chars like a real YouTube id; the player API throws on malformed ids
    title: `Saved Song ${1960 + i * 3}`,
    artist: "Saved Artist",
    year: 1960 + i * 3,
  }));
  const res = await request.post(PARTY_URL(id), {
    data: { ownerHostId: "e2e-host", name: "E2E Saved", songs },
  });
  if (res.status() !== 201) throw new Error(`Failed to create playlist: ${res.status()}`);
  return id;
}

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
        const roomCode = await createRoomAsHost(hostPage);

        // ── 2. Alice joins first, then Bob (order determines starting cards) ─
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText("Alice")).toBeVisible({ timeout: 10_000 });
        await expect(hostPage.getByText("Bob")).toBeVisible({ timeout: 10_000 });

        // ── 3. Start game with deterministic test seed ────────────────────────
        const urlInput = hostPage.locator('input[type="url"]');
        await urlInput.click();
        await urlInput.pressSequentially("hitster://test");
        await hostPage.locator("[data-testid='load-playlist-btn']").click();
        await expect(hostPage.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });
        await hostPage.locator("[data-testid='start-game-btn']").click();

        // ── Round 1: Alice's turn ─────────────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();

        await expect(hostPage.locator("[data-testid='next-round-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='next-round-btn']").click();

        // ── Round 2: Bob's turn ───────────────────────────────────────────────
        await appendCard(p2Page);
        await expectSpectating(p1Page, "Bob");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();

        await expect(hostPage.locator("[data-testid='next-round-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='next-round-btn']").click();

        // ── Round 3: Alice's turn again ───────────────────────────────────────
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();

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

test.describe("Two-player game using saved playlist", () => {
  test(
    "game runs correctly when loaded from a saved playlist (not hitster://test seed)",
    async ({ browser, request }) => {
      test.setTimeout(120_000);

      // Create the saved playlist via API — no UI save flow needed
      const playlistId = await createSavedPlaylist(request);

      const hostCtx = await browser.newContext();
      const p1Ctx = await browser.newContext();
      const p2Ctx = await browser.newContext();

      const hostPage = await hostCtx.newPage();
      const p1Page = await p1Ctx.newPage();
      const p2Page = await p2Ctx.newPage();

      try {
        // ── 1. Create room ───────────────────────────────────────────────────
        const roomCode = await createRoomAsHost(hostPage);

        // ── 2. Both players join ─────────────────────────────────────────────
        await joinRoom(p1Page, "Alice", roomCode);
        await joinRoom(p2Page, "Bob", roomCode);
        await expect(hostPage.getByText("Alice")).toBeVisible({ timeout: 10_000 });

        // ── 3. Host loads the saved playlist by pasting its ID ───────────────
        const loadInput = hostPage.locator("[data-testid='load-by-id-input']");
        await loadInput.fill(playlistId);
        await loadInput.press("Enter");
        await expect(hostPage.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });

        // ── 4. Start game and complete round 1 (Alice's turn) ────────────────
        await hostPage.locator("[data-testid='start-game-btn']").click();

        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();

        // Round result: reveal panel appears on host
        await expect(hostPage.locator("[data-testid='next-round-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='next-round-btn']").click();

        // ── 5. Round 2 (Bob's turn) ──────────────────────────────────────────
        await appendCard(p2Page);
        await expectSpectating(p1Page, "Bob");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();
        await expect(hostPage.locator("[data-testid='next-round-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='next-round-btn']").click();

        // ── 6. Round 3 (Alice's turn) — the game keeps going ─────────────────
        // Unlike the hitster://test seed (forced 3-card win), a saved playlist uses the host's win target
        // (slider minimum 5), so nobody wins yet: assert the game carries on into round 4 instead.
        await appendCard(p1Page);
        await expectSpectating(p2Page, "Alice");

        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
        await hostPage.locator("[data-testid='reveal-btn']").click();
        await expect(hostPage.locator("[data-testid='next-round-btn']")).toBeVisible({ timeout: 10_000 });
        await expect(p1Page.getByRole("heading", { name: "WINNER!" })).not.toBeVisible();
        await hostPage.locator("[data-testid='next-round-btn']").click();

        // ── 7. Round 4 (Bob's turn) starts ───────────────────────────────────
        await expectSpectating(p1Page, "Bob");
        await expect(hostPage.locator("[data-testid='reveal-btn']")).toBeVisible({ timeout: 10_000 });
      } finally {
        await hostCtx.close();
        await p1Ctx.close();
        await p2Ctx.close();
      }
    },
  );
});

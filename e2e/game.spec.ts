import { test, expect } from "@playwright/test";
import { createRoomAsHost } from "./helpers";

test.describe("Landing page", () => {
  test("shows the HITSTER! heading and room entry controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /HITSTER/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create a Room/i })).toBeVisible();
    await expect(page.locator("[data-testid='join-code-input']")).toBeVisible();
  });

  test("creates a room and navigates to host page with 4-char code", async ({ page }) => {
    const roomCode = await createRoomAsHost(page);
    // Room code appears in the header chip (a <p> with mono font)
    await expect(page.locator("p").filter({ hasText: new RegExp(`^${roomCode}$`) }).first()).toBeVisible();
  });

  test("join form routes player to play page", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-testid='join-name-input']").fill("Alice");
    await page.locator("[data-testid='join-code-input']").fill("TEST");
    await page.locator("[data-testid='join-room-btn']").click();

    await page.waitForURL(/\/room\/TEST\/play/);
    await expect(page).toHaveURL(/name=Alice/);
  });

  test("join form shows validation errors", async ({ page }) => {
    await page.goto("/");
    // Submit with no name
    await page.locator("[data-testid='join-room-btn']").click();
    await expect(page.getByText("請輸入你的名字")).toBeVisible();

    // Fill name but submit with short code
    await page.locator("[data-testid='join-name-input']").fill("Alice");
    await page.locator("[data-testid='join-code-input']").fill("AB");
    await page.locator("[data-testid='join-room-btn']").click();
    await expect(page.getByText("請輸入 4 碼房間代碼")).toBeVisible();
  });
});

test.describe("Host lobby", () => {
  test("shows no-players state; Start Game unavailable without a loaded playlist", async ({ page }) => {
    await createRoomAsHost(page);

    // No players in room yet
    await expect(page.getByText("No players yet")).toBeVisible();

    // Start Game button does not appear until a playlist is loaded
    await expect(page.locator("[data-testid='start-game-btn']")).not.toBeVisible();

    // Load the test seed — Start Game should appear but be disabled (no players)
    // Use pressSequentially because type="url" inputs don't fire React onChange via fill()
    const urlInput = page.locator('input[type="url"]');
    await urlInput.click();
    await urlInput.pressSequentially("hitster://test");
    await page.locator("[data-testid='load-playlist-btn']").click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("[data-testid='start-game-btn']")).toBeDisabled();
  });
});

test.describe("Mobile player view", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("join form is usable on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-testid='join-code-input']")).toBeVisible();
    await expect(page.locator("[data-testid='join-name-input']")).toBeVisible();
    await expect(page.locator("[data-testid='join-room-btn']")).toBeVisible();
  });
});

test.describe("Host screen link", () => {
  test("the host can open the TV screen page from the link in the header", async ({ page, context }) => {
    const code = await createRoomAsHost(page);
    const link = page.getByTestId("screen-link");
    await expect(link).toContainText(`/room/${code}/screen`);
    const [screenTab] = await Promise.all([context.waitForEvent("page"), link.click()]);
    await screenTab.waitForURL(new RegExp(`/room/${code}/screen$`));
    await expect(screenTab.getByText("掃描加入 · Scan to join")).toBeVisible({ timeout: 10_000 });
    // A second tap focuses the same tab: no second screen player, no reload mid-round.
    await screenTab.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });
    const newTab = context.waitForEvent("page", { timeout: 2000 });
    await link.click();
    await expect(newTab).rejects.toThrow();
    expect(await screenTab.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  });
});

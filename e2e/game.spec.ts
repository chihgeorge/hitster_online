import { test, expect } from "@playwright/test";
import { createRoomAsHost } from "./helpers";

test.describe("Landing page", () => {
  test("shows the HITSTER! heading and room entry controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /HITSTER/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create a Room/i })).toBeVisible();
    await expect(page.getByPlaceholder("房間代碼")).toBeVisible();
  });

  test("creates a room and navigates to host page with 4-char code", async ({ page }) => {
    const roomCode = await createRoomAsHost(page);
    // Room code appears in the header chip (a <p> with mono font)
    await expect(page.locator("p").filter({ hasText: new RegExp(`^${roomCode}$`) }).first()).toBeVisible();
  });

  test("join form routes player to play page", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder("你的名字").fill("Alice");
    await page.getByPlaceholder("房間代碼").fill("TEST");
    await page.getByRole("button", { name: /加入/i }).click();

    await page.waitForURL(/\/room\/TEST\/play/);
    await expect(page).toHaveURL(/name=Alice/);
  });

  test("join form shows validation errors", async ({ page }) => {
    await page.goto("/");
    // Submit with no name
    await page.getByRole("button", { name: /加入/i }).click();
    await expect(page.getByText("請輸入你的名字")).toBeVisible();

    // Fill name but submit with short code
    await page.getByPlaceholder("你的名字").fill("Alice");
    await page.getByPlaceholder("房間代碼").fill("AB");
    await page.getByRole("button", { name: /加入/i }).click();
    await expect(page.getByText("請輸入 4 碼房間代碼")).toBeVisible();
  });
});

test.describe("Host lobby", () => {
  test("shows no-players state; Start Game unavailable without a loaded playlist", async ({ page }) => {
    await createRoomAsHost(page);

    // No players in room yet
    await expect(page.getByText("No players yet")).toBeVisible();

    // Start Game button does not appear until a playlist is loaded
    await expect(page.getByRole("button", { name: /Start Game/i })).not.toBeVisible();

    // Load the test seed — Start Game should appear but be disabled (no players)
    // Use pressSequentially because type="url" inputs don't fire React onChange via fill()
    const urlInput = page.locator('input[type="url"]');
    await urlInput.click();
    await urlInput.pressSequentially("hitster://test");
    await page.getByRole("button", { name: /Load/i }).click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /Start Game/i })).toBeDisabled();
  });
});

test.describe("Mobile player view", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("join form is usable on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder("房間代碼")).toBeVisible();
    await expect(page.getByPlaceholder("你的名字")).toBeVisible();
    await expect(page.getByRole("button", { name: /加入/i })).toBeVisible();
  });
});

import { test, expect } from "@playwright/test";

test.describe("Landing page", () => {
  test("shows the HITSTER! heading and room entry controls", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /HITSTER/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /create/i })).toBeVisible();
    await expect(page.getByPlaceholder(/room code/i)).toBeVisible();
  });

  test("creates a room and navigates to host page with 4-char code", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();

    // Should redirect to /room/XXXX/host
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);
    const url = page.url();
    const match = url.match(/\/room\/([A-Z]{4})\/host$/);
    expect(match).not.toBeNull();
    // Room code visible in the header
    await expect(page.getByText(match![1])).toBeVisible();
  });

  test("join form routes player to play page", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder(/room code/i).fill("TEST");
    await page.getByPlaceholder(/your name/i).fill("Alice");
    await page.getByRole("button", { name: /join/i }).click();

    await page.waitForURL(/\/room\/TEST\/play/);
    await expect(page).toHaveURL(/name=Alice/);
  });
});

test.describe("Host lobby", () => {
  test("shows waiting message when no players have joined", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    await expect(page.getByText(/waiting for players/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /start game/i })).toBeDisabled();
  });
});

test.describe("Mobile player view", () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 Pro

  test("join form is usable on mobile", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByPlaceholder(/room code/i)).toBeVisible();
    await expect(page.getByPlaceholder(/your name/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /join/i })).toBeVisible();
  });
});

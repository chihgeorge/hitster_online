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

  // Value: protects=visible keyboard focus ring on text fields (WCAG 2.4.7); fails_when=an inline outline:"none" or the globals.css :focus-visible rule is removed; why_new=no test checks focus styling and happy-dom can't compute :focus-visible; seam=none
  test("keyboard focus on a text field shows the orange focus ring", async ({ page }) => {
    await page.goto("/");
    const code = page.locator("[data-testid='join-code-input']");
    await code.focus(); // text inputs match :focus-visible on any focus, so no Tab dance (keeps the test off tab order)
    await expect(code).toHaveCSS("outline-style", "solid");
    await expect(code).toHaveCSS("outline-color", "rgb(232, 85, 32)");
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

  // Value: protects=host-lobby playlist URL field keeps a visible keyboard focus ring (WCAG 2.4.7); fails_when=outline:"none" returns to the host page's shared inp style; why_new=landing-page test only covers app/page.tsx inputs, host page has its own inline style object; seam=none
  test("keyboard focus on the playlist URL field shows the orange focus ring", async ({ page }) => {
    await createRoomAsHost(page);
    const urlInput = page.locator('input[type="url"]');
    await urlInput.focus();
    await expect(urlInput).toHaveCSS("outline-style", "solid");
    await expect(urlInput).toHaveCSS("outline-color", "rgb(232, 85, 32)");
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

  // The host page reopened in a new tab isn't the screen tab's opener, so window.open("", name)
  // can't find it. Without the BroadcastChannel check this opened a second screen (songs twice).
  test("a reopened host page doesn't open a second screen tab", async ({ page, context }) => {
    const code = await createRoomAsHost(page);
    const [screenTab] = await Promise.all([context.waitForEvent("page"), page.getByTestId("screen-link").click()]);
    await expect(screenTab.getByText("掃描加入 · Scan to join")).toBeVisible({ timeout: 10_000 });
    await screenTab.evaluate(() => { (window as unknown as { __kept: boolean }).__kept = true; });

    const hostUrl = page.url();
    await page.close();
    const host2 = await context.newPage();
    await host2.goto(hostUrl);
    const link = host2.getByTestId("screen-link");
    await expect(link).toContainText(`/room/${code}/screen`);
    await host2.waitForTimeout(300); // the open screen answers the host's ping
    await link.click();
    await expect(host2.getByTestId("screen-elsewhere")).toBeVisible();
    await expect.poll(() => context.pages().filter((p) => !p.isClosed()).length).toBe(2); // host + the one screen
    expect(await screenTab.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
  });
});

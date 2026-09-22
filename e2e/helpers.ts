import type { Page } from "@playwright/test";

/**
 * Creates a room via the homepage's explicit "Create a Room" button (a deliberate click, not a
 * bare page load — the site is public, so nothing creates a room just from being visited) and
 * follows the resulting private "manage as host" link through to /host.
 *
 * Returns the room's 4-char code.
 */
export async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: /Create a Room/i }).click();
  await page.waitForURL(/\/room\/[A-Z]{4}\/screen\?created=1$/);
  const match = page.url().match(/\/room\/([A-Z]{4})\/screen/);
  if (!match) throw new Error(`Expected a 4-char room code in the /screen redirect URL, got: ${page.url()}`);
  await page.getByTestId("manage-as-host-link").click();
  await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);
  return match[1];
}

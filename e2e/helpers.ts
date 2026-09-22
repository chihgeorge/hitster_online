import type { Page } from "@playwright/test";

/**
 * Creates a room via the screen-first flow (/screen generates the room and redirects with
 * ?created=1, the room-scoped screen shows a private "manage as host" link only to that
 * browser) and follows it through to /host. Replaces the old one-click "Create a Room" button
 * on the homepage, which /plan-eng-review's screen-first redesign removed.
 *
 * Returns the room's 4-char code.
 */
export async function createRoomAsHost(page: Page): Promise<string> {
  await page.goto("/screen");
  await page.waitForURL(/\/room\/[A-Z]{4}\/screen\?created=1$/);
  const match = page.url().match(/\/room\/([A-Z]{4})\/screen/);
  if (!match) throw new Error(`Expected a 4-char room code in the /screen redirect URL, got: ${page.url()}`);
  await page.getByTestId("manage-as-host-link").click();
  await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);
  return match[1];
}

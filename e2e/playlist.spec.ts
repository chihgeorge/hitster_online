/**
 * E2E tests for the custom-playlist feature.
 *
 * These tests use the hitster://test seed URL (no real YouTube or Anthropic calls)
 * to verify the save → reload → load-saved → start-game round-trip.
 *
 * The playlist party HTTP API is tested directly against the local PartyKit dev server.
 */
import { test, expect } from "@playwright/test";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";
const PARTY_URL = (id: string) => `http://${PARTYKIT_HOST}/parties/playlist/${id}`;

// ─── Playlist party HTTP API ──────────────────────────────────────────────────

test.describe("Playlist party HTTP API", () => {
  test("POST creates a playlist, GET retrieves it", async ({ request }) => {
    const id = crypto.randomUUID();
    const songs = [
      { videoId: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", artist: "Rick Astley", year: 1987 },
      { videoId: "oHg5SJYRHA0", title: "RickRoll'd", artist: "cotter548", year: 2009 },
    ];

    const postRes = await request.post(PARTY_URL(id), {
      data: { ownerHostId: "host-e2e", name: "E2E Mix", songs },
    });
    expect(postRes.status()).toBe(201);

    const getRes = await request.get(PARTY_URL(id));
    expect(getRes.status()).toBe(200);
    const body = await getRes.json() as { name: string; songs: typeof songs };
    expect(body.name).toBe("E2E Mix");
    expect(body.songs).toHaveLength(2);
  });

  test("PUT UPDATE_SONG patches a song", async ({ request }) => {
    const id = crypto.randomUUID();
    const songs = [
      { videoId: "vid1", title: "Original Title", artist: "Artist", year: 2000 },
      { videoId: "vid2", title: "Other Song", artist: "Other", year: 2001 },
    ];

    await request.post(PARTY_URL(id), {
      data: { ownerHostId: "host-e2e", name: "Test", songs },
    });

    const putRes = await request.put(PARTY_URL(id), {
      data: { ownerHostId: "host-e2e", action: "UPDATE_SONG", videoId: "vid1", title: "Patched Title", year: 1999 },
    });
    expect(putRes.status()).toBe(200);

    const getRes = await request.get(PARTY_URL(id));
    const body = await getRes.json() as { songs: { videoId: string; title: string; year: number }[] };
    const patched = body.songs.find((s) => s.videoId === "vid1");
    expect(patched?.title).toBe("Patched Title");
    expect(patched?.year).toBe(1999);
  });

  test("PUT DELETE_SONG removes a song", async ({ request }) => {
    const id = crypto.randomUUID();
    const songs = [
      { videoId: "s1", title: "A", artist: "X", year: 2000 },
      { videoId: "s2", title: "B", artist: "Y", year: 2001 },
      { videoId: "s3", title: "C", artist: "Z", year: 2002 },
    ];

    await request.post(PARTY_URL(id), { data: { ownerHostId: "h1", name: "Mix", songs } });

    const res = await request.put(PARTY_URL(id), {
      data: { ownerHostId: "h1", action: "DELETE_SONG", videoId: "s2" },
    });
    expect(res.status()).toBe(200);

    const body = await (await request.get(PARTY_URL(id))).json() as { songs: { videoId: string }[] };
    expect(body.songs.map((s) => s.videoId)).toEqual(["s1", "s3"]);
  });

  test("DELETE removes the playlist", async ({ request }) => {
    const id = crypto.randomUUID();
    const songs = [
      { videoId: "x1", title: "X", artist: "Y", year: 2005 },
      { videoId: "x2", title: "X2", artist: "Y2", year: 2006 },
    ];

    await request.post(PARTY_URL(id), { data: { ownerHostId: "h2", name: "Delete me", songs } });
    const del = await request.delete(PARTY_URL(id), { data: { ownerHostId: "h2" } });
    expect(del.status()).toBe(200);

    const get = await request.get(PARTY_URL(id));
    expect(get.status()).toBe(404);
  });

  test("unauthorized PUT returns 403", async ({ request }) => {
    const id = crypto.randomUUID();
    await request.post(PARTY_URL(id), {
      data: {
        ownerHostId: "real-host",
        name: "Private",
        songs: [
          { videoId: "a", title: "A", artist: "B", year: 2000 },
          { videoId: "b", title: "B", artist: "C", year: 2001 },
        ],
      },
    });

    const res = await request.put(PARTY_URL(id), {
      data: { ownerHostId: "attacker", action: "UPDATE_SONG", videoId: "a", title: "Hacked" },
    });
    expect(res.status()).toBe(403);
  });
});

// ─── Host UI: save and reload ─────────────────────────────────────────────────

test.describe("Host lobby: save and load playlist", () => {
  test("loads a playlist and shows the Save playlist button", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    // Use the test seed (no network)
    const input = page.locator('input[type="url"]');
    await input.click();
    await input.pressSequentially("hitster://test");
    await page.locator("[data-testid='load-playlist-btn']").click();

    // PLAYLIST_READY fires immediately for test seed
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "儲存播放清單" })).toBeVisible();
  });

  test("can expand and collapse the save panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    const input = page.locator('input[type="url"]');
    await input.click();
    await input.pressSequentially("hitster://test");
    await page.locator("[data-testid='load-playlist-btn']").click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5000 });

    // Click "儲存播放清單" to reveal the name input
    await page.getByRole("button", { name: "儲存播放清單" }).click();
    await expect(page.getByPlaceholder("播放清單名稱")).toBeVisible();
  });

  test("save → reload → load saved playlist → start game", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    // Load test seed
    const urlInput = page.locator('input[type="url"]');
    await urlInput.click();
    await urlInput.pressSequentially("hitster://test");
    await page.locator("[data-testid='load-playlist-btn']").click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });

    // Save the playlist
    await page.getByRole("button", { name: "儲存播放清單" }).click();
    const nameInput = page.getByPlaceholder("播放清單名稱");
    await nameInput.fill("E2E Test Playlist");
    // The submit button reads "儲存 (N)"; /儲存/ alone also matches the "儲存播放清單" toggle
    await page.getByRole("button", { name: /^儲存 \(\d+\)/ }).click();
    // After save, the "已儲存 ✓" badge appears and the copy ID button is shown
    await expect(page.getByText("已儲存 ✓")).toBeVisible({ timeout: 5_000 });

    // Reload the page to simulate a fresh session
    await page.reload();
    await page.waitForURL(/\/room\/[A-Z]+\/host$/);

    // The saved playlist should appear in the Saved Playlists section
    await expect(page.getByText("E2E Test Playlist")).toBeVisible({ timeout: 5_000 });

    // Load it from the saved list
    const loadBtn = page.locator("button", { hasText: "載入" }).last();
    await loadBtn.click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });

    // Start game button should now be available (no players needed for this assertion)
    await expect(page.locator("[data-testid='start-game-btn']")).toBeVisible();
  });

  test("edit year on a song → verify the edit is reflected in the editor", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    // Load test seed
    const urlInput = page.locator('input[type="url"]');
    await urlInput.click();
    await urlInput.pressSequentially("hitster://test");
    await page.locator("[data-testid='load-playlist-btn']").click();
    await expect(page.getByText(/已載入/i)).toBeVisible({ timeout: 5_000 });

    // Open the song editor
    await page.getByRole("button", { name: /編輯歌曲資訊/i }).click();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 3_000 });

    // Edit year of first song (1960 → 1961)
    const yearInputs = page.locator("input[type='number']");
    const firstYear = yearInputs.first();
    await firstYear.click({ clickCount: 3 });
    await firstYear.fill("1961");
    await firstYear.press("Tab");

    // Verify the change was accepted (field stays at 1961)
    await expect(firstYear).toHaveValue("1961");
  });
});

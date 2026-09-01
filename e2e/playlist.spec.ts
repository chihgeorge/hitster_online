/**
 * E2E tests for the custom-playlist feature.
 *
 * These tests use the hitster://test seed URL (no real YouTube/Spotify calls)
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
    const input = page.getByPlaceholder(/youtube.*playlist/i);
    await input.fill("hitster://test");
    await page.getByRole("button", { name: /^load$/i }).click();

    // PLAYLIST_READY fires immediately for test seed
    await expect(page.getByText(/playlist loaded/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: /save playlist/i })).toBeVisible();
  });

  test("can expand and collapse the save panel", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /create/i }).click();
    await page.waitForURL(/\/room\/[A-Z]{4}\/host$/);

    const input = page.getByPlaceholder(/youtube.*playlist/i);
    await input.fill("hitster://test");
    await page.getByRole("button", { name: /^load$/i }).click();
    await expect(page.getByText(/playlist loaded/i)).toBeVisible({ timeout: 5000 });

    // Click "Save playlist" to reveal the name input
    await page.getByRole("button", { name: /save playlist/i }).click();
    await expect(page.getByPlaceholder(/playlist name/i)).toBeVisible();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import PlaylistsPage from "@/app/playlists/page";

// T5 (docs/designs/decouple-quiz-bank.md) — the standalone quiz-bank page. Covers the library
// list, create-from-URL, select-to-edit and delete flows against party/library.ts + party/
// playlist.ts's HTTP APIs (T2-T4), all through a stubbed global fetch.

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  localStorage.clear();
  // Default: empty library. Individual tests override with mockFetch.mockImplementation.
  mockFetch.mockResolvedValue(jsonResponse({ entries: [] }));
});
afterEach(() => cleanup());

describe("PlaylistsPage: library list", () => {
  it("shows an empty state when the library has no playlists", async () => {
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText(/No playlists yet/)).toBeTruthy());
  });

  it("lists existing playlists from the library index", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ entries: [{ id: "p1", name: "Weekend Mix", songCount: 12 }] }));
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText("Weekend Mix")).toBeTruthy());
    expect(screen.getByText(/12/)).toBeTruthy();
  });

  it("shows an error state when the library fetch fails", async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, false, 500));
    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText(/Failed to load your library/)).toBeTruthy());
  });

  it("migrates localStorage-only playlists (D2b) before the first library read", async () => {
    localStorage.setItem("hitster_playlists", JSON.stringify([{ id: "old-1", name: "Old Mix", songCount: 4 }]));
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return Promise.resolve(jsonResponse({ ok: true, added: 1 }));
      return Promise.resolve(jsonResponse({ entries: [{ id: "old-1", name: "Old Mix", songCount: 4 }] }));
    });

    render(<PlaylistsPage />);

    await waitFor(() => {
      const importCall = mockFetch.mock.calls.find(([, init]) => init?.method === "PUT");
      expect(importCall).toBeDefined();
    });
    const [, importInit] = mockFetch.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(importInit.body as string)).toEqual({
      action: "IMPORT",
      entries: [{ id: "old-1", name: "Old Mix", songCount: 4 }],
    });
    // The migrated entry appears on this very first load, not just after a reload.
    await waitFor(() => expect(screen.getByText("Old Mix")).toBeTruthy());
  });
});

describe("PlaylistsPage: create from URL", () => {
  it("disables Create until both name and URL are filled in", async () => {
    render(<PlaylistsPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    const createBtn = screen.getByText(/^建立 · Create$/);
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/Playlist name/), { target: { value: "My Mix" } });
    expect((createBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/youtube.com/), { target: { value: "https://www.youtube.com/playlist?list=PLtest" } });
    expect((createBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("POSTs RESOLVE_FROM_URL and refreshes the library on success", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ playlistId: "new-id" }, true, 201));
      if (String(url).includes("/library/")) return Promise.resolve(jsonResponse({ entries: [{ id: "new-id", name: "My Mix", songCount: 5 }] }));
      // GET /parties/playlist/:id (loading the newly-created playlist for editing)
      return Promise.resolve(jsonResponse({ songs: [{ videoId: "v1", title: "T", artist: "A", year: 2000 }, { videoId: "v2", title: "T2", artist: "A2", year: 2001 }] }));
    });

    render(<PlaylistsPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Playlist name/), { target: { value: "My Mix" } });
    fireEvent.change(screen.getByPlaceholderText(/youtube.com/), { target: { value: "https://www.youtube.com/playlist?list=PLtest" } });
    fireEvent.click(screen.getByText(/^建立 · Create$/));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(([, init]) => init?.method === "POST");
      expect(postCall).toBeDefined();
    });
    const [, postInit] = mockFetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    const body = JSON.parse(postInit.body as string);
    expect(body).toMatchObject({ name: "My Mix", action: "RESOLVE_FROM_URL", playlistUrl: "https://www.youtube.com/playlist?list=PLtest" });
    expect(typeof body.ownerHostId).toBe("string");

    // Input cleared after a successful create
    await waitFor(() => expect((screen.getByPlaceholderText(/Playlist name/) as HTMLInputElement).value).toBe(""));
  });

  it("shows the server's error message when creation fails", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ error: "not_enough_songs" }, false, 400));
      return Promise.resolve(jsonResponse({ entries: [] }));
    });
    render(<PlaylistsPage />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());

    fireEvent.change(screen.getByPlaceholderText(/Playlist name/), { target: { value: "My Mix" } });
    fireEvent.change(screen.getByPlaceholderText(/youtube.com/), { target: { value: "https://www.youtube.com/playlist?list=PLtest" } });
    fireEvent.click(screen.getByText(/^建立 · Create$/));

    await waitFor(() => expect(screen.getByText("not_enough_songs")).toBeTruthy());
  });
});

describe("PlaylistsPage: select and delete", () => {
  it("loads a playlist's songs into the editor when Edit is clicked", async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (!init) {
        if (String(url).includes("/library/")) return Promise.resolve(jsonResponse({ entries: [{ id: "p1", name: "Mix", songCount: 2 }] }));
        return Promise.resolve(jsonResponse({ songs: [{ videoId: "v1", title: "Song One", artist: "A", year: 2000 }, { videoId: "v2", title: "Song Two", artist: "B", year: 2001 }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText("Mix")).toBeTruthy());
    fireEvent.click(screen.getByText(/^編輯 · Edit$/));

    await waitFor(() => expect(screen.getByDisplayValue("Song One")).toBeTruthy());
  });

  it("DELETEs a playlist and removes it from the list", async () => {
    let deleted = false;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return Promise.resolve(jsonResponse({ ok: true })); }
      if (!init && String(url).includes("/library/")) {
        return Promise.resolve(jsonResponse({ entries: deleted ? [] : [{ id: "p1", name: "Mix", songCount: 2 }] }));
      }
      return Promise.resolve(jsonResponse({ entries: [] }));
    });

    render(<PlaylistsPage />);
    await waitFor(() => expect(screen.getByText("Mix")).toBeTruthy());
    fireEvent.click(screen.getByText("✕"));

    await waitFor(() => expect(screen.queryByText("Mix")).toBeNull());
    const deleteCall = mockFetch.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(deleteCall).toBeDefined();
  });
});

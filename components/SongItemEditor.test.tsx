import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import SongItemEditor from "./SongItemEditor";
import type { EditableSong } from "@/lib/game";

const songs: EditableSong[] = [
  { videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 },
  { videoId: "v2", title: "Song B", artist: "Artist B", year: 2001 },
  { videoId: "v3", title: "Song C", artist: "Artist C", year: 2002 },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(overrides: Partial<Parameters<typeof SongItemEditor>[0]> = {}) {
  const onSongsChange = vi.fn();
  const onClose = vi.fn();
  render(
    <SongItemEditor
      playlistId="pl-1"
      songs={songs}
      hostId="host-1"
      partyKitHost="localhost:1999"
      onSongsChange={onSongsChange}
      onClose={onClose}
      {...overrides}
    />
  );
  return { onSongsChange, onClose };
}

describe("SongItemEditor (T4, docs/designs/full-page-focus-editor.md)", () => {
  it("shows the first song centered, with prev disabled and next enabled", () => {
    setup();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(screen.getByDisplayValue("Song A")).toBeTruthy();
    expect(screen.getByText(/上一首/)).toHaveProperty("disabled", true);
    expect(screen.getByText(/下一首/)).toHaveProperty("disabled", false);
  });

  it("navigates prev/next without wraparound at the boundaries", () => {
    setup();
    const next = screen.getByText(/下一首/);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(screen.getByDisplayValue("Song C")).toBeTruthy();
    expect(next).toHaveProperty("disabled", true); // last item — no wraparound

    const prev = screen.getByText(/上一首/);
    fireEvent.click(prev);
    fireEvent.click(prev);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(prev).toHaveProperty("disabled", true); // first item again — no wraparound
  });

  it("shows a Save button once a field is edited, and saves via UPDATE_SONG", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { onSongsChange } = setup();

    expect(screen.queryByText(/儲存/)).toBeNull();
    fireEvent.change(screen.getByDisplayValue("Song A"), { target: { value: "Song A Fixed" } });
    expect(screen.getByText(/儲存/)).toBeTruthy();

    fireEvent.click(screen.getByText(/儲存/));
    await waitFor(() => expect(onSongsChange).toHaveBeenCalled());

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/parties/playlist/pl-1");
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({ action: "UPDATE_SONG", videoId: "v1", title: "Song A Fixed" });
  });

  it("applies an AI-proposed diff as a reviewable draft, not directly to the server", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ diff: [{ videoId: "v1", field: "year", oldValue: 2000, newValue: 1999 }] }), { status: 200 })
    );
    setup();

    fireEvent.change(screen.getByPlaceholderText(/fix the year/), { target: { value: "fix the year, it's 1999" } });
    fireEvent.click(screen.getByText("✨ Ask AI"));

    await waitFor(() => expect(screen.getByDisplayValue("1999")).toBeTruthy());
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body).toMatchObject({ action: "PROPOSE_EDITS", instruction: "fix the year, it's 1999" });
    // Not saved yet — still shows the Save button for the now-dirty draft.
    expect(screen.getByText(/儲存/)).toBeTruthy();
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText(/關閉/));
    expect(onClose).toHaveBeenCalled();
  });
});

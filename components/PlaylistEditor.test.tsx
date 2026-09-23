import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import PlaylistEditor from "./PlaylistEditor";
import type { EditableSong, SongEditDiff } from "@/lib/game";

// Regression: this file didn't exist before — PlaylistEditor.tsx had zero direct test coverage.
// Focuses on the new chat-to-diff feature (docs/designs/ai-assisted-quiz-generation.md,
// Approach A) — applying a proposed diff through the existing dirty-row state, not re-testing
// every pre-existing manual-edit code path.

const SONGS: EditableSong[] = [
  { videoId: "v1", title: "Wonderwall", artist: "Oasis", year: 1994 },
  { videoId: "v2", title: "Yesterday", artist: "The Beatles", year: 1965 },
];

const baseProps = {
  playlistId: null,
  songs: SONGS,
  hostId: "host-1",
  partyKitHost: "localhost:1999",
  onSongsChange: vi.fn(),
};

afterEach(() => cleanup());

describe("PlaylistEditor: chat-to-diff box", () => {
  it("does not render the chat box when onProposeEdits isn't provided", () => {
    render(<PlaylistEditor {...baseProps} />);
    expect(screen.queryByText("✨ Ask AI")).toBeNull();
  });

  it("calls onProposeEdits with the trimmed instruction and clears the input", () => {
    const onProposeEdits = vi.fn();
    render(<PlaylistEditor {...baseProps} onProposeEdits={onProposeEdits} />);

    const input = screen.getByPlaceholderText(/3rd song's year/);
    fireEvent.change(input, { target: { value: "  fix the year on the first song  " } });
    fireEvent.click(screen.getByText("✨ Ask AI"));

    expect(onProposeEdits).toHaveBeenCalledWith("fix the year on the first song");
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not call onProposeEdits with a blank instruction", () => {
    const onProposeEdits = vi.fn();
    render(<PlaylistEditor {...baseProps} onProposeEdits={onProposeEdits} />);
    fireEvent.click(screen.getByText("✨ Ask AI"));
    expect(onProposeEdits).not.toHaveBeenCalled();
  });

  it("disables the submit button while proposing", () => {
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposing={true} />);
    expect((screen.getByText("詢問中…").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the propose error message when set", () => {
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposeError="無法處理，請再試一次 · Couldn't process that, try again" />);
    expect(screen.getByText(/Couldn't process that/)).toBeTruthy();
  });
});

describe("PlaylistEditor: applying a proposed diff", () => {
  it("applies the diff through the existing dirty-row state — the field shows the new value and a Save row appears", () => {
    const diff: SongEditDiff[] = [{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }];
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={diff} onProposedDiffConsumed={vi.fn()} />);

    // Year field now shows the proposed value, not applied to room/server state yet
    expect(screen.getByDisplayValue("1995")).toBeTruthy();
    // The row is dirty — "Apply all (1)" reflects one pending change (no playlistId => "Apply", not "Save")
    expect(screen.getByText("Apply all (1)")).toBeTruthy();
  });

  it("calls onProposedDiffConsumed exactly once after applying", () => {
    const diff: SongEditDiff[] = [{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }];
    const onProposedDiffConsumed = vi.fn();
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={diff} onProposedDiffConsumed={onProposedDiffConsumed} />);
    expect(onProposedDiffConsumed).toHaveBeenCalledTimes(1);
  });

  it("applies multiple diff entries across different songs and fields", () => {
    const diff: SongEditDiff[] = [
      { videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 },
      { videoId: "v2", field: "artist", oldValue: "The Beatles", newValue: "The Beatles (remastered)" },
    ];
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={diff} onProposedDiffConsumed={vi.fn()} />);
    expect(screen.getByDisplayValue("1995")).toBeTruthy();
    expect(screen.getByDisplayValue("The Beatles (remastered)")).toBeTruthy();
    expect(screen.getByText("Apply all (2)")).toBeTruthy();
  });

  it("does not apply anything or call the callback for an empty diff", () => {
    const onProposedDiffConsumed = vi.fn();
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={[]} onProposedDiffConsumed={onProposedDiffConsumed} />);
    expect(onProposedDiffConsumed).not.toHaveBeenCalled();
    expect(screen.queryByText(/Apply all/)).toBeNull();
  });
});

describe("PlaylistEditor: discard all changes", () => {
  it("shows no discard button when nothing is dirty", () => {
    render(<PlaylistEditor {...baseProps} />);
    expect(screen.queryByText("放棄更改")).toBeNull();
  });

  it("requires confirmation, then clears dirty state on confirm", () => {
    const diff: SongEditDiff[] = [{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }];
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={diff} onProposedDiffConsumed={vi.fn()} />);

    expect(screen.getByDisplayValue("1995")).toBeTruthy();
    fireEvent.click(screen.getByText("放棄更改"));
    expect(screen.getByText("放棄所有更改？")).toBeTruthy();
    // Value is still staged until the confirm click
    expect(screen.getByDisplayValue("1995")).toBeTruthy();

    fireEvent.click(screen.getByText("確認"));
    // Reverted to the original value, dirty state cleared
    expect(screen.getByDisplayValue("1994")).toBeTruthy();
    expect(screen.queryByText(/Apply all/)).toBeNull();
  });

  it("cancelling the confirmation leaves the pending change intact", () => {
    const diff: SongEditDiff[] = [{ videoId: "v1", field: "year", oldValue: 1994, newValue: 1995 }];
    render(<PlaylistEditor {...baseProps} onProposeEdits={vi.fn()} proposedDiff={diff} onProposedDiffConsumed={vi.fn()} />);

    fireEvent.click(screen.getByText("放棄更改"));
    fireEvent.click(screen.getByText("取消"));
    expect(screen.getByDisplayValue("1995")).toBeTruthy();
    expect(screen.getByText("Apply all (1)")).toBeTruthy();
  });
});

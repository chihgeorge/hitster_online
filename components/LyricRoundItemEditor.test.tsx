import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import LyricRoundItemEditor from "./LyricRoundItemEditor";
import type { EditableSong, PublicLyricsRound } from "@/lib/game";

const readySongs: EditableSong[] = [
  { videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 },
  { videoId: "v2", title: "Song B", artist: "Artist B", year: 2001 },
];

const lyricsPreview: PublicLyricsRound[] = [
  { videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" },
  { videoId: "v2", title: "Song B", artist: "Artist B", language: "en", lyricContext: "Some ___", blankSentence: "thing" },
];

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof LyricRoundItemEditor>[0]> = {}) {
  const setLyricOverrides = vi.fn();
  const setLyricInstruction = vi.fn();
  const onProposeLyricEdits = vi.fn();
  const onClose = vi.fn();
  render(
    <LyricRoundItemEditor
      readySongs={readySongs}
      lyricsPreview={lyricsPreview}
      lyricsPreviewLoading={false}
      lyricOverrides={{}}
      setLyricOverrides={setLyricOverrides}
      lyricInstruction=""
      setLyricInstruction={setLyricInstruction}
      proposingLyricEdits={false}
      onProposeLyricEdits={onProposeLyricEdits}
      proposeLyricError={null}
      onClose={onClose}
      {...overrides}
    />
  );
  return { setLyricOverrides, setLyricInstruction, onProposeLyricEdits, onClose };
}

describe("LyricRoundItemEditor (T6, docs/designs/full-page-focus-editor.md)", () => {
  it("shows the first round merged from lyricsPreview, prev disabled at the start", () => {
    setup();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("Song A")).toBeTruthy();
    expect(screen.getByDisplayValue("I want ___")).toBeTruthy();
    expect(screen.getByDisplayValue("you")).toBeTruthy();
    expect(screen.getByText(/上一首/)).toHaveProperty("disabled", true);
  });

  it("merges lyricOverrides over the preview, same precedence as the table", () => {
    setup({ lyricOverrides: { v1: { blankSentence: "you (edited)" } } });
    expect(screen.getByDisplayValue("you (edited)")).toBeTruthy();
    expect(screen.getByDisplayValue("I want ___")).toBeTruthy(); // lyricContext untouched, still from preview
  });

  it("navigates prev/next without wraparound at the boundaries", () => {
    setup();
    fireEvent.click(screen.getByText(/下一首/));
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByText(/下一首/)).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByText(/上一首/));
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText(/上一首/)).toHaveProperty("disabled", true);
  });

  it("shows Apply only once a field is edited, and commits the draft into lyricOverrides", () => {
    const { setLyricOverrides } = setup();
    expect(screen.queryByText(/套用/)).toBeNull();

    fireEvent.change(screen.getByDisplayValue("you"), { target: { value: "you now" } });
    expect(screen.getByText(/套用/)).toBeTruthy();

    fireEvent.click(screen.getByText(/套用/));
    expect(setLyricOverrides).toHaveBeenCalled();
    const updater = setLyricOverrides.mock.calls[0][0];
    expect(updater({})).toEqual({ v1: { lyricContext: "I want ___", blankSentence: "you now" } });
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByText(/關閉/));
    expect(onClose).toHaveBeenCalled();
  });
});

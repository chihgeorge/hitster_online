import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import LyricsTable from "./LyricsTable";
import type { EditableSong, PublicLyricsRound } from "@/lib/game";

const readySongs: EditableSong[] = [
  { videoId: "v1", title: "Song A", artist: "Artist A", year: 2000 },
  { videoId: "v2", title: "Song B (no AI data)", artist: "Artist B", year: 2001 },
];

// Only v1 has a preview round — v2 is the "AI couldn't confidently generate one" case.
const lyricsPreview: PublicLyricsRound[] = [
  { videoId: "v1", title: "Song A", artist: "Artist A", language: "en", lyricContext: "I want ___", blankSentence: "you" },
];

afterEach(cleanup);

function setup(overrides: Partial<Parameters<typeof LyricsTable>[0]> = {}) {
  const setLyricOverrides = vi.fn();
  const setLyricInstruction = vi.fn();
  const onProposeLyricEdits = vi.fn();
  render(
    <LyricsTable
      lyricsPreviewLoading={false}
      lyricsState={null}
      lyricsPreview={lyricsPreview}
      readySongs={readySongs}
      lyricOverrides={{}}
      setLyricOverrides={setLyricOverrides}
      pendingLyricsStart={false}
      lyricInstruction=""
      setLyricInstruction={setLyricInstruction}
      proposingLyricEdits={false}
      onProposeLyricEdits={onProposeLyricEdits}
      proposeLyricError={null}
      {...overrides}
    />
  );
  return { setLyricOverrides, setLyricInstruction, onProposeLyricEdits };
}

describe("LyricsTable (T5, docs/designs/full-page-focus-editor.md)", () => {
  it("renders an editable row for a song with real AI data", () => {
    setup();
    expect(screen.getByDisplayValue("I want ___")).toBeTruthy();
    expect(screen.getByDisplayValue("you")).toBeTruthy();
  });

  // Regression (host testing feedback): a song with no AI data used to render a plain "—" span
  // for Question/Answer — not an input — so the host had no way to type one in manually, and
  // asking AI to fill it in hit the same wall (see the host-page.test.tsx companion regression).
  it("still renders editable inputs for a song with no AI-generated data, not a static dash", () => {
    setup();
    const textareas = screen.getAllByPlaceholderText("手動輸入歌詞片段…");
    const inputs = screen.getAllByPlaceholderText("手動輸入答案…");
    expect(textareas).toHaveLength(1);
    expect(inputs).toHaveLength(1);
  });

  it("lets the host type into the previously-dead-end row (real state round trip)", () => {
    // LyricsTable is fully controlled by the lyricOverrides prop — a no-op mock setter means
    // React's own re-render immediately reverts the input's DOM value, so a mocked setter can't
    // observe what was typed. A small real-state wrapper exercises the actual round trip.
    function Harness() {
      const [lyricOverrides, setLyricOverrides] = useState<Record<string, { lyricContext?: string; blankSentence?: string }>>({});
      return (
        <LyricsTable
          lyricsPreviewLoading={false}
          lyricsState={null}
          lyricsPreview={lyricsPreview}
          readySongs={readySongs}
          lyricOverrides={lyricOverrides}
          setLyricOverrides={setLyricOverrides}
          pendingLyricsStart={false}
          lyricInstruction=""
          setLyricInstruction={vi.fn()}
          proposingLyricEdits={false}
          onProposeLyricEdits={vi.fn()}
          proposeLyricError={null}
        />
      );
    }
    render(<Harness />);
    const textarea = screen.getByPlaceholderText("手動輸入歌詞片段…") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "手動輸入 ___" } });
    expect(textarea.value).toBe("手動輸入 ___");
  });

  it("shows the loading placeholder while lyricsPreviewLoading is true, still editable", () => {
    setup({ lyricsPreviewLoading: true });
    const textareas = screen.getAllByPlaceholderText("…");
    expect(textareas.length).toBeGreaterThan(0);
  });
});

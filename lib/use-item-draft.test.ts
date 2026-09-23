import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useItemDraft } from "./use-item-draft";

interface FakeSong {
  videoId: string;
  title: string;
  artist: string;
  year: number | null;
}

const SONGS: FakeSong[] = [
  { videoId: "v1", title: "Wonderwall", artist: "Oasis", year: 1994 },
  { videoId: "v2", title: "Yesterday", artist: "The Beatles", year: 1965 },
];

describe("useItemDraft", () => {
  it("getDraft returns the base item unchanged when nothing has been edited", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    expect(result.current.getDraft(SONGS[0])).toEqual(SONGS[0]);
  });

  it("setField records a pending edit, reflected by getDraft", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    act(() => result.current.setField("v1", "year", 1995));
    expect(result.current.getDraft(SONGS[0])).toEqual({ ...SONGS[0], year: 1995 });
  });

  it("isDirty is false until a field actually differs from the base value", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    expect(result.current.isDirty(SONGS[0])).toBe(false);

    // Setting a field to its OWN current value should not count as dirty.
    act(() => result.current.setField("v1", "year", 1994));
    expect(result.current.isDirty(SONGS[0])).toBe(false);

    act(() => result.current.setField("v1", "year", 1995));
    expect(result.current.isDirty(SONGS[0])).toBe(true);
  });

  it("tracks multiple items independently", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    act(() => result.current.setField("v1", "title", "New Title"));
    expect(result.current.isDirty(SONGS[0])).toBe(true);
    expect(result.current.isDirty(SONGS[1])).toBe(false);
  });

  it("discard drops pending edits for one item only", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    act(() => {
      result.current.setField("v1", "year", 1995);
      result.current.setField("v2", "year", 1966);
    });
    act(() => result.current.discard("v1"));
    expect(result.current.getDraft(SONGS[0])).toEqual(SONGS[0]);
    expect(result.current.getDraft(SONGS[1])).toEqual({ ...SONGS[1], year: 1966 });
  });

  it("discardAll drops every pending edit", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    act(() => {
      result.current.setField("v1", "year", 1995);
      result.current.setField("v2", "year", 1966);
    });
    act(() => result.current.discardAll());
    expect(result.current.getDraft(SONGS[0])).toEqual(SONGS[0]);
    expect(result.current.getDraft(SONGS[1])).toEqual(SONGS[1]);
  });

  it("dirtyCount counts only items with an actual pending change", () => {
    const { result } = renderHook(() => useItemDraft<FakeSong>());
    expect(result.current.dirtyCount(SONGS)).toBe(0);
    act(() => result.current.setField("v1", "year", 1995));
    expect(result.current.dirtyCount(SONGS)).toBe(1);
    act(() => result.current.setField("v2", "artist", "The Beatles (Remastered)"));
    expect(result.current.dirtyCount(SONGS)).toBe(2);
  });

  it("works over a completely different field shape (lyric round), not just EditableSong", () => {
    interface FakeRound {
      videoId: string;
      lyricContext: string;
      blankSentence: string;
    }
    const rounds: FakeRound[] = [{ videoId: "r1", lyricContext: "I want you ___", blankSentence: "here" }];
    const { result } = renderHook(() => useItemDraft<FakeRound>());
    act(() => result.current.setField("r1", "blankSentence", "with me"));
    expect(result.current.getDraft(rounds[0])).toEqual({ ...rounds[0], blankSentence: "with me" });
    expect(result.current.isDirty(rounds[0])).toBe(true);
  });
});

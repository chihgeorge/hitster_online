"use client";

// Shared draft-tracking hook (docs/designs/full-page-focus-editor.md, T1) — extracted from
// components/PlaylistEditor.tsx's editing/setField/getDraft/isDirty logic, generalized over any
// item shape keyed by videoId. Confirmed during /plan-eng-review that PlaylistEditor's
// `editing: Record<videoId, Partial<EditableSong>>` and the Lyrics table's own
// `lyricOverrides: Record<videoId, Partial<{lyricContext, blankSentence}>>` are structurally
// identical draft-tracking shapes — this hook is that one shape, generic over the fields.
//
// Deliberately narrow (see D3 in the design doc): owns ONLY draft state (getDraft/setField/
// isDirty/discard/discardAll/dirtyCount). Persistence — PlaylistEditor's UPDATE_SONG PUT calls,
// Lyrics mode's bundling into the START_LYRICS_GAME payload — stays in each caller, unchanged.
// The two callers' persistence mechanisms genuinely differ; the draft-tracking they sit on top
// of doesn't, so only that part is shared.

import { useState } from "react";

export interface UseItemDraft<TBase extends { videoId: string }> {
  /** The item merged with any pending edits for it — what the UI should render. */
  getDraft(item: TBase): TBase;
  /** Records a pending edit to one field. Does not touch the server/room. */
  setField<K extends keyof TBase>(videoId: string, field: K, value: TBase[K]): void;
  /** True if this item has at least one field edited to a value different from its base. */
  isDirty(item: TBase): boolean;
  /** Drops all pending edits for one item (e.g. after a successful save, or a manual revert). */
  discard(videoId: string): void;
  /** Drops all pending edits for every item. */
  discardAll(): void;
  /** How many of `items` currently have at least one pending edit. */
  dirtyCount(items: TBase[]): number;
}

export function useItemDraft<TBase extends { videoId: string }>(): UseItemDraft<TBase> {
  const [editing, setEditing] = useState<Record<string, Partial<TBase>>>({});

  function setField<K extends keyof TBase>(videoId: string, field: K, value: TBase[K]) {
    setEditing((prev) => ({
      ...prev,
      [videoId]: { ...prev[videoId], [field]: value },
    }));
  }

  function getDraft(item: TBase): TBase {
    return { ...item, ...(editing[item.videoId] ?? {}) };
  }

  function isDirty(item: TBase): boolean {
    const ov = editing[item.videoId];
    if (!ov) return false;
    return (Object.keys(ov) as (keyof TBase)[]).some(
      (k) => ov[k] !== undefined && ov[k] !== item[k]
    );
  }

  function discard(videoId: string) {
    setEditing((prev) => { const n = { ...prev }; delete n[videoId]; return n; });
  }

  function discardAll() {
    setEditing({});
  }

  function dirtyCount(items: TBase[]): number {
    return items.filter(isDirty).length;
  }

  return { getDraft, setField, isDirty, discard, discardAll, dirtyCount };
}

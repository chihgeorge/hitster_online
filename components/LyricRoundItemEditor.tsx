"use client";

// Lyrics-mode Focus editor (T6, docs/designs/full-page-focus-editor.md) — full-page,
// one-round-at-a-time view; the actual reason Approach B (full parity across both modes) was
// chosen over Approach A (timeline-only). Reads the same two sources and merge precedence
// (ov.field ?? lr?.field ?? "") LyricsTable.tsx (T5) already uses, so it always shows what the
// table shows. Consumes lib/use-item-draft.ts (T1) for manual-edit dirty tracking before
// committing into the shared lyricOverrides — required by Success Criteria ("must actually
// import and consume useItemDraft, not reimplement its own copy of the draft-tracking logic").
// AI-proposed edits (the Ask AI box) keep writing straight into lyricOverrides, same as the
// table already does — that pipeline is shared and unchanged, not duplicated here.
//
// Gated entirely by the caller (host/page.tsx): only rendered while lyricsState === null and
// !pendingLyricsStart (T2's race-window flag). Once the host starts the game this view isn't
// offered at all, matching the table going read-only at the same point.

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { EditableSong, EditableLyricRound, PublicLyricsRound } from "@/lib/game";
import { useItemDraft } from "@/lib/use-item-draft";
import { focusFieldBox, focusNavBtn } from "./focus-editor-styles";

type Overrides = Record<string, { lyricContext?: string; blankSentence?: string }>;

interface Props {
  readySongs: EditableSong[];
  lyricsPreview: PublicLyricsRound[];
  lyricsPreviewLoading: boolean;
  lyricOverrides: Overrides;
  setLyricOverrides: Dispatch<SetStateAction<Overrides>>;
  lyricInstruction: string;
  setLyricInstruction: (value: string) => void;
  proposingLyricEdits: boolean;
  onProposeLyricEdits: () => void;
  proposeLyricError: string | null;
  onClose: () => void;
}

export default function LyricRoundItemEditor({
  readySongs, lyricsPreview, lyricsPreviewLoading, lyricOverrides, setLyricOverrides,
  lyricInstruction, setLyricInstruction, proposingLyricEdits, onProposeLyricEdits, proposeLyricError, onClose,
}: Props) {
  const { getDraft, setField: setDraftField, isDirty, discard } = useItemDraft<EditableLyricRound>();
  const [index, setIndex] = useState(0);

  // Same merge LyricsTable.tsx's preview-loaded branch uses.
  const previewMap = new Map(lyricsPreview.map((r) => [r.videoId, r]));
  const rounds: EditableLyricRound[] = readySongs.map((s) => {
    const lr = previewMap.get(s.videoId);
    const ov = lyricOverrides[s.videoId] ?? {};
    return {
      videoId: s.videoId,
      title: s.title,
      artist: s.artist,
      lyricContext: ov.lyricContext ?? lr?.lyricContext ?? "",
      blankSentence: ov.blankSentence ?? lr?.blankSentence ?? "",
    };
  });

  const round = rounds[index];
  if (!round) return null; // boundary guard — list shrank out from under the current index
  const draft = getDraft(round);
  const dirty = isDirty(round);
  const lr = previewMap.get(round.videoId);
  const hasData = !!(lr?.lyricContext || lr?.blankSentence);

  function setField(field: "lyricContext" | "blankSentence", value: string) {
    setDraftField(round.videoId, field, value);
  }

  function handleApply() {
    setLyricOverrides((prev) => ({
      ...prev,
      [round.videoId]: { ...prev[round.videoId], lyricContext: draft.lyricContext, blankSentence: draft.blankSentence },
    }));
    discard(round.videoId);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6" style={{ background: "var(--bg)" }}>
      <button type="button" onClick={onClose} style={{ position: "absolute", top: 20, right: 20, ...focusNavBtn }}>
        ✕ 關閉 · Close
      </button>
      <p style={{ fontSize: 12, color: "var(--text3)" }}>{index + 1} / {rounds.length}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
        <p style={{ fontSize: 20, fontWeight: 900, color: "var(--ink)" }}>{round.title}</p>
        <p style={{ fontSize: 14, color: "var(--text2)" }}>{round.artist}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 420 }}>
        {/* Always editable, even with no AI-generated data — the table (LyricsTable.tsx) has
            the same fix, see its comment. A song AI can't confidently generate for shouldn't be
            a dead end; the host may already know the song and just needs a way to type it in. */}
        {!hasData && !lyricsPreviewLoading && (
          <p style={{ textAlign: "center", color: "var(--text3)", fontSize: 12, margin: 0 }}>
            AI 沒有這首歌的資料，可手動輸入 · No AI data for this song — enter it yourself below
          </p>
        )}
        <textarea rows={3} value={draft.lyricContext} placeholder={lyricsPreviewLoading ? "…" : "Question"}
          onChange={(e) => setField("lyricContext", e.target.value)}
          style={{ ...focusFieldBox, fontSize: 15, resize: "vertical" }} />
        <input type="text" value={draft.blankSentence} placeholder={lyricsPreviewLoading ? "…" : "Answer"}
          onChange={(e) => setField("blankSentence", e.target.value)}
          style={{ ...focusFieldBox, fontSize: 16, fontWeight: 900, color: "var(--orange)" }} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={lyricInstruction} onChange={(e) => setLyricInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") onProposeLyricEdits(); }}
            placeholder="例如：「第2首的答案打錯了，應該是愛你」 · e.g. round 2's answer has a typo"
            disabled={proposingLyricEdits}
            style={{ flex: 1, borderRadius: 8, padding: "8px 12px", fontSize: 12, outline: "none", background: "rgba(26,26,46,.04)", color: "var(--ink)", border: "1.5px solid rgba(255,107,53,.15)" }} />
          <button type="button" onClick={onProposeLyricEdits} disabled={proposingLyricEdits || !lyricInstruction.trim()}
            style={{ flexShrink: 0, borderRadius: 8, background: "var(--orange)", padding: "8px 16px", fontSize: 12, fontWeight: 900, color: "white", border: "none", cursor: "pointer", opacity: proposingLyricEdits || !lyricInstruction.trim() ? 0.6 : 1 }}>
            {proposingLyricEdits ? "詢問中…" : "✨ Ask AI"}
          </button>
        </div>
        {proposeLyricError && <p style={{ color: "var(--red)", fontSize: 11, textAlign: "center" }}>{proposeLyricError}</p>}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button type="button" onClick={() => setIndex((i) => i - 1)} disabled={index === 0}
          style={{ ...focusNavBtn, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? "not-allowed" : "pointer" }}>
          ← 上一首 · Prev
        </button>
        {dirty && (
          <button type="button" onClick={handleApply}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 900, cursor: "pointer" }}>
            套用 · Apply
          </button>
        )}
        <button type="button" onClick={() => setIndex((i) => i + 1)} disabled={index === rounds.length - 1}
          style={{ ...focusNavBtn, opacity: index === rounds.length - 1 ? 0.4 : 1, cursor: index === rounds.length - 1 ? "not-allowed" : "pointer" }}>
          下一首 · Next →
        </button>
      </div>
    </div>
  );
}

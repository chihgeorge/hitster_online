"use client";

// Extracted from app/room/[code]/host/page.tsx (T5, docs/designs/full-page-focus-editor.md) —
// pure extraction, zero behavior change, same discipline as T1's use-item-draft.ts. Surfaced
// by the plan-eng-review's outside-voice pass: Lyrics mode had no componentization step going
// into an already-1000+-line file. This is the table view the new Lyrics Focus editor (T6)
// will sit alongside, not replace.

import type { Dispatch, SetStateAction } from "react";
import type { EditableSong, PublicLyricsGameState, PublicLyricsRound } from "@/lib/game";

interface Props {
  lyricsPreviewLoading: boolean;
  lyricsState: PublicLyricsGameState | null;
  lyricsPreview: PublicLyricsRound[];
  readySongs: EditableSong[];
  lyricOverrides: Record<string, { lyricContext?: string; blankSentence?: string }>;
  setLyricOverrides: Dispatch<SetStateAction<Record<string, { lyricContext?: string; blankSentence?: string }>>>;
  pendingLyricsStart: boolean;
  lyricInstruction: string;
  setLyricInstruction: (value: string) => void;
  proposingLyricEdits: boolean;
  onProposeLyricEdits: () => void;
  proposeLyricError: string | null;
}

export default function LyricsTable({
  lyricsPreviewLoading, lyricsState, lyricsPreview, readySongs, lyricOverrides, setLyricOverrides,
  pendingLyricsStart, lyricInstruction, setLyricInstruction, proposingLyricEdits, onProposeLyricEdits, proposeLyricError,
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p style={{ fontSize: 12, color: "var(--text3)", margin: 0 }}>
        {lyricsPreviewLoading
          ? "⏳ 正在生成歌詞題目… Generating questions…"
          : (lyricsState?.rounds?.length ?? 0) > 0
            ? `${lyricsState!.rounds.length} songs selected for this game`
            : lyricsPreview.length > 0
              ? `${lyricsPreview.length} / ${readySongs.length} songs have questions ready`
              : `${readySongs.length} songs loaded`}
      </p>
      {(lyricsState?.rounds?.length ?? 0) === 0 && !pendingLyricsStart && lyricsPreview.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={lyricInstruction}
              onChange={(e) => setLyricInstruction(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onProposeLyricEdits(); }}
              placeholder="例如：「第2首的答案打錯了，應該是愛你」 · e.g. round 2's answer has a typo"
              disabled={proposingLyricEdits}
              style={{ flex: 1, borderRadius: 8, padding: "6px 10px", fontSize: 12, outline: "none", background: "rgba(26,26,46,.04)", color: "var(--ink)", border: "1.5px solid rgba(255,107,53,.15)" }}
            />
            <button
              type="button"
              onClick={onProposeLyricEdits}
              disabled={proposingLyricEdits || !lyricInstruction.trim()}
              style={{ flexShrink: 0, borderRadius: 8, background: "var(--orange)", padding: "6px 14px", fontSize: 12, fontWeight: 900, color: "white", border: "none", cursor: "pointer", opacity: proposingLyricEdits || !lyricInstruction.trim() ? 0.6 : 1 }}
            >
              {proposingLyricEdits ? "詢問中…" : "✨ Ask AI"}
            </button>
          </div>
          {proposeLyricError && <p style={{ fontSize: 10, color: "var(--red)" }}>{proposeLyricError}</p>}
        </div>
      )}
      <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid rgba(255,107,53,.12)" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(255,107,53,.12)" }}>
              {(["#", "Title", "Artist", "Question", "Answer"] as const).map((h) => (
                <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontWeight: 700, color: "var(--text3)", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(() => {
              // After game starts: show selected deck (lyricsState.rounds)
              if ((lyricsState?.rounds?.length ?? 0) > 0) {
                return lyricsState!.rounds.map((lr, i) => (
                  <tr key={lr.videoId} style={{ borderBottom: "1px solid rgba(255,107,53,.07)", background: i % 2 === 0 ? "transparent" : "rgba(255,107,53,.02)" }}>
                    <td style={{ padding: "8px 14px", color: "var(--text3)", fontFamily: "var(--font-mono)", width: 32 }}>{i + 1}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 700, color: "var(--ink)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.title}</td>
                    <td style={{ padding: "8px 14px", color: "var(--text2)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.artist}</td>
                    <td style={{ padding: "8px 14px", color: "var(--text2)", fontFamily: "var(--font-zh)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.lyricContext ?? "—"}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 900, color: lr.blankSentence ? "var(--orange)" : "#D0CEDC", fontFamily: "var(--font-zh)", whiteSpace: "nowrap" }}>{lr.blankSentence ?? "—"}</td>
                  </tr>
                ));
              }
              // Preview loaded: merge preview data + host overrides into readySongs rows
              const previewMap = new Map(lyricsPreview.map((r) => [r.videoId, r]));
              return readySongs.map((s, i) => {
                const lr = previewMap.get(s.videoId);
                const ov = lyricOverrides[s.videoId] ?? {};
                const qValue = ov.lyricContext ?? lr?.lyricContext ?? "";
                const aValue = ov.blankSentence ?? lr?.blankSentence ?? "";
                const hasData = !!(lr?.lyricContext || lr?.blankSentence);
                const cellBase: React.CSSProperties = { padding: "4px 8px", fontFamily: "var(--font-zh)", fontSize: 12, width: "100%", border: "none", outline: "none", borderRadius: 4, background: "transparent" };
                return (
                  <tr key={s.videoId} style={{ borderBottom: "1px solid rgba(255,107,53,.07)", background: i % 2 === 0 ? "transparent" : "rgba(255,107,53,.02)" }}>
                    <td style={{ padding: "8px 14px", color: "var(--text3)", fontFamily: "var(--font-mono)", width: 32 }}>{i + 1}</td>
                    <td style={{ padding: "8px 14px", fontWeight: 700, color: "var(--ink)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</td>
                    <td style={{ padding: "8px 14px", color: "var(--text2)", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artist}</td>
                    <td style={{ maxWidth: 240, padding: "4px 6px" }}>
                      {/* Always editable, even with no AI-generated data (regression per host
                          testing: a song the AI can't confidently generate for — no lrclib hit,
                          no confident memory — used to show a plain "—" with no way to type in
                          a question manually. Asking AI again hits the same no-invention rule,
                          so a host who already knows the song had no way in at all. */}
                      <textarea
                        rows={2}
                        value={qValue}
                        placeholder={lyricsPreviewLoading ? "…" : hasData ? "—" : "手動輸入歌詞片段…"}
                        readOnly={pendingLyricsStart}
                        onChange={(e) => { if (!pendingLyricsStart) setLyricOverrides((prev) => ({ ...prev, [s.videoId]: { ...prev[s.videoId], lyricContext: e.target.value } })); }}
                        style={{ ...cellBase, color: ov.lyricContext ? "var(--ink)" : "var(--text2)", resize: "vertical", minHeight: 40, opacity: pendingLyricsStart ? 0.6 : 1 }}
                      />
                    </td>
                    <td style={{ maxWidth: 180, padding: "4px 6px" }}>
                      <input
                        type="text"
                        value={aValue}
                        placeholder={lyricsPreviewLoading ? "…" : hasData ? "—" : "手動輸入答案…"}
                        readOnly={pendingLyricsStart}
                        onChange={(e) => { if (!pendingLyricsStart) setLyricOverrides((prev) => ({ ...prev, [s.videoId]: { ...prev[s.videoId], blankSentence: e.target.value } })); }}
                        style={{ ...cellBase, fontWeight: 900, color: ov.blankSentence ? "var(--ink)" : aValue ? "var(--orange)" : "#D0CEDC", opacity: pendingLyricsStart ? 0.6 : 1 }}
                      />
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      </div>
    </div>
  );
}

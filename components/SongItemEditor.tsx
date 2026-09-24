"use client";

// Timeline-mode Focus editor (T4, docs/designs/full-page-focus-editor.md): full-page,
// one-song-at-a-time view on /playlists, additive to PlaylistEditor.tsx's existing table —
// same data (EditableSong), same draft-tracking hook (lib/use-item-draft.ts, T1), same
// UPDATE_SONG save path. AI editing here calls party/playlist.ts's PROPOSE_EDITS HTTP action
// (T3) directly, since this page has no room WebSocket to route it through like
// host/page.tsx's chat-to-diff box does.

import { useState } from "react";
import type { EditableSong, SongEditDiff } from "@/lib/game";
import { isValidYear } from "@/lib/utils";
import { useItemDraft } from "@/lib/use-item-draft";
import { focusFieldBox, focusNavBtn } from "./focus-editor-styles";

interface Props {
  playlistId: string;
  songs: EditableSong[];
  hostId: string;
  partyKitHost: string;
  onSongsChange: (songs: EditableSong[]) => void;
  onClose: () => void;
}

function partyUrl(partyKitHost: string, playlistId: string): string {
  const protocol = partyKitHost.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${partyKitHost}/parties/playlist/${playlistId}`;
}

export default function SongItemEditor({ playlistId, songs, hostId, partyKitHost, onSongsChange, onClose }: Props) {
  const { getDraft, setField: setDraftField, isDirty, discard } = useItemDraft<EditableSong>();
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);

  const song = songs[index];
  // Boundary guard — e.g. the list shrank (a delete elsewhere) out from under the current
  // index. No wraparound per Success Criteria; just don't render past the edges.
  if (!song) return null;
  const draft = getDraft(song);
  const dirty = isDirty(song);

  function setField(field: keyof EditableSong, value: string | number | null) {
    setDraftField(song.videoId, field, value as EditableSong[typeof field]);
    setError(null);
  }

  async function handleAskAI() {
    const trimmed = instruction.trim();
    if (!trimmed || proposing) return;
    setProposing(true);
    setProposeError(null);
    try {
      const res = await fetch(partyUrl(partyKitHost, playlistId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHostId: hostId, action: "PROPOSE_EDITS", instruction: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { diff?: SongEditDiff[]; error?: string };
      if (!res.ok) { setProposeError(body.error ?? "無法處理，請再試一次 · Couldn't process that, try again"); return; }
      const diff = body.diff ?? [];
      if (diff.length === 0) { setProposeError("AI 沒有找到對應的更改 · No matching changes found"); return; }
      // Same reviewable-diff pattern as PlaylistEditor's table — becomes a dirty draft the
      // host reviews and Saves, never applied straight to the server.
      for (const d of diff) setDraftField(d.videoId, d.field, d.newValue ?? "");
      setInstruction("");
    } catch {
      setProposeError("無法處理，請再試一次 · Couldn't process that, try again");
    } finally {
      setProposing(false);
    }
  }

  async function handleSave() {
    if (!draft.title.trim()) { setError("Title cannot be empty"); return; }
    if (!isValidYear(draft.year)) { setError(`Year must be 1900–${new Date().getFullYear() + 1}`); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(partyUrl(partyKitHost, playlistId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHostId: hostId, action: "UPDATE_SONG", videoId: song.videoId, title: draft.title, artist: draft.artist, year: draft.year }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? "update_failed");
        return;
      }
      onSongsChange(songs.map((s) => (s.videoId === song.videoId ? { ...s, ...draft } : s)));
      discard(song.videoId);
    } catch {
      setError("update_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 px-6" style={{ background: "var(--bg)" }}>
      <button type="button" onClick={onClose} style={{ position: "absolute", top: 20, right: 20, ...focusNavBtn }}>
        ✕ 關閉 · Close
      </button>
      <p style={{ fontSize: 12, color: "var(--text3)" }}>{index + 1} / {songs.length}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 420 }}>
        <input type="text" value={draft.title} onChange={(e) => setField("title", e.target.value)}
          placeholder="Title" style={{ ...focusFieldBox, fontSize: 24, fontWeight: 900 }} />
        <input type="text" value={draft.artist} onChange={(e) => setField("artist", e.target.value)}
          placeholder="Artist" style={{ ...focusFieldBox, fontSize: 16 }} />
        <input type="number" value={draft.year ?? ""} min={1900} max={new Date().getFullYear() + 1}
          onChange={(e) => { const v = parseInt(e.target.value, 10); setField("year", isNaN(v) ? null : v); }}
          placeholder="Year" style={{ ...focusFieldBox, fontSize: 16, fontFamily: "var(--font-mono)" }} />
        {error && <p style={{ color: "var(--red)", fontSize: 12, textAlign: "center" }}>{error}</p>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", maxWidth: 420 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAskAI(); }}
            placeholder="例如：「年份錯了，應該是1998」 · e.g. fix the year, it's 1998"
            disabled={proposing}
            style={{ flex: 1, borderRadius: 8, padding: "8px 12px", fontSize: 12, outline: "none", background: "rgba(26,26,46,.04)", color: "var(--ink)", border: "1.5px solid rgba(255,107,53,.15)" }} />
          <button type="button" onClick={() => void handleAskAI()} disabled={proposing || !instruction.trim()}
            style={{ flexShrink: 0, borderRadius: 8, background: "var(--orange)", padding: "8px 16px", fontSize: 12, fontWeight: 900, color: "white", border: "none", cursor: "pointer", opacity: proposing || !instruction.trim() ? 0.6 : 1 }}>
            {proposing ? "詢問中…" : "✨ Ask AI"}
          </button>
        </div>
        {proposeError && <p style={{ color: "var(--red)", fontSize: 11, textAlign: "center" }}>{proposeError}</p>}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button type="button" onClick={() => setIndex((i) => i - 1)} disabled={index === 0}
          style={{ ...focusNavBtn, opacity: index === 0 ? 0.4 : 1, cursor: index === 0 ? "not-allowed" : "pointer" }}>
          ← 上一首 · Prev
        </button>
        {dirty && (
          <button type="button" onClick={() => void handleSave()} disabled={saving}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 12, padding: "10px 20px", fontSize: 13, fontWeight: 900, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving…" : "儲存 · Save"}
          </button>
        )}
        <button type="button" onClick={() => setIndex((i) => i + 1)} disabled={index === songs.length - 1}
          style={{ ...focusNavBtn, opacity: index === songs.length - 1 ? 0.4 : 1, cursor: index === songs.length - 1 ? "not-allowed" : "pointer" }}>
          下一首 · Next →
        </button>
      </div>
    </div>
  );
}

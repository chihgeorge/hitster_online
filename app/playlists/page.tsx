"use client";

// Standalone quiz-bank page (docs/designs/decouple-quiz-bank.md, T5) — create and edit
// playlists ahead of time, with no room required. Reuses party/playlist.ts's existing CRUD
// and PlaylistEditor's manual-editing table as-is; the only new server call this page makes
// is party/playlist.ts's RESOLVE_FROM_URL action (T2) and party/library.ts's GET/PUT (T3).
//
// AI chat-to-diff editing (PlaylistEditor's "✨ Ask AI" box) is intentionally NOT wired up
// here yet — decision D4 deferred that to its own follow-up (a 3rd implementation of
// PROPOSE_EDITS as an HTTP action, since this page has no room WebSocket to send it over).
// A host who wants AI-assisted fixes loads the playlist into a real room first, same as today.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import PlaylistEditor from "@/components/PlaylistEditor";
import { getOrCreatePersistedId } from "@/lib/device-id";
import type { EditableSong } from "@/lib/game";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";

function partyUrl(party: "playlist" | "library", id: string): string {
  const protocol = PARTYKIT_HOST.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${PARTYKIT_HOST}/parties/${party}/${id}`;
}

interface LibraryEntry {
  id: string;
  name: string;
  songCount: number;
}

type CreateStatus = "idle" | "creating" | "error";

export default function PlaylistsPage() {
  const hostIdRef = useRef<string>("");
  const [library, setLibrary] = useState<LibraryEntry[] | null>(null); // null = still loading
  const [libraryError, setLibraryError] = useState("");

  const [createUrl, setCreateUrl] = useState("");
  const [createName, setCreateName] = useState("");
  const [createStatus, setCreateStatus] = useState<CreateStatus>("idle");
  const [createError, setCreateError] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSongs, setSelectedSongs] = useState<EditableSong[]>([]);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState("");

  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    hostIdRef.current = getOrCreatePersistedId("hitster_host_id");
    void refreshLibrary();
  }, []);

  async function refreshLibrary() {
    try {
      const res = await fetch(partyUrl("library", hostIdRef.current));
      if (!res.ok) { setLibraryError("載入失敗 · Failed to load your library"); return; }
      const body = (await res.json()) as { entries: LibraryEntry[] };
      setLibrary(body.entries);
      setLibraryError("");
    } catch {
      setLibraryError("載入失敗 · Failed to load your library");
    }
  }

  async function handleCreate() {
    const url = createUrl.trim();
    const name = createName.trim();
    if (!url || !name) return;
    setCreateStatus("creating");
    setCreateError("");
    try {
      const id = crypto.randomUUID();
      const res = await fetch(partyUrl("playlist", id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHostId: hostIdRef.current, name, action: "RESOLVE_FROM_URL", playlistUrl: url }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setCreateError(body.error ?? "建立失敗 · Failed to create playlist");
        setCreateStatus("error");
        return;
      }
      setCreateUrl("");
      setCreateName("");
      setCreateStatus("idle");
      await refreshLibrary();
      void handleSelect(id);
    } catch {
      setCreateError("建立失敗 · Failed to create playlist");
      setCreateStatus("error");
    }
  }

  async function handleSelect(id: string) {
    setSelectedId(id);
    setSelectedLoading(true);
    setSelectedError("");
    setSelectedSongs([]);
    try {
      const res = await fetch(partyUrl("playlist", id));
      if (!res.ok) { setSelectedError("載入失敗 · Failed to load this playlist"); return; }
      const playlist = (await res.json()) as { songs: EditableSong[] };
      setSelectedSongs(playlist.songs);
    } catch {
      setSelectedError("載入失敗 · Failed to load this playlist");
    } finally {
      setSelectedLoading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(partyUrl("playlist", id), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHostId: hostIdRef.current }),
      });
      if (!res.ok) return;
      if (selectedId === id) { setSelectedId(null); setSelectedSongs([]); }
      await refreshLibrary();
    } finally {
      setDeletingId(null);
    }
  }

  const panel: React.CSSProperties = {
    background: "white", borderRadius: 20, padding: 24,
    boxShadow: "0 4px 24px rgba(255,107,53,.07), 0 1px 4px rgba(0,0,0,.04)",
  };
  const inp: React.CSSProperties = {
    background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
    padding: "12px 16px", fontSize: 14, color: "var(--ink)", outline: "none", fontFamily: "var(--font-zh)",
  };

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-5 py-12" style={{ background: "var(--bg)" }}>
      <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <Link href="/" style={{ fontSize: 12, color: "var(--text3)", textDecoration: "underline" }}>← 回首頁 · Back home</Link>
          <h1 className="title-outlined" style={{ fontSize: 32, marginTop: 8 }}>我的播放清單庫</h1>
          <p style={{ color: "var(--text2)", fontSize: 13, marginTop: 4 }}>
            Your Quiz Library — 提前建立播放清單，開房間時直接載入 · Build playlists ahead of time, load them when you host
          </p>
        </div>

        {/* Create new */}
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 style={{ fontWeight: 900, fontSize: 14, color: "var(--ink)" }}>+ 新增播放清單 · New Playlist</h2>
          <input type="text" placeholder="播放清單名稱 · Playlist name" value={createName}
            onChange={(e) => setCreateName(e.target.value)} style={inp} disabled={createStatus === "creating"} />
          <input type="text" placeholder="https://www.youtube.com/playlist?list=..." value={createUrl}
            onChange={(e) => setCreateUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
            style={{ ...inp, fontFamily: "var(--font-mono)", fontSize: 13 }} disabled={createStatus === "creating"} />
          <button type="button" onClick={() => void handleCreate()}
            disabled={createStatus === "creating" || !createUrl.trim() || !createName.trim()}
            style={{
              background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "12px",
              fontSize: 14, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)",
              opacity: (createStatus === "creating" || !createUrl.trim() || !createName.trim()) ? 0.45 : 1,
            }}>
            {createStatus === "creating" ? "建立中… Creating…" : "建立 · Create"}
          </button>
          {createError && <p style={{ fontSize: 12, color: "var(--red)" }}>{createError}</p>}
        </div>

        {/* Library list */}
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ fontWeight: 900, fontSize: 14, color: "var(--ink)" }}>已儲存 · Saved ({library?.length ?? 0})</h2>
          {library === null && !libraryError && <p style={{ fontSize: 12, color: "var(--text3)" }}>載入中… Loading…</p>}
          {libraryError && <p style={{ fontSize: 12, color: "var(--red)" }}>{libraryError}</p>}
          {library?.length === 0 && <p style={{ fontSize: 12, color: "var(--text3)" }}>還沒有播放清單 · No playlists yet</p>}
          {library?.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--bg)", border: "2px solid rgba(255,107,53,.12)", borderRadius: 14, padding: "12px 14px" }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{p.name}</p>
                <p style={{ fontSize: 11, color: "var(--text3)" }}>{p.songCount} 首歌曲 · songs</p>
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button type="button" onClick={() => void handleSelect(p.id)}
                  style={{ background: "rgba(255,107,53,.12)", border: "none", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 900, color: "var(--orange)", cursor: "pointer" }}>
                  編輯 · Edit
                </button>
                <button type="button" disabled={deletingId === p.id} onClick={() => void handleDelete(p.id)}
                  style={{ background: "var(--surface2)", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, color: "var(--text3)", cursor: "pointer", opacity: deletingId === p.id ? 0.5 : 1 }}>
                  {deletingId === p.id ? "…" : "✕"}
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Editor for the selected playlist */}
        {selectedId && (
          <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}>
            <h2 style={{ fontWeight: 900, fontSize: 14, color: "var(--ink)" }}>
              {library?.find((p) => p.id === selectedId)?.name ?? "編輯 · Editing"}
            </h2>
            {selectedLoading && <p style={{ fontSize: 12, color: "var(--text3)" }}>載入中… Loading…</p>}
            {selectedError && <p style={{ fontSize: 12, color: "var(--red)" }}>{selectedError}</p>}
            {!selectedLoading && !selectedError && selectedSongs.length > 0 && (
              <PlaylistEditor
                playlistId={selectedId}
                songs={selectedSongs}
                hostId={hostIdRef.current}
                partyKitHost={PARTYKIT_HOST}
                onSongsChange={setSelectedSongs}
              />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

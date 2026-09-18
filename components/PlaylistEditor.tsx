"use client";

import { useState } from "react";
import type { EditableSong } from "@/lib/game";
import { isValidYear } from "@/lib/utils";

interface Props {
  playlistId: string | null;
  songs: EditableSong[];
  hostId: string;
  partyKitHost: string;
  onSongsChange: (songs: EditableSong[]) => void;
}

function partyUrl(partyKitHost: string, playlistId: string): string {
  const protocol = partyKitHost.startsWith("localhost") ? "http" : "https";
  return `${protocol}://${partyKitHost}/parties/playlist/${playlistId}`;
}

export default function PlaylistEditor({ playlistId, songs, hostId, partyKitHost, onSongsChange }: Props) {
  const [editing, setEditing] = useState<Record<string, Partial<EditableSong>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [savingAll, setSavingAll] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  function setField(videoId: string, field: keyof EditableSong, value: string | number) {
    setEditing((prev) => ({
      ...prev,
      [videoId]: { ...prev[videoId], [field]: value },
    }));
    setErrors((prev) => { const n = { ...prev }; delete n[videoId]; return n; });
  }

  function getDraft(song: EditableSong): EditableSong {
    const overrides = editing[song.videoId] ?? {};
    return {
      videoId: song.videoId,
      title: (overrides.title as string | undefined) ?? song.title,
      artist: (overrides.artist as string | undefined) ?? song.artist,
      year: (overrides.year as number | null | undefined) ?? song.year,
    };
  }

  function isDirty(song: EditableSong): boolean {
    const ov = editing[song.videoId];
    if (!ov) return false;
    return (
      (ov.title !== undefined && ov.title !== song.title) ||
      (ov.artist !== undefined && ov.artist !== song.artist) ||
      (ov.year !== undefined && ov.year !== song.year)
    );
  }

  async function handleSaveSong(song: EditableSong) {
    const draft = getDraft(song);
    if (!draft.title.trim()) {
      setErrors((prev) => ({ ...prev, [song.videoId]: "Title cannot be empty" }));
      return;
    }
    if (!isValidYear(draft.year)) {
      setErrors((prev) => ({ ...prev, [song.videoId]: `Year must be 1900–${new Date().getFullYear() + 1}` }));
      return;
    }
    if (!playlistId) {
      // No saved playlist yet — apply locally only
      onSongsChange(songs.map((s) => s.videoId === song.videoId ? { ...s, ...draft } : s));
      setEditing((prev) => { const n = { ...prev }; delete n[song.videoId]; return n; });
      return;
    }
    setSaving((prev) => ({ ...prev, [song.videoId]: true }));
    try {
      const res = await fetch(partyUrl(partyKitHost, playlistId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerHostId: hostId,
          action: "UPDATE_SONG",
          videoId: song.videoId,
          title: draft.title,
          artist: draft.artist,
          year: draft.year,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrors((prev) => ({ ...prev, [song.videoId]: body.error ?? "update_failed" }));
        return;
      }
      onSongsChange(songs.map((s) => s.videoId === song.videoId ? { ...s, ...draft } : s));
      setEditing((prev) => { const n = { ...prev }; delete n[song.videoId]; return n; });
    } catch {
      setErrors((prev) => ({ ...prev, [song.videoId]: "update_failed" }));
    } finally {
      setSaving((prev) => { const n = { ...prev }; delete n[song.videoId]; return n; });
    }
  }

  async function handleSaveAll() {
    const dirtySongs = songs.filter(isDirty);
    if (dirtySongs.length === 0) return;

    // Validate all up front; show errors and bail if any are invalid.
    const validationErrors: Record<string, string> = {};
    for (const song of dirtySongs) {
      const draft = getDraft(song);
      if (!draft.title.trim()) validationErrors[song.videoId] = "Title cannot be empty";
      else if (!isValidYear(draft.year)) validationErrors[song.videoId] = `Year must be 1900–${new Date().getFullYear() + 1}`;
    }
    if (Object.keys(validationErrors).length > 0) {
      setErrors((prev) => ({ ...prev, ...validationErrors }));
      return;
    }

    // Snapshot drafts before any async work to avoid stale-closure issues.
    const drafts = new Map(dirtySongs.map((s) => [s.videoId, getDraft(s)]));

    if (!playlistId) {
      // Local-only: apply all in one shot.
      onSongsChange(songs.map((s) => { const d = drafts.get(s.videoId); return d ? { ...s, ...d } : s; }));
      setEditing({});
      return;
    }

    // Server save: fire all PUTs in parallel.
    setSavingAll(true);
    setSaving((prev) => {
      const n = { ...prev };
      for (const s of dirtySongs) n[s.videoId] = true;
      return n;
    });

    const results = await Promise.allSettled(
      dirtySongs.map(async (song) => {
        const draft = drafts.get(song.videoId)!;
        const res = await fetch(partyUrl(partyKitHost, playlistId), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ownerHostId: hostId, action: "UPDATE_SONG", videoId: song.videoId, title: draft.title, artist: draft.artist, year: draft.year }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "update_failed");
        }
        return song.videoId;
      })
    );

    const saved = new Set<string>();
    const failErrors: Record<string, string> = {};
    results.forEach((r, i) => {
      const id = dirtySongs[i].videoId;
      if (r.status === "fulfilled") saved.add(id);
      else failErrors[id] = r.reason instanceof Error ? r.reason.message : "update_failed";
    });

    if (saved.size > 0) {
      onSongsChange(songs.map((s) => { const d = drafts.get(s.videoId); return saved.has(s.videoId) && d ? { ...s, ...d } : s; }));
      setEditing((prev) => { const n = { ...prev }; for (const id of saved) delete n[id]; return n; });
    }
    if (Object.keys(failErrors).length > 0) setErrors((prev) => ({ ...prev, ...failErrors }));

    setSaving((prev) => { const n = { ...prev }; for (const s of dirtySongs) delete n[s.videoId]; return n; });
    setSavingAll(false);
  }

  async function handleDeleteSong(song: EditableSong) {
    if (songs.length <= 2) {
      setErrors((prev) => ({ ...prev, [song.videoId]: "Cannot delete — playlist needs at least 2 songs" }));
      return;
    }
    if (!playlistId) {
      // No saved playlist yet — remove locally only
      onSongsChange(songs.filter((s) => s.videoId !== song.videoId));
      return;
    }
    setDeleting((prev) => ({ ...prev, [song.videoId]: true }));
    try {
      const res = await fetch(partyUrl(partyKitHost, playlistId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerHostId: hostId,
          action: "DELETE_SONG",
          videoId: song.videoId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrors((prev) => ({ ...prev, [song.videoId]: body.error ?? "delete_failed" }));
        return;
      }
      onSongsChange(songs.filter((s) => s.videoId !== song.videoId));
    } catch {
      setErrors((prev) => ({ ...prev, [song.videoId]: "delete_failed" }));
    } finally {
      setDeleting((prev) => { const n = { ...prev }; delete n[song.videoId]; return n; });
    }
  }

  const dirtyCount = songs.filter(isDirty).length;

  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-400">
          {playlistId
            ? "Changes are saved directly to the stored playlist. Manual edits override the original metadata."
            : "Click Apply on a row to update it for this game. Save the playlist above to persist edits across sessions."}
        </p>
        {dirtyCount > 0 && (
          <button
            type="button"
            disabled={savingAll}
            onClick={() => void handleSaveAll()}
            style={{ flexShrink: 0, borderRadius: 8, background: "#FF6B35", padding: "6px 12px", fontSize: 12, fontWeight: 900, color: "white", border: "none", cursor: "pointer" }}
          >
            {savingAll ? "Saving…" : `${playlistId ? "Save" : "Apply"} all (${dirtyCount})`}
          </button>
        )}
      </div>
      <div className="overflow-x-auto rounded-xl" style={{ border: "1px solid rgba(255,107,53,.12)" }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left" style={{ borderBottom: "1px solid rgba(255,107,53,.12)", color: "#7B7B9A" }}>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Artist</th>
              <th className="px-3 py-2 font-medium w-20">Year</th>
              <th className="px-3 py-2 font-medium w-24"></th>
            </tr>
          </thead>
          <tbody>
            {songs.map((song) => {
              const draft = getDraft(song);
              const dirty = isDirty(song);
              const isSaving = saving[song.videoId] ?? false;
              const isDeleting = deleting[song.videoId] ?? false;
              const err = errors[song.videoId];
              return (
                <tr key={song.videoId} style={{ borderBottom: "1px solid rgba(255,107,53,.07)" }}>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={draft.title}
                      onChange={(e) => setField(song.videoId, "title", e.target.value)}
                      className="w-full rounded px-2 py-1 outline-none" style={{ background: "rgba(26,26,46,.04)", color: "#1A1A2E", border: "1.5px solid rgba(255,107,53,.15)" }}
                    />
                    {err && <p className="text-red-400 text-[10px] mt-0.5">{err}</p>}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={draft.artist}
                      onChange={(e) => setField(song.videoId, "artist", e.target.value)}
                      className="w-full rounded px-2 py-1 outline-none" style={{ background: "rgba(26,26,46,.04)", color: "#7B7B9A", border: "1.5px solid rgba(255,107,53,.15)" }}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      value={draft.year ?? ""}
                      placeholder="Year"
                      min={1900}
                      max={new Date().getFullYear() + 1}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        setField(song.videoId, "year", isNaN(v) ? (null as unknown as number) : v);
                      }}
                      className="w-full rounded px-2 py-1 outline-none" style={{ background: "rgba(26,26,46,.04)", fontFamily: "var(--font-mono)", color: draft.year == null ? "#B0AFBC" : "#FF6B35", border: "1.5px solid rgba(255,107,53,.15)" }}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1 justify-end">
                      {dirty && (
                        <button
                          type="button"
                          disabled={isSaving}
                          onClick={() => void handleSaveSong(song)}
                          style={{ borderRadius: 6, padding: "4px 8px", background: "rgba(255,107,53,.2)", color: "#FF6B35", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700 }}
                        >
                          {isSaving ? "…" : playlistId ? "Save" : "Apply"}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={() => void handleDeleteSong(song)}
                        className="rounded px-2 py-1 transition-colors disabled:opacity-40" style={{ background: "rgba(26,26,46,.04)", color: "#B0AFBC" }}
                      >
                        {isDeleting ? "…" : "✕"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

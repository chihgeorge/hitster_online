"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import PlaylistEditor from "@/components/PlaylistEditor";
import { Qr } from "@/components/Qr";
import { getOrCreatePersistedId } from "@/lib/device-id";
import type { GameState, ServerMessage, ClientMessage, SongDiagnostic, EditableSong, PublicLyricsGameState, PublicLyricsRound, LyricsGameConfig, SongEditDiff, EditableLyricRound, LyricEditDiff } from "@/lib/game";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST || "localhost:1999";

type SavedPlaylistMeta = { id: string; name: string; songCount: number };

function loadSavedPlaylistIndex(): SavedPlaylistMeta[] {
  try {
    return JSON.parse(localStorage.getItem("hitster_playlists") ?? "[]") as SavedPlaylistMeta[];
  } catch {
    return [];
  }
}

function saveSavedPlaylistIndex(index: SavedPlaylistMeta[]) {
  try {
    localStorage.setItem("hitster_playlists", JSON.stringify(index));
  } catch {}
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

export default function HostPage() {
  const params = useParams<{ code: string }>();
  const [state, setState] = useState<GameState | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [error, setError] = useState("");
  const [loadStatus, setLoadStatus] = useState<LoadStatus>("idle");
  const [readySongCount, setReadySongCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [diagnostic, setDiagnostic] = useState<SongDiagnostic[] | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showContinuePrompt, setShowContinuePrompt] = useState(false);
  // Saved playlists
  const [readySongs, setReadySongs] = useState<EditableSong[]>([]);
  const [proposingEdits, setProposingEdits] = useState(false);
  const [proposedDiff, setProposedDiff] = useState<SongEditDiff[] | null>(null);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [savedPlaylists, setSavedPlaylists] = useState<SavedPlaylistMeta[]>([]);
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [savePlaylistName, setSavePlaylistName] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [loadById, setLoadById] = useState("");
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [skippedEmbeddingCount, setSkippedEmbeddingCount] = useState(0);
  // Lyrics Mode
  const [gameMode, setGameMode] = useState<"timeline" | "lyrics">("timeline");
  const [lyricsState, setLyricsState] = useState<PublicLyricsGameState | null>(null);
  const [lyricsPreview, setLyricsPreview] = useState<PublicLyricsRound[]>([]);
  const [lyricsPreviewLoading, setLyricsPreviewLoading] = useState(false);
  const [lyricOverrides, setLyricOverrides] = useState<Record<string, { lyricContext?: string; blankSentence?: string }>>({});
  const [lyricsConfig, setLyricsConfig] = useState<LyricsGameConfig>({ timerSeconds: 60, totalRounds: 10, fuzzyEnabled: false });
  const [lyricInstruction, setLyricInstruction] = useState("");
  const [proposingLyricEdits, setProposingLyricEdits] = useState(false);
  const [proposeLyricError, setProposeLyricError] = useState<string | null>(null);
  const hostIdRef = useRef<string>("");
  const loadedUrlRef = useRef<string>("");
  const readySongsRef = useRef<EditableSong[]>([]);
  const nextPromptAtRef = useRef<number>(0);
  const pendingStartAfterAbortRef = useRef<boolean>(false);
  const pendingSavedIdRef = useRef<string | null>(null);

  useEffect(() => {
    hostIdRef.current = getOrCreatePersistedId("hitster_host_id");
    setSavedPlaylists(loadSavedPlaylistIndex());
  }, []);

  // 5-minute checkpoint timer: show prompt if loading takes too long.
  useEffect(() => {
    if (loadStatus !== "loading") {
      setShowContinuePrompt(false);
      return;
    }
    const interval = setInterval(() => {
      if (Date.now() >= nextPromptAtRef.current) {
        setShowContinuePrompt(true);
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  useEffect(() => {
    readySongsRef.current = readySongs;
  }, [readySongs]);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      if (msg.type === "STATE") {
        setState(msg.state);
        if (msg.state.phase !== "lobby") setStarting(false);
        // When game resets back to lobby, clear load state for fresh setup.
        if (msg.state.phase === "lobby" && state?.phase !== "lobby") {
          setLoadStatus("idle");
          setDiagnostic(null);
          setSkippedEmbeddingCount(0);
          setPlaylistUrl("");
          setReadySongs([]);
          setShowSavePanel(false);
          setSavedId(null);
          setLyricsPreview([]);
          setLyricsPreviewLoading(false);
          setLyricOverrides({});
        }
      }
      if (msg.type === "ERROR") {
        setError(msg.error);
        setStarting(false);
      }
      if (msg.type === "DIAGNOSTIC") {
        setDiagnostic(msg.songs);
        if (msg.skippedEmbeddingCount) setSkippedEmbeddingCount(msg.skippedEmbeddingCount);
      }
      if (msg.type === "PLAYLIST_READY") {
        setReadySongCount(msg.songCount);
        setReadySongs(Array.isArray(msg.songs) ? msg.songs : []);
        setLoadStatus("ready");
        setShowSavePanel(false);
        const incomingSavedId = pendingSavedIdRef.current;
        setSavedId(incomingSavedId);
        if (incomingSavedId) setShowEditor(true);
        pendingSavedIdRef.current = null;
        setShowContinuePrompt(false);
        if (pendingStartAfterAbortRef.current) {
          pendingStartAfterAbortRef.current = false;
          setStarting(true);
          socket.send(JSON.stringify({
            type: "START_GAME" as const,
            hostId: hostIdRef.current,
            playlistUrl: loadedUrlRef.current,
            targetCardCount: targetCount,
            songs: readySongsRef.current,
          }));
        }
      }
      if (msg.type === "PLAYLIST_LOAD_ERROR") {
        setError(msg.error);
        setLoadStatus("error");
      }
      if (msg.type === "LYRICS_STATE") setLyricsState(msg.state);
      if (msg.type === "LYRICS_ABORTED") setLyricsState(null);
      if (msg.type === "LYRICS_PREVIEW") {
        setLyricsPreviewLoading(msg.loading);
        if (!msg.loading) setLyricsPreview(msg.rounds);
      }
      if (msg.type === "EDITS_PROPOSED") {
        setProposingEdits(false);
        setProposeError(msg.diff.length === 0 ? "AI 沒有找到對應的更改 · No matching changes found" : null);
        if (msg.diff.length > 0) setProposedDiff(msg.diff);
      }
      if (msg.type === "EDITS_PROPOSAL_FAILED") {
        setProposingEdits(false);
        setProposeError("無法處理，請再試一次 · Couldn't process that, try again");
      }
      if (msg.type === "LYRIC_EDITS_PROPOSED") {
        setProposingLyricEdits(false);
        setProposeLyricError(msg.diff.length === 0 ? "AI 沒有找到對應的更改 · No matching changes found" : null);
        // Applied directly to lyricOverrides — same dirty-row-review pattern as the timeline
        // mode's PlaylistEditor, just inline here since the Lyrics table isn't its own component.
        for (const d of msg.diff) {
          setLyricOverrides((prev) => ({ ...prev, [d.videoId]: { ...prev[d.videoId], [d.field]: d.newValue ?? "" } }));
        }
      }
      if (msg.type === "LYRIC_EDITS_PROPOSAL_FAILED") {
        setProposingLyricEdits(false);
        setProposeLyricError("無法處理，請再試一次 · Couldn't process that, try again");
      }
    },
  });

  function send(msg: ClientMessage) {
    socket.send(JSON.stringify(msg));
  }

  function handleProposeEdits(instruction: string) {
    setProposingEdits(true);
    setProposeError(null);
    send({ type: "PROPOSE_EDITS", hostId: hostIdRef.current, instruction, songs: readySongsRef.current });
  }

  function handleProposeLyricEdits() {
    const trimmed = lyricInstruction.trim();
    if (!trimmed || proposingLyricEdits) return;
    const previewMap = new Map(lyricsPreview.map((r) => [r.videoId, r]));
    const rounds: EditableLyricRound[] = readySongs
      .map((s) => {
        const lr = previewMap.get(s.videoId);
        const ov = lyricOverrides[s.videoId] ?? {};
        const lyricContext = ov.lyricContext ?? lr?.lyricContext ?? "";
        const blankSentence = ov.blankSentence ?? lr?.blankSentence ?? "";
        return lyricContext || blankSentence
          ? { videoId: s.videoId, title: s.title, artist: s.artist, lyricContext, blankSentence }
          : null;
      })
      .filter((r): r is EditableLyricRound => r !== null);
    if (rounds.length === 0) return;
    setProposingLyricEdits(true);
    setProposeLyricError(null);
    send({ type: "PROPOSE_LYRIC_EDITS", hostId: hostIdRef.current, instruction: trimmed, rounds });
    setLyricInstruction("");
  }

  function handleLoadPlaylist() {
    const url = playlistUrl.trim();
    if (!url) { setError("missing_url"); return; }
    setError("");
    setDiagnostic(null);
    setSkippedEmbeddingCount(0);
    setLoadStatus("loading");
    setShowContinuePrompt(false);
    pendingStartAfterAbortRef.current = false;
    pendingSavedIdRef.current = null;
    loadedUrlRef.current = url;
    nextPromptAtRef.current = Date.now() + 5 * 60 * 1000;
    send({ type: "LOAD_PLAYLIST", hostId: hostIdRef.current, playlistUrl: url, gameMode });
  }

  function handleStartGame(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (gameMode === "lyrics") {
      const overrides = Object.entries(lyricOverrides)
        .filter(([, v]) => v.lyricContext !== undefined || v.blankSentence !== undefined)
        .map(([videoId, v]) => ({ videoId, ...v }));
      send({
        type: "START_LYRICS_GAME",
        hostId: hostIdRef.current,
        playlistUrl: loadedUrlRef.current,
        config: lyricsConfig,
        ...(overrides.length > 0 ? { lyricOverrides: overrides } : {}),
      });
      return;
    }
    setStarting(true);
    send({
      type: "START_GAME",
      hostId: hostIdRef.current,
      playlistUrl: loadedUrlRef.current,
      targetCardCount: targetCount,
      songs: readySongsRef.current,
    });
  }

  function handleConfirmLyricsPreview() {
    send({ type: "CONFIRM_LYRICS_PREVIEW", hostId: hostIdRef.current });
  }

  function handleStartLyricsRound() {
    send({ type: "START_LYRICS_ROUND", hostId: hostIdRef.current });
  }

  function handleShowLyricsResults() {
    send({ type: "SHOW_LYRICS_RESULTS", hostId: hostIdRef.current });
  }

  function handleNextLyricsRound() {
    send({ type: "NEXT_LYRICS_ROUND", hostId: hostIdRef.current });
  }

  function handleResetLyricsGame() {
    send({ type: "RESET_LYRICS_GAME", hostId: hostIdRef.current });
    setLyricsState(null);
  }

  function handleReveal() {
    send({ type: "REVEAL", hostId: hostIdRef.current });
  }

  function handleNextRound() {
    send({ type: "NEXT_ROUND", hostId: hostIdRef.current });
  }

  function handleResetGame() {
    send({ type: "RESET_GAME", hostId: hostIdRef.current });
  }

  async function handleSavePlaylist() {
    const name = savePlaylistName.trim();
    if (!name) return;
    if (readySongs.length === 0) {
      setSaveError("No songs loaded yet — load a YouTube playlist first, then save.");
      return;
    }
    setSaveError("");
    setSaving(true);
    setError("");
    try {
      const id = crypto.randomUUID();
      const protocol = PARTYKIT_HOST.startsWith("localhost") ? "http" : "https";
      const res = await fetch(`${protocol}://${PARTYKIT_HOST}/parties/playlist/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerHostId: hostIdRef.current,
          name,
          songs: readySongs,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(body.error ?? "Failed to save playlist — please try again.");
        return;
      }
      const meta: SavedPlaylistMeta = { id, name, songCount: readySongs.length };
      const newIndex = [...savedPlaylists, meta];
      saveSavedPlaylistIndex(newIndex);
      setSavedPlaylists(newIndex);
      setSavedId(id);
      setShowSavePanel(false);
      setSavePlaylistName("");
      setShowEditor(true);
    } catch {
      setSaveError("Failed to save playlist — please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleLoadSavedPlaylist(id: string) {
    setError("");
    setDiagnostic(null);
    setSkippedEmbeddingCount(0);
    setLoadStatus("loading");
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      setLoadStatus("error");
      setError("saved_playlist_not_found");
      return;
    }
    try {
      const protocol = PARTYKIT_HOST.startsWith("localhost") ? "http" : "https";
      const res = await fetch(`${protocol}://${PARTYKIT_HOST}/parties/playlist/${id}`);
      if (!res.ok) {
        setLoadStatus("error");
        setError("saved_playlist_not_found");
        return;
      }
      const playlist = (await res.json()) as { songs: EditableSong[] };
      if (!Array.isArray(playlist.songs) || playlist.songs.length < 2) {
        setLoadStatus("error");
        setError("not_enough_songs");
        return;
      }
      loadedUrlRef.current = id;
      pendingSavedIdRef.current = id;
      send({ type: "LOAD_SAVED_PLAYLIST", hostId: hostIdRef.current, playlistId: id, songs: playlist.songs });
    } catch {
      setLoadStatus("error");
      setError("saved_playlist_not_found");
    }
  }

  async function handleDeleteSavedPlaylist(id: string) {
    try {
      const protocol = PARTYKIT_HOST.startsWith("localhost") ? "http" : "https";
      const res = await fetch(`${protocol}://${PARTYKIT_HOST}/parties/playlist/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerHostId: hostIdRef.current }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    const newIndex = savedPlaylists.filter((p) => p.id !== id);
    saveSavedPlaylistIndex(newIndex);
    setSavedPlaylists(newIndex);
  }

  const phase = state?.phase ?? "lobby";
  const playerCount = Object.keys(state?.players ?? {}).length;

  const inp: React.CSSProperties = {
    background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
    padding: "12px 16px", fontSize: 14, color: "var(--ink)", outline: "none",
    fontFamily: "var(--font-zh)",
  };
  const panel: React.CSSProperties = {
    background: "white", borderRadius: 20, padding: 24,
    boxShadow: "0 4px 24px rgba(255,107,53,.07), 0 1px 4px rgba(0,0,0,.04)",
  };

  return (
    <div
      className={phase === "lobby" ? "bg-vinyl-pattern" : undefined}
      style={{
        minHeight: "100vh",
        // Inline `background` beats the class's background-image (inline style always wins), so
        // only set it here outside the lobby phase — .bg-vinyl-pattern supplies its own background-color.
        ...(phase === "lobby" ? {} : { background: "var(--bg)" }),
        display: "flex", flexDirection: "column", gap: 20, padding: 24, maxWidth: 960, margin: "0 auto",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <h1 className="title-outlined-sm" style={{ fontSize: 28, lineHeight: 1 }}>HITSTER!</h1>
          <div style={{ background: "white", borderRadius: 16, padding: "10px 20px", boxShadow: "0 2px 12px rgba(255,107,53,.1)", border: "2px solid rgba(255,107,53,.15)" }}>
            <p style={{ fontSize: 10, color: "var(--text3)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 2 }}>
              Room Code
            </p>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 26, letterSpacing: ".2em", color: "var(--orange)", fontWeight: 900, lineHeight: 1 }}>
              {params.code}
            </p>
          </div>
          {/* Big screen: open on a TV/projector. Never shown to players — the code above is the
              only thing they need, this link is host-only setup. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--surface2)", borderRadius: 16, padding: "10px 14px", border: "2px solid rgba(255,107,53,.15)" }}>
            <Qr text={typeof window !== "undefined" ? `${window.location.origin}/room/${params.code}/screen` : ""} size={64} alt="大螢幕 QR" />
            <div style={{ fontSize: 11, color: "var(--text2)", maxWidth: 120, lineHeight: 1.4 }}>
              📺 在電視或投影機掃描開啟大螢幕
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 13, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 1, minWidth: 0 }}>
          {Object.values(state?.players ?? {}).length === 0 ? (
            <span style={{ color: "var(--text3)" }}>No players yet</span>
          ) : (
            Object.values(state?.players ?? {}).map((p) => (
              <span key={p.name} style={{ color: "var(--text2)", fontWeight: 600 }}>{p.name}</span>
            ))
          )}
        </div>
      </div>

      {/* Starting spinner */}
      {phase === "lobby" && starting && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "64px 0" }}>
          <div style={{ position: "relative", width: 56, height: 56 }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid rgba(255,107,53,.15)" }} />
            <div className="animate-spin" style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid transparent", borderTopColor: "var(--orange)" }} />
          </div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>Starting game…</p>
        </div>
      )}

      {/* Lobby setup */}
      {phase === "lobby" && !starting && (!lyricsState || lyricsState.phase === "preview") && (
        <>
        <form onSubmit={handleStartGame} style={{ ...panel, display: "flex", flexDirection: "column", gap: 18 }}>
          <h2 style={{ fontWeight: 900, fontSize: 17, color: "var(--ink)" }}>設定遊戲 · Set Up Game</h2>

          {/* Setup controls: hidden while reviewing the generated lyrics deck */}
          {lyricsState?.phase !== "preview" && (<>
          {/* Mode picker */}
          <div style={{ display: "flex", gap: 0, background: "var(--surface2)", borderRadius: 12, padding: 4 }}>
            {(["timeline", "lyrics"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setGameMode(m)}
                style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer", fontWeight: 900, fontSize: 13, fontFamily: "var(--font-zh)", transition: "all .15s",
                  background: gameMode === m ? "var(--orange)" : "transparent",
                  color: gameMode === m ? "white" : "var(--text3)",
                  boxShadow: gameMode === m ? "0 2px 8px rgba(255,107,53,.3)" : "none",
                }}>
                {m === "timeline" ? "📅 時間軸模式" : "🎵 歌詞模式"}
              </button>
            ))}
          </div>

          {/* URL input + Load button */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)" }}>YouTube 播放清單 URL</label>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                type="url"
                placeholder="https://www.youtube.com/playlist?list=..."
                value={playlistUrl}
                onChange={(e) => {
                  setPlaylistUrl(e.target.value);
                  setError("");
                  if (loadStatus !== "idle") {
                    setLoadStatus("idle");
                    setDiagnostic(null);
                    setSkippedEmbeddingCount(0);
                  }
                }}
                style={{ ...inp, flex: 1 }}
              />
              <button
                type="button"
                data-testid="load-playlist-btn"
                onClick={handleLoadPlaylist}
                disabled={!playlistUrl.trim() || loadStatus === "loading"}
                style={{
                  flexShrink: 0, background: "var(--orange)", color: "white", border: "none", borderRadius: 14,
                  padding: "12px 20px", fontSize: 14, fontWeight: 900, cursor: "pointer",
                  fontFamily: "var(--font-zh)", opacity: (!playlistUrl.trim() || loadStatus === "loading") ? 0.45 : 1,
                  display: "flex", alignItems: "center", gap: 8, alignSelf: "stretch", boxSizing: "border-box",
                }}
              >
                {loadStatus === "loading" ? (
                  <>
                    <span className="animate-spin" style={{ display: "inline-block", width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(255,255,255,.3)", borderTopColor: "white" }} />
                    載入中…
                  </>
                ) : "載入 Load"}
              </button>
            </div>
          </div>
          </>)}

          {/* Loading progress */}
          {loadStatus === "loading" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ background: "var(--surface2)", borderRadius: 14, border: "2px solid rgba(255,107,53,.15)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: "var(--ink)" }}>查找發行年份中…</span>
                  {diagnostic && (
                    <span style={{ color: "var(--text3)" }}>
                      <span style={{ color: "var(--orange)", fontWeight: 900 }}>{diagnostic.filter((s) => s.year !== null).length}</span>
                      {" / "}{diagnostic.length}
                    </span>
                  )}
                </div>
                {diagnostic && (
                  <div style={{ width: "100%", background: "rgba(255,107,53,.12)", borderRadius: 99, height: 6, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", background: "var(--orange)", borderRadius: 99, transition: "width .5s",
                      width: `${Math.round((diagnostic.filter((s) => s.year !== null).length / Math.max(diagnostic.length, 1)) * 100)}%`,
                    }} />
                  </div>
                )}
              </div>
              {showContinuePrompt && (() => {
                const resolvedCount = diagnostic?.filter((s) => s.year !== null).length ?? 0;
                return (
                  <div style={{ background: "var(--surface2)", border: "2px solid rgba(255,107,53,.35)", borderRadius: 14, padding: "16px", display: "flex", flexDirection: "column", gap: 10 }}>
                    <p style={{ fontWeight: 900, fontSize: 13, color: "var(--orange-dk)" }}>仍在搜索年份中… Still searching</p>
                    <p style={{ fontSize: 12, color: "var(--text2)" }}>
                      已找到 <span style={{ color: "var(--orange)", fontWeight: 900 }}>{resolvedCount}</span> 首歌曲。繼續搜索或立即開始？
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => { setShowContinuePrompt(false); nextPromptAtRef.current = Date.now() + 5 * 60 * 1000; }}
                        style={{ flex: 1, background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 700, color: "var(--ink)", cursor: "pointer", fontFamily: "var(--font-zh)" }}
                      >
                        繼續搜索
                      </button>
                      <button
                        type="button"
                        disabled={resolvedCount < 2}
                        onClick={() => { setShowContinuePrompt(false); pendingStartAfterAbortRef.current = true; send({ type: "ABORT_LOAD", hostId: hostIdRef.current }); }}
                        style={{ flex: 1, background: resolvedCount < 2 ? "rgba(255,107,53,.35)" : "var(--orange)", border: "none", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 900, color: "white", cursor: resolvedCount < 2 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)" }}
                      >
                        立即開始 ({resolvedCount})
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {/* Ready state */}
          {loadStatus === "ready" && (
            <div style={{ background: "rgba(0,200,150,.06)", border: "2px solid rgba(0,200,150,.25)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--mint)", fontSize: 16 }}>✓</span>
                  <p style={{ color: "var(--mint)", fontWeight: 700, fontSize: 13 }}>
                    已載入 — {readySongCount} 首歌曲有確認年份
                  </p>
                </div>
                {savedId ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "var(--mint)" }}>已儲存 ✓</span>
                    <button type="button" onClick={() => { void navigator.clipboard.writeText(savedId); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      style={{ fontSize: 11, color: "var(--text2)", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono)" }} title={savedId}>
                      {copied ? "已複製!" : "複製 ID"}
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowSavePanel((v) => !v)}
                    style={{ fontSize: 11, color: "var(--text2)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>
                    儲存播放清單
                  </button>
                )}
              </div>
              {skippedEmbeddingCount > 0 && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "var(--orange-dk)" }}>
                  <span style={{ marginTop: 1 }}>⚠</span>
                  <span>{skippedEmbeddingCount} 個影片已跳過 — 版權持有人停用了嵌入播放，這些歌曲在本遊戲中無法播放。這是 YouTube 的限制，與 API 金鑰無關。</span>
                </div>
              )}
              {showSavePanel && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input type="text" placeholder="播放清單名稱" value={savePlaylistName}
                      onChange={(e) => { setSavePlaylistName(e.target.value); setSaveError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleSavePlaylist(); } }}
                      style={{ ...inp, flex: 1, padding: "10px 14px", fontSize: 13 }} />
                    <button type="button" disabled={!savePlaylistName.trim() || saving} onClick={() => void handleSavePlaylist()}
                      style={{ flexShrink: 0, background: "var(--orange)", color: "white", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", opacity: (!savePlaylistName.trim() || saving) ? 0.45 : 1, alignSelf: "stretch", display: "flex", alignItems: "center" }}>
                      {saving ? "儲存中…" : `儲存 ${readySongs.length > 0 ? `(${readySongs.length})` : ""}`}
                    </button>
                  </div>
                  {saveError && <p style={{ fontSize: 12, color: "var(--red)" }}>{saveError}</p>}
                </div>
              )}
              {gameMode === "timeline" && readySongs.length > 0 && (
                <button type="button" onClick={() => setShowEditor((v) => !v)}
                  style={{ background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 700, color: "var(--ink)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-zh)" }}>
                  {showEditor ? "▲ 隱藏歌曲編輯器" : "✎ 編輯歌曲資訊"}
                </button>
              )}
              {gameMode === "timeline" && showEditor && readySongs.length > 0 && (
                <PlaylistEditor
                  playlistId={savedId} songs={readySongs} hostId={hostIdRef.current} partyKitHost={PARTYKIT_HOST} onSongsChange={setReadySongs}
                  onProposeEdits={handleProposeEdits} proposing={proposingEdits} proposedDiff={proposedDiff} proposeError={proposeError}
                  onProposedDiffConsumed={() => setProposedDiff(null)}
                />
              )}
              {gameMode === "lyrics" && readySongs.length > 0 && (
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
                  {(lyricsState?.rounds?.length ?? 0) === 0 && lyricsPreview.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          type="text"
                          value={lyricInstruction}
                          onChange={(e) => setLyricInstruction(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") handleProposeLyricEdits(); }}
                          placeholder="例如：「第2首的答案打錯了，應該是愛你」 · e.g. round 2's answer has a typo"
                          disabled={proposingLyricEdits}
                          style={{ flex: 1, borderRadius: 8, padding: "6px 10px", fontSize: 12, outline: "none", background: "rgba(26,26,46,.04)", color: "var(--ink)", border: "1.5px solid rgba(255,107,53,.15)" }}
                        />
                        <button
                          type="button"
                          onClick={handleProposeLyricEdits}
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
                        const previewMap = new Map(lyricsPreview.map(r => [r.videoId, r]));
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
                                {hasData || lyricsPreviewLoading ? (
                                  <textarea
                                    rows={2}
                                    value={qValue}
                                    placeholder={lyricsPreviewLoading ? "…" : "—"}
                                    onChange={(e) => setLyricOverrides(prev => ({ ...prev, [s.videoId]: { ...prev[s.videoId], lyricContext: e.target.value } }))}
                                    style={{ ...cellBase, color: ov.lyricContext ? "var(--ink)" : "var(--text2)", resize: "vertical", minHeight: 40 }}
                                  />
                                ) : <span style={{ padding: "4px 8px", color: "#D0CEDC" }}>—</span>}
                              </td>
                              <td style={{ maxWidth: 180, padding: "4px 6px" }}>
                                {hasData || lyricsPreviewLoading ? (
                                  <input
                                    type="text"
                                    value={aValue}
                                    placeholder={lyricsPreviewLoading ? "…" : "—"}
                                    onChange={(e) => setLyricOverrides(prev => ({ ...prev, [s.videoId]: { ...prev[s.videoId], blankSentence: e.target.value } }))}
                                    style={{ ...cellBase, fontWeight: 900, color: ov.blankSentence ? "var(--ink)" : aValue ? "var(--orange)" : "#D0CEDC" }}
                                  />
                                ) : <span style={{ padding: "4px 8px", color: "#D0CEDC" }}>—</span>}
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
                </div>
              )}
            </div>
          )}

          {/* Error from load */}
          {loadStatus === "error" && error && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <ErrorBanner code={error} />
              <p style={{ fontSize: 12, color: "var(--text3)" }}>修正上方 URL 後再次點擊<strong style={{ color: "var(--ink)" }}>「載入」</strong>。</p>
            </div>
          )}

          {/* Error from starting Lyrics Mode (playlist itself loaded fine) */}
          {loadStatus === "ready" && error && !lyricsState && <ErrorBanner code={error} />}

          {/* Card count slider (timeline mode only) */}
          {loadStatus !== "loading" && gameMode === "timeline" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)" }}>
                勝利所需卡牌數：<span style={{ color: "var(--orange)", fontWeight: 900 }}>{targetCount}</span>
              </label>
              <input type="range" min={5} max={20} value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value))} className="w-full" />
            </div>
          )}

          {/* Lyrics config (lyrics mode only, hidden once preview is ready) */}
          {loadStatus !== "loading" && gameMode === "lyrics" && !lyricsState && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "var(--surface2)", borderRadius: 14, padding: 14, border: "2px solid rgba(255,107,53,.15)" }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)", marginBottom: 2 }}>歌詞模式設定</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)" }}>
                  回答時間：<span style={{ color: "var(--orange)", fontWeight: 900 }}>{lyricsConfig.timerSeconds}秒</span>
                </label>
                <input type="range" min={20} max={120} step={10} value={lyricsConfig.timerSeconds}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, timerSeconds: Number(e.target.value) }))} className="w-full" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)" }}>
                  回合數：<span style={{ color: "var(--orange)", fontWeight: 900 }}>{lyricsConfig.totalRounds}</span>
                </label>
                <input type="range" min={3} max={20} value={lyricsConfig.totalRounds}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, totalRounds: Number(e.target.value) }))} className="w-full" />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={lyricsConfig.fuzzyEnabled}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, fuzzyEnabled: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>寬鬆模式（允許拼字錯誤）</span>
              </label>
            </div>
          )}

          {/* Start Game — two states for lyrics: generate lyrics, then confirm to begin */}
          {loadStatus === "ready" && lyricsState?.phase === "preview" && (
            <button type="button" data-testid="start-game-btn" onClick={handleConfirmLyricsPreview} disabled={playerCount === 0}
              style={{ background: playerCount === 0 ? "rgba(255,107,53,.35)" : "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: playerCount === 0 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)", boxShadow: playerCount > 0 ? "0 4px 16px rgba(255,107,53,.3)" : "none" }}>
              ▶ 開始遊戲 · Start Game
            </button>
          )}
          {loadStatus === "ready" && !lyricsState && (
            <button type="submit" data-testid="start-game-btn" disabled={playerCount === 0}
              style={{ background: playerCount === 0 ? "rgba(255,107,53,.35)" : "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: playerCount === 0 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)", boxShadow: playerCount > 0 ? "0 4px 16px rgba(255,107,53,.3)" : "none" }}>
              {gameMode === "lyrics" ? "🎵 開始歌詞模式 · Start Lyrics" : "🎮 開始遊戲 · Start Game"}
            </button>
          )}

          {playerCount === 0 && (
            <p style={{ fontSize: 12, color: "var(--text3)", textAlign: "center" }}>
              分享代碼 <span style={{ fontFamily: "var(--font-mono)", color: "var(--orange)", fontWeight: 900 }}>{params.code}</span> — 等待玩家加入
            </p>
          )}
        </form>

        {/* Saved playlists panel */}
        {lyricsState?.phase !== "preview" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ fontWeight: 900, fontSize: 14, color: "var(--ink)" }}>已儲存的播放清單 · Saved Playlists</h3>
          <div style={{ display: "flex", gap: 10 }}>
            <input type="text" placeholder="貼上播放清單 ID 以從任何裝置載入…"
              value={loadById}
              onChange={(e) => setLoadById(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && loadById.trim()) { e.preventDefault(); void handleLoadSavedPlaylist(loadById.trim()); setLoadById(""); } }}
              style={{ ...inp, flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, padding: "10px 14px" }} />
            <button type="button" disabled={!loadById.trim() || loadStatus === "loading"}
              onClick={() => { void handleLoadSavedPlaylist(loadById.trim()); setLoadById(""); }}
              style={{ flexShrink: 0, background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "10px 18px", fontSize: 13, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", opacity: (!loadById.trim() || loadStatus === "loading") ? 0.45 : 1, alignSelf: "stretch", display: "flex", alignItems: "center" }}>
              載入
            </button>
          </div>
          {savedPlaylists.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {savedPlaylists.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "var(--bg)", border: "2px solid rgba(255,107,53,.12)", borderRadius: 14, padding: "12px 14px" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{p.name}</p>
                    <p style={{ fontSize: 10, color: "var(--text3)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.id}</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button type="button" disabled={loadStatus === "loading"} onClick={() => void handleLoadSavedPlaylist(p.id)}
                      style={{ background: "rgba(255,107,53,.12)", border: "none", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 900, color: "var(--orange)", cursor: "pointer", opacity: loadStatus === "loading" ? 0.45 : 1 }}>
                      載入
                    </button>
                    <button type="button" onClick={() => void handleDeleteSavedPlaylist(p.id)}
                      style={{ background: "var(--surface2)", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, color: "var(--text3)", cursor: "pointer" }}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {savedPlaylists.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text3)" }}>此裝置尚無儲存的播放清單。載入後點擊「儲存播放清單」即可儲存。</p>
          )}
        </div>
        )}
        </>
      )}

      {/* Lyrics Mode: loading */}
      {lyricsState?.phase === "loading" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "48px 24px" }}>
          <div style={{ position: "relative", width: 56, height: 56 }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid rgba(255,107,53,.15)" }} />
            <div className="animate-spin" style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid transparent", borderTopColor: "var(--orange)" }} />
          </div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>AI 正在準備歌詞…</p>
          <p style={{ fontSize: 12, color: "var(--text3)" }}>Preparing lyrics with AI — this takes about 15–30 seconds</p>
        </div>
      )}

      {/* Lyrics Mode: playing — controls only, the lyric text and audio are on the big screen */}
      {lyricsState?.phase === "playing" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" }}>
            第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · {lyricsState.currentRound.title}
          </p>
          <button onClick={handleStartLyricsRound}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.3)" }}>
            ✂️ 切歌！Cut!
          </button>
        </div>
      )}

      {/* Lyrics Mode: guessing — controls only; timer and lyric text are on the big screen */}
      {lyricsState?.phase === "guessing" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" }}>
            第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · 搶答中 — 已作答 {Object.keys(lyricsState.answers).length} / {Object.keys(lyricsState.players).length}
          </p>
          <button onClick={handleShowLyricsResults}
            style={{ background: "var(--ink)", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            🔍 揭曉答案 · Show Results
          </button>
        </div>
      )}

      {/* Lyrics Mode: results — controls only; the results table is on the big screen */}
      {lyricsState?.phase === "results" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" }}>
            第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · 結果 — 答案：{lyricsState.currentRound.blankSentence ?? "（已揭曉）"}
          </p>
          <button onClick={handleNextLyricsRound}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.3)" }}>
            {lyricsState.currentRoundIndex + 1 >= lyricsState.totalRounds ? "🏆 查看排名 · See Rankings" : "▶ 下一回合 · Next Round"}
          </button>
        </div>
      )}

      {/* Lyrics Mode: ended — full rankings are on the big screen */}
      {lyricsState?.phase === "ended" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "36px 24px" }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".12em" }}>歌詞模式結束 · Lyrics Mode Over!</p>
          <h2 className="title-outlined" style={{ fontSize: 32, lineHeight: 1.05 }}>
            {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score)[0]?.[1]?.name ?? "?"}
          </h2>
          <button onClick={handleResetLyricsGame}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "14px 32px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            再玩一次 · Play Again
          </button>
        </div>
      )}

      {/* Timeline mode: in progress — controls only; the video and timelines are on the big screen */}
      {(phase === "guessing" || phase === "reveal") && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" }}>
            第 {state?.currentRound} 回合 · {state?.players[state?.activePlayerId ?? ""]?.name ?? "?"} 的回合
          </p>
          {phase === "guessing" && (
            <button
              data-testid="reveal-btn"
              onClick={handleReveal}
              disabled={Object.keys(state?.placements ?? {}).length === 0}
              style={{
                background: Object.keys(state?.placements ?? {}).length === 0 ? "rgba(255,107,53,.35)" : "var(--orange)",
                color: "white", border: "none", borderRadius: 14, padding: "15px",
                fontSize: 16, fontWeight: 900, cursor: Object.keys(state?.placements ?? {}).length === 0 ? "not-allowed" : "pointer",
                fontFamily: "var(--font-zh)", boxShadow: Object.keys(state?.placements ?? {}).length > 0 ? "0 4px 16px rgba(255,107,53,.3)" : "none",
              }}>
              {Object.keys(state?.placements ?? {}).length === 0
                ? "等待玩家放置… Waiting"
                : `揭曉答案 → Reveal (${Object.keys(state?.placements ?? {}).length} placed)`}
            </button>
          )}
          {phase === "reveal" && (
            <button data-testid="next-round-btn" onClick={handleNextRound}
              style={{ background: "var(--ink)", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
              下一回合 · Next Round
            </button>
          )}
        </div>
      )}

      {/* Timeline mode: ended — full standings are on the big screen */}
      {phase === "ended" && state && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "36px 24px" }}>
          <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".12em" }}>遊戲結束 · Winner!</p>
          <h2 className="title-outlined" style={{ fontSize: 32, lineHeight: 1.05 }}>
            {state.players[state.winner ?? ""]?.name ?? "Unknown"}
          </h2>
          <button onClick={handleResetGame}
            style={{ background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "14px 32px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            再玩一次 · Play Again
          </button>
        </div>
      )}

      {/* Song metadata panel */}
      {diagnostic && phase !== "lobby" && (
        <div style={{ background: "white", border: "2px solid rgba(255,107,53,.12)", borderRadius: 20, overflow: "hidden" }}>
          <button onClick={() => setShowDiagnostic((v) => !v)}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", fontSize: 13, color: "var(--text2)", background: "none", border: "none", cursor: "pointer" }}>
            <span>
              歌曲資料 ·{" "}
              <span style={{ color: "var(--orange)", fontWeight: 900 }}>{diagnostic.filter((s) => s.year !== null).length}</span>
              <span style={{ color: "var(--text3)" }}>/{diagnostic.length} 年份已解析</span>
            </span>
            <span style={{ fontSize: 11, color: "var(--text3)" }}>{showDiagnostic ? "▲ 收起" : "▼ 展開"}</span>
          </button>
          {showDiagnostic && (
            <div style={{ padding: "0 20px 20px" }}>
              <DiagnosticTable songs={diagnostic} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiagnosticTable({ songs, compact, hideYears }: { songs: SongDiagnostic[]; compact?: boolean; hideYears?: boolean }) {
  const resolved = songs.filter((s) => s.year !== null).length;
  const total = songs.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {!compact && (
        <p style={{ fontSize: 12, color: "var(--text2)" }}>
          已解析 <span style={{ color: "var(--orange)", fontWeight: 900 }}>{resolved}</span> / <span style={{ fontWeight: 700, color: "var(--ink)" }}>{total}</span> 首
        </p>
      )}
      <div style={{ overflowX: "auto", borderRadius: 14, border: "2px solid rgba(255,107,53,.1)" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid rgba(255,107,53,.1)" }}>
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "var(--text3)" }}>Title</th>
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "var(--text3)" }}>Artist</th>
              {!hideYears && <th style={{ padding: "8px 12px", fontWeight: 700, color: "var(--text3)" }}>Year</th>}
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "var(--text3)" }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {songs.map((s, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(255,107,53,.06)", opacity: s.year ? 1 : 0.4 }}>
                <td style={{ padding: "7px 12px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }} title={s.title}>{s.title}</td>
                <td style={{ padding: "7px 12px", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text2)" }} title={s.artist}>{s.artist}</td>
                {!hideYears && (
                  <td style={{ padding: "7px 12px", fontFamily: "var(--font-mono)", color: "var(--orange)", fontWeight: 700 }}>{s.year ?? "—"}</td>
                )}
                <td style={{ padding: "7px 12px" }}>
                  {s.yearSource === "description" && <span style={{ color: "var(--mint)" }}>YouTube</span>}
                  {s.yearSource === "title" && <span style={{ color: "#5B8DEF" }}>title</span>}
                  {s.yearSource === "ai" && <span style={{ color: "#7C3AED" }}>AI</span>}
                  {s.yearSource === "manual" && <span style={{ color: "var(--text3)" }}>manual</span>}
                  {s.yearSource === null && <span style={{ color: "var(--text3)" }}>not found</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorBanner({ code }: { code: string }) {
  const info = errorInfo(code);
  return (
    <div style={{ background: "rgba(255,59,92,.06)", border: "2px solid rgba(255,59,92,.25)", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
      <p style={{ color: "var(--red)", fontSize: 14, fontWeight: 700 }}>{info.message}</p>
      {info.detail && <p style={{ color: "var(--orange-dk)", fontSize: 12 }}>{info.detail}</p>}
      {info.hint && (
        <p style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>
          <span style={{ color: "var(--orange)", fontWeight: 700 }}>提示：</span> {info.hint}
        </p>
      )}
    </div>
  );
}

function errorInfo(code: string): { message: string; detail?: string; hint?: string } {
  if (code === "missing_url") return { message: "Paste a YouTube playlist URL" };
  if (code === "save_failed") return { message: "Could not save playlist", detail: "Check your connection and try again." };
  if (code === "saved_playlist_not_found") return { message: "Saved playlist not found", detail: "It may have been deleted or expired.", hint: "Try loading a YouTube playlist URL instead." };
  // Was "Host token mismatch — refresh and try again" — misleading, since refreshing never
  // helps: the claim is permanent for the room's lifetime (no re-claim path). The real cause
  // is always "someone got here first" — often the host themself, on another device.
  if (code === "unauthorized") return {
    message: "此房間已經有主持人了 · This room already has a host",
    detail: "可能是你，用了另一台裝置 · Maybe you, on another device.",
  };
  if (code === "quota_exceeded") return {
    message: "YouTube API quota exceeded",
    detail: "The daily quota for the YouTube Data API has been used up.",
    hint: "Try again after midnight Pacific Time when the quota resets.",
  };
  if (code === "not_enough_songs") return {
    message: "Not enough songs with known release years",
    detail: "Fewer than 2 songs had a resolvable year (from description, title, or AI lookup).",
    hint: "Try a playlist with more mainstream tracks, or one from YouTube Music.",
  };
  if (code === "api_key_missing") return {
    message: "API key not configured",
    detail: "The server is missing YOUTUBE_API_KEY.",
    hint: "Check that the environment variables are set in the PartyKit deployment.",
  };
  if (code === "playlist_forbidden") return {
    message: "Playlist access denied (403)",
    detail: "The YouTube API key may be restricted, or the playlist is private.",
    hint: "Make sure the playlist is public and the API key has no referrer/IP restrictions.",
  };
  if (code === "playlist_not_found") return {
    message: "Playlist not found (404)",
    detail: "YouTube returned a 404 for this playlist ID.",
    hint: "Double-check the URL — the playlist may have been deleted or set to private.",
  };
  if (code.startsWith("youtube_error:")) {
    const status = code.split(":")[1];
    return {
      message: `YouTube API error (HTTP ${status})`,
      detail: `The YouTube Data API returned status ${status}.`,
      hint: status === "400" ? "The playlist URL may be malformed." : "Check the API key and playlist visibility.",
    };
  }
  if (code === "playlist_load_failed") return {
    message: "Couldn't load this playlist",
    detail: "An unexpected error occurred while fetching the playlist.",
    hint: "Check the URL format: it should be a youtube.com/playlist?list=... link.",
  };
  return { message: `Error: ${code}` };
}

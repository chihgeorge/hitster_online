"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import MusicPlayer from "@/components/MusicPlayer";
import LyricsPlayer from "@/components/LyricsPlayer";
import PlayerList from "@/components/PlayerList";
import PlaylistEditor from "@/components/PlaylistEditor";
import type { GameState, ServerMessage, ClientMessage, SongDiagnostic, DiagnosticStatus, EditableSong, PublicLyricsGameState, PublicLyricsRound, LyricsGameConfig } from "@/lib/game";

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

function getOrCreateHostId(): string {
  const key = "hitster_host_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
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
  const [diagnosticStatus, setDiagnosticStatus] = useState<DiagnosticStatus | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const [showContinuePrompt, setShowContinuePrompt] = useState(false);
  // Saved playlists
  const [readySongs, setReadySongs] = useState<EditableSong[]>([]);
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
  const [lyricsTimerLeft, setLyricsTimerLeft] = useState<number | null>(null);
  const hostIdRef = useRef<string>("");
  const loadedUrlRef = useRef<string>("");
  const readySongsRef = useRef<EditableSong[]>([]);
  const nextPromptAtRef = useRef<number>(0);
  const pendingStartAfterAbortRef = useRef<boolean>(false);
  const pendingSavedIdRef = useRef<string | null>(null);

  useEffect(() => {
    hostIdRef.current = getOrCreateHostId();
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
          setDiagnosticStatus(null);
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
        setDiagnosticStatus(msg.status);
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
      if (msg.type === "LYRICS_STATE") {
        setLyricsState(msg.state);
        if (msg.state.phase === "lobby" || msg.state.phase === "ended") {
          setLyricsTimerLeft(null);
        }
      }
      if (msg.type === "LYRICS_ABORTED") setLyricsState(null);
      if (msg.type === "LYRICS_PREVIEW") {
        setLyricsPreviewLoading(msg.loading);
        if (!msg.loading) setLyricsPreview(msg.rounds);
      }
    },
  });

  // Lyrics countdown timer (client-side display only)
  useEffect(() => {
    if (lyricsState?.phase !== "guessing" || lyricsState.roundStart === null) {
      setLyricsTimerLeft(null);
      return;
    }
    const deadline = lyricsState.roundStart + lyricsState.timerSeconds * 1000;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLyricsTimerLeft(left);
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [lyricsState?.phase, lyricsState?.roundStart, lyricsState?.timerSeconds]);

  function send(msg: ClientMessage) {
    socket.send(JSON.stringify(msg));
  }

  function handleLoadPlaylist() {
    const url = playlistUrl.trim();
    if (!url) { setError("missing_url"); return; }
    setError("");
    setDiagnostic(null);
    setSkippedEmbeddingCount(0);
    setDiagnosticStatus(null);
    setLoadStatus("loading");
    setShowContinuePrompt(false);
    pendingStartAfterAbortRef.current = false;
    pendingSavedIdRef.current = null;
    loadedUrlRef.current = url;
    nextPromptAtRef.current = Date.now() + 5 * 60 * 1000;
    send({ type: "LOAD_PLAYLIST", hostId: hostIdRef.current, playlistUrl: url });
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
    setDiagnosticStatus(null);
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
    background: "#FFF0E8", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
    padding: "12px 16px", fontSize: 14, color: "#1A1A2E", outline: "none",
    fontFamily: "var(--font-zh)",
  };
  const panel: React.CSSProperties = {
    background: "white", borderRadius: 20, padding: 24,
    boxShadow: "0 4px 24px rgba(255,107,53,.07), 0 1px 4px rgba(0,0,0,.04)",
  };

  return (
    <div style={{ minHeight: "100vh", background: "#FFF9F5", display: "flex", flexDirection: "column", gap: 20, padding: 24, maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <h1 className="title-outlined-sm" style={{ fontSize: 28, lineHeight: 1 }}>HITSTER!</h1>
          <div style={{ background: "white", borderRadius: 16, padding: "10px 20px", boxShadow: "0 2px 12px rgba(255,107,53,.1)", border: "2px solid rgba(255,107,53,.15)" }}>
            <p style={{ fontSize: 10, color: "#B0AFBC", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 2 }}>
              Room Code
            </p>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 26, letterSpacing: ".2em", color: "#FF6B35", fontWeight: 900, lineHeight: 1 }}>
              {params.code}
            </p>
          </div>
        </div>
        <div style={{ textAlign: "right", fontSize: 13, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 1, minWidth: 0 }}>
          {Object.values(state?.players ?? {}).length === 0 ? (
            <span style={{ color: "#B0AFBC" }}>No players yet</span>
          ) : (
            Object.values(state?.players ?? {}).map((p) => (
              <span key={p.name} style={{ color: "#7B7B9A", fontWeight: 600 }}>{p.name}</span>
            ))
          )}
        </div>
      </div>

      {/* Starting spinner */}
      {phase === "lobby" && starting && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "64px 0" }}>
          <div style={{ position: "relative", width: 56, height: 56 }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid rgba(255,107,53,.15)" }} />
            <div className="animate-spin" style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid transparent", borderTopColor: "#FF6B35" }} />
          </div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1A2E" }}>Starting game…</p>
        </div>
      )}

      {/* Lobby setup */}
      {phase === "lobby" && !starting && (!lyricsState || lyricsState.phase === "preview") && (
        <>
        <form onSubmit={handleStartGame} style={{ ...panel, display: "flex", flexDirection: "column", gap: 18 }}>
          <h2 style={{ fontWeight: 900, fontSize: 17, color: "#1A1A2E" }}>設定遊戲 · Set Up Game</h2>

          {/* Setup controls: hidden while reviewing the generated lyrics deck */}
          {lyricsState?.phase !== "preview" && (<>
          {/* Mode picker */}
          <div style={{ display: "flex", gap: 0, background: "#FFF0E8", borderRadius: 12, padding: 4 }}>
            {(["timeline", "lyrics"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setGameMode(m)}
                style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer", fontWeight: 900, fontSize: 13, fontFamily: "var(--font-zh)", transition: "all .15s",
                  background: gameMode === m ? "#FF6B35" : "transparent",
                  color: gameMode === m ? "white" : "#B0AFBC",
                  boxShadow: gameMode === m ? "0 2px 8px rgba(255,107,53,.3)" : "none",
                }}>
                {m === "timeline" ? "📅 時間軸模式" : "🎵 歌詞模式"}
              </button>
            ))}
          </div>

          {/* URL input + Load button */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label style={{ fontSize: 12, fontWeight: 700, color: "#7B7B9A" }}>YouTube 播放清單 URL</label>
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
                    setDiagnosticStatus(null);
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
                  flexShrink: 0, background: "#FF6B35", color: "white", border: "none", borderRadius: 14,
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
              <div style={{ background: "#FFF0E8", borderRadius: 14, border: "2px solid rgba(255,107,53,.15)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13 }}>
                  <span style={{ fontWeight: 700, color: "#1A1A2E" }}>查找發行年份中…</span>
                  {diagnostic && (
                    <span style={{ color: "#B0AFBC" }}>
                      <span style={{ color: "#FF6B35", fontWeight: 900 }}>{diagnostic.filter((s) => s.year !== null).length}</span>
                      {" / "}{diagnostic.length}
                    </span>
                  )}
                </div>
                {diagnostic && (
                  <div style={{ width: "100%", background: "rgba(255,107,53,.12)", borderRadius: 99, height: 6, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", background: "#FF6B35", borderRadius: 99, transition: "width .5s",
                      width: `${Math.round((diagnostic.filter((s) => s.year !== null).length / Math.max(diagnostic.length, 1)) * 100)}%`,
                    }} />
                  </div>
                )}
              </div>
              {showContinuePrompt && (() => {
                const resolvedCount = diagnostic?.filter((s) => s.year !== null).length ?? 0;
                return (
                  <div style={{ background: "#FFF0E8", border: "2px solid rgba(255,107,53,.35)", borderRadius: 14, padding: "16px", display: "flex", flexDirection: "column", gap: 10 }}>
                    <p style={{ fontWeight: 900, fontSize: 13, color: "#E85520" }}>仍在搜索年份中… Still searching</p>
                    <p style={{ fontSize: 12, color: "#7B7B9A" }}>
                      已找到 <span style={{ color: "#FF6B35", fontWeight: 900 }}>{resolvedCount}</span> 首歌曲。繼續搜索或立即開始？
                    </p>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => { setShowContinuePrompt(false); nextPromptAtRef.current = Date.now() + 5 * 60 * 1000; }}
                        style={{ flex: 1, background: "#FFF0E8", border: "2px solid rgba(255,107,53,.2)", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 700, color: "#1A1A2E", cursor: "pointer", fontFamily: "var(--font-zh)" }}
                      >
                        繼續搜索
                      </button>
                      <button
                        type="button"
                        disabled={resolvedCount < 2}
                        onClick={() => { setShowContinuePrompt(false); pendingStartAfterAbortRef.current = true; send({ type: "ABORT_LOAD", hostId: hostIdRef.current }); }}
                        style={{ flex: 1, background: resolvedCount < 2 ? "rgba(255,107,53,.35)" : "#FF6B35", border: "none", borderRadius: 10, padding: "10px", fontSize: 13, fontWeight: 900, color: "white", cursor: resolvedCount < 2 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)" }}
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
                  <span style={{ color: "#00C896", fontSize: 16 }}>✓</span>
                  <p style={{ color: "#00C896", fontWeight: 700, fontSize: 13 }}>
                    已載入 — {readySongCount} 首歌曲有確認年份
                  </p>
                </div>
                {savedId ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: "#00C896" }}>已儲存 ✓</span>
                    <button type="button" onClick={() => { void navigator.clipboard.writeText(savedId); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                      style={{ fontSize: 11, color: "#7B7B9A", background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-mono)" }} title={savedId}>
                      {copied ? "已複製!" : "複製 ID"}
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowSavePanel((v) => !v)}
                    style={{ fontSize: 11, color: "#7B7B9A", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>
                    儲存播放清單
                  </button>
                )}
              </div>
              {skippedEmbeddingCount > 0 && (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "#E85520" }}>
                  <span style={{ marginTop: 1 }}>⚠</span>
                  <span>{skippedEmbeddingCount} 個影片已跳過 — 版權持有人停用了嵌入播放，這些歌曲在本遊戲中無法播放。這是 YouTube 的限制，與 API 金鑰無關。</span>
                </div>
              )}
              {diagnosticStatus && (diagnosticStatus.spotifyRateLimited || diagnosticStatus.kgBlocked) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {diagnosticStatus.spotifyRateLimited && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "#E85520" }}>
                      <span>⚠</span><span>Spotify 請求過於頻繁 — 部分年份可能遺失，請稍後再試。</span>
                    </div>
                  )}
                  {diagnosticStatus.kgBlocked && (
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, color: "#E85520" }}>
                      <span>⚠</span><span>Google Knowledge Graph 未啟用 — 請在 Google Cloud Console 中啟用以獲得更好的覆蓋率。</span>
                    </div>
                  )}
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
                      style={{ flexShrink: 0, background: "#FF6B35", color: "white", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", opacity: (!savePlaylistName.trim() || saving) ? 0.45 : 1, alignSelf: "stretch", display: "flex", alignItems: "center" }}>
                      {saving ? "儲存中…" : `儲存 ${readySongs.length > 0 ? `(${readySongs.length})` : ""}`}
                    </button>
                  </div>
                  {saveError && <p style={{ fontSize: 12, color: "#FF3B5C" }}>{saveError}</p>}
                </div>
              )}
              {gameMode === "timeline" && readySongs.length > 0 && (
                <button type="button" onClick={() => setShowEditor((v) => !v)}
                  style={{ background: "#FFF0E8", border: "2px solid rgba(255,107,53,.2)", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 700, color: "#1A1A2E", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-zh)" }}>
                  {showEditor ? "▲ 隱藏歌曲編輯器" : "✎ 編輯歌曲資訊"}
                </button>
              )}
              {gameMode === "timeline" && showEditor && readySongs.length > 0 && (
                <PlaylistEditor playlistId={savedId} songs={readySongs} hostId={hostIdRef.current} partyKitHost={PARTYKIT_HOST} onSongsChange={setReadySongs} />
              )}
              {gameMode === "lyrics" && readySongs.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <p style={{ fontSize: 12, color: "#B0AFBC", margin: 0 }}>
                    {lyricsPreviewLoading
                      ? "⏳ 正在生成歌詞題目… Generating questions…"
                      : (lyricsState?.rounds?.length ?? 0) > 0
                        ? `${lyricsState!.rounds.length} songs selected for this game`
                        : lyricsPreview.length > 0
                          ? `${lyricsPreview.length} / ${readySongs.length} songs have questions ready`
                          : `${readySongs.length} songs loaded`}
                  </p>
                <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid rgba(255,107,53,.12)" }}>
                  <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "1px solid rgba(255,107,53,.12)" }}>
                        {(["#", "Title", "Artist", "Question", "Answer"] as const).map((h) => (
                          <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontWeight: 700, color: "#B0AFBC", whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        // After game starts: show selected deck (lyricsState.rounds)
                        if ((lyricsState?.rounds?.length ?? 0) > 0) {
                          return lyricsState!.rounds.map((lr, i) => (
                            <tr key={lr.videoId} style={{ borderBottom: "1px solid rgba(255,107,53,.07)", background: i % 2 === 0 ? "transparent" : "rgba(255,107,53,.02)" }}>
                              <td style={{ padding: "8px 14px", color: "#B0AFBC", fontFamily: "var(--font-mono)", width: 32 }}>{i + 1}</td>
                              <td style={{ padding: "8px 14px", fontWeight: 700, color: "#1A1A2E", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.title}</td>
                              <td style={{ padding: "8px 14px", color: "#7B7B9A", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.artist}</td>
                              <td style={{ padding: "8px 14px", color: "#7B7B9A", fontFamily: "var(--font-zh)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lr.lyricContext ?? "—"}</td>
                              <td style={{ padding: "8px 14px", fontWeight: 900, color: lr.blankSentence ? "#FF6B35" : "#D0CEDC", fontFamily: "var(--font-zh)", whiteSpace: "nowrap" }}>{lr.blankSentence ?? "—"}</td>
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
                              <td style={{ padding: "8px 14px", color: "#B0AFBC", fontFamily: "var(--font-mono)", width: 32 }}>{i + 1}</td>
                              <td style={{ padding: "8px 14px", fontWeight: 700, color: "#1A1A2E", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</td>
                              <td style={{ padding: "8px 14px", color: "#7B7B9A", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artist}</td>
                              <td style={{ maxWidth: 240, padding: "4px 6px" }}>
                                {hasData || lyricsPreviewLoading ? (
                                  <textarea
                                    rows={2}
                                    value={qValue}
                                    placeholder={lyricsPreviewLoading ? "…" : "—"}
                                    onChange={(e) => setLyricOverrides(prev => ({ ...prev, [s.videoId]: { ...prev[s.videoId], lyricContext: e.target.value } }))}
                                    style={{ ...cellBase, color: ov.lyricContext ? "#1A1A2E" : "#7B7B9A", resize: "vertical", minHeight: 40 }}
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
                                    style={{ ...cellBase, fontWeight: 900, color: ov.blankSentence ? "#1A1A2E" : aValue ? "#FF6B35" : "#D0CEDC" }}
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
              <p style={{ fontSize: 12, color: "#B0AFBC" }}>修正上方 URL 後再次點擊<strong style={{ color: "#1A1A2E" }}>「載入」</strong>。</p>
            </div>
          )}

          {/* Error from starting Lyrics Mode (playlist itself loaded fine) */}
          {loadStatus === "ready" && error && !lyricsState && <ErrorBanner code={error} />}

          {/* Card count slider (timeline mode only) */}
          {loadStatus !== "loading" && gameMode === "timeline" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <label style={{ fontSize: 12, fontWeight: 700, color: "#7B7B9A" }}>
                勝利所需卡牌數：<span style={{ color: "#FF6B35", fontWeight: 900 }}>{targetCount}</span>
              </label>
              <input type="range" min={5} max={20} value={targetCount}
                onChange={(e) => setTargetCount(Number(e.target.value))} className="w-full" />
            </div>
          )}

          {/* Lyrics config (lyrics mode only, hidden once preview is ready) */}
          {loadStatus !== "loading" && gameMode === "lyrics" && !lyricsState && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, background: "#FFF0E8", borderRadius: 14, padding: 14, border: "2px solid rgba(255,107,53,.15)" }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "#7B7B9A", marginBottom: 2 }}>歌詞模式設定</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#7B7B9A" }}>
                  回答時間：<span style={{ color: "#FF6B35", fontWeight: 900 }}>{lyricsConfig.timerSeconds}秒</span>
                </label>
                <input type="range" min={20} max={120} step={10} value={lyricsConfig.timerSeconds}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, timerSeconds: Number(e.target.value) }))} className="w-full" />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: "#7B7B9A" }}>
                  回合數：<span style={{ color: "#FF6B35", fontWeight: 900 }}>{lyricsConfig.totalRounds}</span>
                </label>
                <input type="range" min={3} max={20} value={lyricsConfig.totalRounds}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, totalRounds: Number(e.target.value) }))} className="w-full" />
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={lyricsConfig.fuzzyEnabled}
                  onChange={(e) => setLyricsConfig((c) => ({ ...c, fuzzyEnabled: e.target.checked }))} />
                <span style={{ fontSize: 13, fontWeight: 700, color: "#1A1A2E" }}>寬鬆模式（允許拼字錯誤）</span>
              </label>
            </div>
          )}

          {/* Start Game — two states for lyrics: generate lyrics, then confirm to begin */}
          {loadStatus === "ready" && lyricsState?.phase === "preview" && (
            <button type="button" data-testid="start-game-btn" onClick={handleConfirmLyricsPreview} disabled={playerCount === 0}
              style={{ background: playerCount === 0 ? "rgba(255,107,53,.35)" : "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: playerCount === 0 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)", boxShadow: playerCount > 0 ? "0 4px 16px rgba(255,107,53,.3)" : "none" }}>
              ▶ 開始遊戲 · Start Game
            </button>
          )}
          {loadStatus === "ready" && !lyricsState && (
            <button type="submit" data-testid="start-game-btn" disabled={playerCount === 0}
              style={{ background: playerCount === 0 ? "rgba(255,107,53,.35)" : "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: playerCount === 0 ? "not-allowed" : "pointer", fontFamily: "var(--font-zh)", boxShadow: playerCount > 0 ? "0 4px 16px rgba(255,107,53,.3)" : "none" }}>
              {gameMode === "lyrics" ? "🎵 開始歌詞模式 · Start Lyrics" : "🎮 開始遊戲 · Start Game"}
            </button>
          )}

          {playerCount === 0 && (
            <p style={{ fontSize: 12, color: "#B0AFBC", textAlign: "center" }}>
              分享代碼 <span style={{ fontFamily: "var(--font-mono)", color: "#FF6B35", fontWeight: 900 }}>{params.code}</span> — 等待玩家加入
            </p>
          )}
        </form>

        {/* Saved playlists panel */}
        {lyricsState?.phase !== "preview" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ fontWeight: 900, fontSize: 14, color: "#1A1A2E" }}>已儲存的播放清單 · Saved Playlists</h3>
          <div style={{ display: "flex", gap: 10 }}>
            <input type="text" placeholder="貼上播放清單 ID 以從任何裝置載入…"
              value={loadById}
              onChange={(e) => setLoadById(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && loadById.trim()) { e.preventDefault(); void handleLoadSavedPlaylist(loadById.trim()); setLoadById(""); } }}
              style={{ ...inp, flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, padding: "10px 14px" }} />
            <button type="button" disabled={!loadById.trim() || loadStatus === "loading"}
              onClick={() => { void handleLoadSavedPlaylist(loadById.trim()); setLoadById(""); }}
              style={{ flexShrink: 0, background: "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "10px 18px", fontSize: 13, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", opacity: (!loadById.trim() || loadStatus === "loading") ? 0.45 : 1, alignSelf: "stretch", display: "flex", alignItems: "center" }}>
              載入
            </button>
          </div>
          {savedPlaylists.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {savedPlaylists.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: "#FFF9F5", border: "2px solid rgba(255,107,53,.12)", borderRadius: 14, padding: "12px 14px" }}>
                  <div style={{ minWidth: 0 }}>
                    <p style={{ fontWeight: 700, fontSize: 14, color: "#1A1A2E" }}>{p.name}</p>
                    <p style={{ fontSize: 10, color: "#B0AFBC", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.id}</p>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button type="button" disabled={loadStatus === "loading"} onClick={() => void handleLoadSavedPlaylist(p.id)}
                      style={{ background: "rgba(255,107,53,.12)", border: "none", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 900, color: "#FF6B35", cursor: "pointer", opacity: loadStatus === "loading" ? 0.45 : 1 }}>
                      載入
                    </button>
                    <button type="button" onClick={() => void handleDeleteSavedPlaylist(p.id)}
                      style={{ background: "#FFF0E8", border: "none", borderRadius: 10, padding: "7px 12px", fontSize: 12, color: "#B0AFBC", cursor: "pointer" }}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {savedPlaylists.length === 0 && (
            <p style={{ fontSize: 12, color: "#B0AFBC" }}>此裝置尚無儲存的播放清單。載入後點擊「儲存播放清單」即可儲存。</p>
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
            <div className="animate-spin" style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "4px solid transparent", borderTopColor: "#FF6B35" }} />
          </div>
          <p style={{ fontSize: 16, fontWeight: 700, color: "#1A1A2E" }}>AI 正在準備歌詞…</p>
          <p style={{ fontSize: 12, color: "#B0AFBC" }}>Preparing lyrics with AI — this takes about 15–30 seconds</p>
        </div>
      )}

      {/* Lyrics Mode: playing (show lyric context, ready to cut) */}
      {lyricsState?.phase === "playing" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".1em" }}>
              第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score).map(([id, p]) => (
                <span key={id} style={{ fontSize: 12, color: "#7B7B9A", fontWeight: 600 }}>{p.name}: <span style={{ color: "#FF6B35" }}>{p.score}</span></span>
              ))}
            </div>
          </div>
          <div style={{ background: "#FFF0E8", borderRadius: 16, textAlign: "center", padding: "40px 24px", border: "2px solid rgba(255,107,53,.15)" }}>
            <p style={{ fontSize: 11, color: "#B0AFBC", marginBottom: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em" }}>
              {lyricsState.currentRound.title} · {lyricsState.currentRound.artist}
            </p>
            <p style={{ fontSize: 28, fontWeight: 700, color: "#1A1A2E", lineHeight: 1.7, fontFamily: "var(--font-zh)", whiteSpace: "pre-wrap" }}>
              {lyricsState.currentRound.lyricContext}
            </p>
          </div>
          <button onClick={handleStartLyricsRound}
            style={{ background: "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.3)" }}>
            ✂️ 切歌！Cut!
          </button>
        </div>
      )}

      {/* Lyrics Mode: guessing (timer + answer count + reveal button) */}
      {lyricsState?.phase === "guessing" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".1em" }}>
              第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · 搶答中
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score).map(([id, p]) => (
                <span key={id} style={{ fontSize: 12, color: "#7B7B9A", fontWeight: 600 }}>{p.name}: <span style={{ color: "#FF6B35" }}>{p.score}</span></span>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <p style={{ fontSize: 12, color: "#7B7B9A" }}>倒數計時</p>
              <p style={{ fontSize: 48, fontWeight: 900, color: (lyricsTimerLeft ?? 99) <= 5 ? "#FF3B5C" : "#FF6B35", fontFamily: "var(--font-mono)", lineHeight: 1 }}>
                {lyricsTimerLeft ?? lyricsState.timerSeconds}
              </p>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, textAlign: "right" }}>
              <p style={{ fontSize: 12, color: "#7B7B9A" }}>已作答</p>
              <p style={{ fontSize: 32, fontWeight: 900, color: "#1A1A2E", lineHeight: 1 }}>
                {Object.keys(lyricsState.answers).length} / {Object.keys(lyricsState.players).length}
              </p>
            </div>
          </div>
          <div style={{ background: "#FFF0E8", borderRadius: 16, padding: "40px 24px", textAlign: "center", border: "2px solid rgba(255,107,53,.15)" }}>
            <p style={{ fontSize: 28, fontWeight: 700, color: "#1A1A2E", lineHeight: 1.7, fontFamily: "var(--font-zh)", whiteSpace: "pre-wrap" }}>
              {lyricsState.currentRound.lyricContext}
            </p>
          </div>
          <button onClick={handleShowLyricsResults}
            style={{ background: "#1A1A2E", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            🔍 揭曉答案 · Show Results
          </button>
        </div>
      )}

      {/* Lyrics Mode: results */}
      {lyricsState?.phase === "results" && lyricsState.currentRound && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".1em" }}>
              第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · 結果
            </p>
          </div>
          <div style={{ background: "#FFF0E8", borderRadius: 14, border: "2px solid rgba(255,107,53,.15)", overflow: "hidden" }}>
            <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,107,53,.15)" }}>
                  {(["Title", "Artist", "Lyric Question", "Answer"] as const).map((h) => (
                    <th key={h} style={{ padding: "8px 14px", textAlign: "left", fontWeight: 700, color: "#B0AFBC", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: "10px 14px", fontWeight: 700, color: "#1A1A2E", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lyricsState.currentRound.title}</td>
                  <td style={{ padding: "10px 14px", color: "#7B7B9A", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lyricsState.currentRound.artist}</td>
                  <td style={{ padding: "10px 14px", color: "#7B7B9A", fontFamily: "var(--font-zh)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lyricsState.currentRound.lyricContext ?? "—"}</td>
                  <td style={{ padding: "10px 14px", fontWeight: 900, color: "#FF6B35", fontFamily: "var(--font-zh)", whiteSpace: "nowrap" }}>{lyricsState.currentRound.blankSentence ?? "（已揭曉）"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score).map(([id, p]) => {
              const ans = lyricsState.answers[id];
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: ans?.correct ? "rgba(0,200,150,.06)" : "rgba(255,107,53,.04)", border: `2px solid ${ans?.correct ? "rgba(0,200,150,.25)" : "rgba(255,107,53,.15)"}`, borderRadius: 12, padding: "12px 14px" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#1A1A2E", flex: 1 }}>{p.name}</span>
                  {ans ? (
                    <>
                      <span style={{ fontSize: 14, color: "#7B7B9A", fontFamily: "var(--font-zh)" }}>{ans.text}</span>
                      <span style={{ fontSize: 13, fontWeight: 900, color: ans.correct ? "#00C896" : "#FF3B5C" }}>
                        {ans.correct ? `+${ans.points}` : "✗"}
                      </span>
                    </>
                  ) : <span style={{ fontSize: 12, color: "#B0AFBC" }}>未作答</span>}
                  <span style={{ fontSize: 13, fontWeight: 900, color: "#FF6B35", minWidth: 40, textAlign: "right" }}>{p.score}</span>
                </div>
              );
            })}
          </div>
          <button onClick={handleNextLyricsRound}
            style={{ background: "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.3)" }}>
            {lyricsState.currentRoundIndex + 1 >= lyricsState.totalRounds ? "🏆 查看排名 · See Rankings" : "▶ 下一回合 · Next Round"}
          </button>
        </div>
      )}

      {/* Lyrics Mode: ended */}
      {lyricsState?.phase === "ended" && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "48px 24px" }}>
          <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".12em" }}>歌詞模式結束 · Lyrics Mode Over!</p>
          <h2 className="title-outlined" style={{ fontSize: 40, lineHeight: 1.05 }}>
            {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score)[0]?.[1]?.name ?? "?"}
          </h2>
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(lyricsState.players).sort(([,a],[,b]) => b.score - a.score).map(([id, p], i) => (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: i === 0 ? "rgba(255,107,53,.06)" : "white", border: `2px solid ${i === 0 ? "rgba(255,107,53,.3)" : "rgba(255,107,53,.1)"}`, borderRadius: 14, padding: "14px 18px" }}>
                <span style={{ fontSize: 20, fontWeight: 900, color: i === 0 ? "#FF6B35" : "#B0AFBC", minWidth: 28 }}>#{i + 1}</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#1A1A2E", flex: 1 }}>{p.name}</span>
                <span style={{ fontSize: 24, fontWeight: 900, color: "#FF6B35", fontFamily: "var(--font-mono)" }}>{p.score}</span>
              </div>
            ))}
          </div>
          <button onClick={handleResetLyricsGame}
            style={{ background: "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "14px 32px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            再玩一次 · Play Again
          </button>
        </div>
      )}

      {/* Game in progress */}
      {(phase === "guessing" || phase === "reveal") && (
        <div style={{ ...panel, display: "grid", gridTemplateColumns: "1fr", gap: 24 }} className="lg:grid-cols-[1fr_480px]">
          <MusicPlayer
            currentSong={state?.currentSong ?? null}
            phase={phase}
            placementCount={Object.keys(state?.placements ?? {}).length}
            onReveal={handleReveal}
            onNextRound={handleNextRound}
          />
          <div>
            <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 12 }}>
              第 {state?.currentRound} 回合 · Round
            </p>
            <PlayerList
              players={state?.players ?? {}}
              placements={state?.placements ?? {}}
              targetCardCount={state?.targetCardCount ?? 10}
              activePlayerId={state?.activePlayerId}
              phase={phase}
            />
          </div>
        </div>
      )}

      {/* Game ended */}
      {phase === "ended" && state && (
        <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, padding: "48px 24px" }}>
          <p style={{ fontSize: 11, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".12em" }}>遊戲結束 · Winner!</p>
          <h2 className="title-outlined" style={{ fontSize: 40, lineHeight: 1.05 }}>
            {state.players[state.winner ?? ""]?.name ?? "Unknown"}
          </h2>
          <div style={{ width: "100%" }}>
            <PlayerList players={state.players} placements={{}} targetCardCount={state.targetCardCount} activePlayerId={null} />
          </div>
          <button onClick={handleResetGame}
            style={{ background: "#FF6B35", color: "white", border: "none", borderRadius: 14, padding: "14px 32px", fontSize: 15, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)" }}>
            再玩一次 · Play Again
          </button>
        </div>
      )}

      {/* Lyrics Mode audio: plays at round start, pauses on Cut (guessing), resumes on results */}
      {lyricsState && (
        <LyricsPlayer
          videoId={["playing", "guessing", "results"].includes(lyricsState.phase) ? (lyricsState.currentRound?.videoId ?? null) : null}
          playing={lyricsState.phase === "playing" || lyricsState.phase === "results"}
        />
      )}

      {/* Song metadata panel */}
      {diagnostic && phase !== "lobby" && (
        <div style={{ background: "white", border: "2px solid rgba(255,107,53,.12)", borderRadius: 20, overflow: "hidden" }}>
          <button onClick={() => setShowDiagnostic((v) => !v)}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", fontSize: 13, color: "#7B7B9A", background: "none", border: "none", cursor: "pointer" }}>
            <span>
              歌曲資料 ·{" "}
              <span style={{ color: "#FF6B35", fontWeight: 900 }}>{diagnostic.filter((s) => s.year !== null).length}</span>
              <span style={{ color: "#B0AFBC" }}>/{diagnostic.length} 年份已解析</span>
            </span>
            <span style={{ fontSize: 11, color: "#B0AFBC" }}>{showDiagnostic ? "▲ 收起" : "▼ 展開"}</span>
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
        <p style={{ fontSize: 12, color: "#7B7B9A" }}>
          已解析 <span style={{ color: "#FF6B35", fontWeight: 900 }}>{resolved}</span> / <span style={{ fontWeight: 700, color: "#1A1A2E" }}>{total}</span> 首
        </p>
      )}
      <div style={{ overflowX: "auto", borderRadius: 14, border: "2px solid rgba(255,107,53,.1)" }}>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid rgba(255,107,53,.1)" }}>
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "#B0AFBC" }}>Title</th>
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "#B0AFBC" }}>Artist</th>
              {!hideYears && <th style={{ padding: "8px 12px", fontWeight: 700, color: "#B0AFBC" }}>Year</th>}
              <th style={{ padding: "8px 12px", fontWeight: 700, color: "#B0AFBC" }}>Source</th>
            </tr>
          </thead>
          <tbody>
            {songs.map((s, i) => (
              <tr key={i} style={{ borderBottom: "1px solid rgba(255,107,53,.06)", opacity: s.year ? 1 : 0.4 }}>
                <td style={{ padding: "7px 12px", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#1A1A2E" }} title={s.title}>{s.title}</td>
                <td style={{ padding: "7px 12px", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#7B7B9A" }} title={s.artist}>{s.artist}</td>
                {!hideYears && (
                  <td style={{ padding: "7px 12px", fontFamily: "var(--font-mono)", color: "#FF6B35", fontWeight: 700 }}>{s.year ?? "—"}</td>
                )}
                <td style={{ padding: "7px 12px" }}>
                  {s.yearSource === "description" && <span style={{ color: "#00C896" }}>YouTube</span>}
                  {s.yearSource === "title" && <span style={{ color: "#5B8DEF" }}>title</span>}
                  {s.yearSource === "ytmusic" && <span style={{ color: "#FF3B5C" }}>YT Music</span>}
                  {s.yearSource === "spotify" && <span style={{ color: "#8B5CF6" }}>Spotify</span>}
                  {s.yearSource === "itunes" && <span style={{ color: "#EC4899" }}>iTunes</span>}
                  {s.yearSource === "google" && <span style={{ color: "#0EA5E9" }}>Google</span>}
                  {s.yearSource === "ai" && <span style={{ color: "#7C3AED" }}>AI</span>}
                  {s.yearSource === null && <span style={{ color: "#B0AFBC" }}>not found</span>}
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
      <p style={{ color: "#FF3B5C", fontSize: 14, fontWeight: 700 }}>{info.message}</p>
      {info.detail && <p style={{ color: "#E85520", fontSize: 12 }}>{info.detail}</p>}
      {info.hint && (
        <p style={{ fontSize: 12, color: "#7B7B9A", marginTop: 2 }}>
          <span style={{ color: "#FF6B35", fontWeight: 700 }}>提示：</span> {info.hint}
        </p>
      )}
    </div>
  );
}

function errorInfo(code: string): { message: string; detail?: string; hint?: string } {
  if (code === "missing_url") return { message: "Paste a YouTube playlist URL" };
  if (code === "save_failed") return { message: "Could not save playlist", detail: "Check your connection and try again." };
  if (code === "saved_playlist_not_found") return { message: "Saved playlist not found", detail: "It may have been deleted or expired.", hint: "Try loading a YouTube playlist URL instead." };
  if (code === "unauthorized") return { message: "Host token mismatch — refresh and try again" };
  if (code === "quota_exceeded") return {
    message: "YouTube API quota exceeded",
    detail: "The daily quota for the YouTube Data API has been used up.",
    hint: "Try again after midnight Pacific Time when the quota resets.",
  };
  if (code === "not_enough_songs") return {
    message: "Not enough songs with known release years",
    detail: "Fewer than 2 songs had a resolvable year (from description, title, or Spotify).",
    hint: "Try a playlist with more mainstream tracks, or one from YouTube Music.",
  };
  if (code === "api_key_missing") return {
    message: "API key not configured",
    detail: "The server is missing YOUTUBE_API_KEY or Spotify credentials.",
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
  if (code === "spotify_error") return {
    message: "Spotify API error",
    detail: "Could not get a Spotify access token. Client ID or secret may be wrong.",
    hint: "Year lookup will fail for any songs without years in their title or description.",
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

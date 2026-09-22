"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import MusicPlayer from "@/components/MusicPlayer";
import LyricsPlayer, { lyricsAudioProps, isAudioPhase, needsLyricsAudio } from "@/components/LyricsPlayer";
import PlayerList from "@/components/PlayerList";
import Confetti from "@/components/Confetti";
import VictoryPlayer from "@/components/VictoryPlayer";
import { Stage } from "@/components/Stage";
import { getOrCreatePersistedId } from "@/lib/device-id";
import type { GameState, ServerMessage, PublicLyricsGameState } from "@/lib/game";

// TODO: set once a victory song is picked (a YouTube video id, e.g. "dQw4w9WgXcQ" from
// https://www.youtube.com/watch?v=dQw4w9WgXcQ). null plays no music, confetti/trophy still show.
const VICTORY_VIDEO_ID: string | null = null;

// Read-only spectator view for a TV/projector — see DESIGN.md. No controls, no hostId: this page
// never issues a game command, only the screenId credential GET_LYRICS_AUDIO needs.
export default function ScreenPage() {
  const params = useParams<{ code: string }>();
  const [state, setState] = useState<GameState | null>(null);
  const [lyricsState, setLyricsState] = useState<PublicLyricsGameState | null>(null);
  const [lyricsAudio, setLyricsAudio] = useState<{ videoId: string | null; roundIndex: number } | null>(null);
  const [lyricsTimerLeft, setLyricsTimerLeft] = useState<number | null>(null);
  const screenIdRef = useRef<string>("");

  useEffect(() => {
    screenIdRef.current = getOrCreatePersistedId("hitster_screen_id");
  }, []);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      if (msg.type === "STATE") setState(msg.state);
      if (msg.type === "LYRICS_STATE") {
        setLyricsState(msg.state);
        if (["loading", "preview", "ended"].includes(msg.state.phase)) setLyricsAudio(null);
        if (msg.state.phase === "lobby" || msg.state.phase === "ended") setLyricsTimerLeft(null);
      }
      if (msg.type === "LYRICS_ABORTED") { setLyricsState(null); setLyricsAudio(null); }
      if (msg.type === "LYRICS_AUDIO") setLyricsAudio({ videoId: msg.videoId, roundIndex: msg.roundIndex });
    },
    onOpen() {
      // Claim the screen credential immediately (mode-independent) so Timeline mode's video id
      // starts flowing without needing a Lyrics-only GET_LYRICS_AUDIO — see handleJoinScreen.
      socket.send(JSON.stringify({ type: "JOIN_SCREEN", screenId: getOrCreatePersistedId("hitster_screen_id") }));
    },
  });

  // Same retry-safe request pattern as the host page used before the split: fires whenever
  // this round has no reply yet, including after a reconnect.
  useEffect(() => {
    if (needsLyricsAudio(lyricsState, lyricsAudio)) {
      socket.send(JSON.stringify({ type: "GET_LYRICS_AUDIO", screenId: screenIdRef.current }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- socket is stable; re-run on new state or reply
  }, [lyricsState, lyricsAudio]);

  useEffect(() => {
    if (lyricsState?.phase !== "guessing" || lyricsState.roundStart === null) {
      setLyricsTimerLeft(null);
      return;
    }
    const deadline = lyricsState.roundStart + lyricsState.timerSeconds * 1000;
    const tick = () => setLyricsTimerLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [lyricsState?.phase, lyricsState?.roundStart, lyricsState?.timerSeconds]);

  const phase = state?.phase ?? "lobby";
  const label: React.CSSProperties = { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" };
  const scoreRow = (players: Record<string, { name: string; score: number }>) => (
    <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      {Object.entries(players).sort(([, a], [, b]) => b.score - a.score).map(([id, p]) => (
        <span key={id} style={{ fontSize: 13, color: "var(--text2)", fontWeight: 600 }}>{p.name}: <span style={{ color: "var(--orange)" }}>{p.score}</span></span>
      ))}
    </div>
  );

  return (
    <Stage>
      <div style={{ width: "100%", height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", fontFamily: "var(--font-zh)", overflow: "hidden" }}>
        {/* top bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px 0 32px" }}>
          <h1 className="title-outlined-sm" style={{ fontSize: 22 }}>HITSTER!</h1>
          <div style={{ background: "var(--surface2)", borderRadius: 10, padding: "6px 14px", fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--text2)" }}>
            房間 {params.code}
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px 32px 32px" }}>
          {/* ── waiting for the host to start ───────────────────────────────── */}
          {phase === "lobby" && !lyricsState && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
              <p style={{ fontSize: 22, fontWeight: 700, color: "var(--ink)" }}>等待主持人開始遊戲…</p>
              <p style={{ fontSize: 14, color: "var(--text3)" }}>Waiting for the host to start</p>
            </div>
          )}

          {/* ── Timeline mode ────────────────────────────────────────────────── */}
          {(phase === "guessing" || phase === "reveal") && state && (
            <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 380px", gap: 32, minHeight: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
                <p style={label}>
                  第 {state.currentRound} 回合 · {state.players[state.activePlayerId ?? ""]?.name ?? "?"} 的回合
                </p>
                <MusicPlayer currentSong={state.currentSong} phase={phase} />
              </div>
              <PlayerList
                players={state.players}
                placements={state.placements}
                targetCardCount={state.targetCardCount}
                activePlayerId={state.activePlayerId}
                phase={phase}
              />
            </div>
          )}
          {phase === "ended" && state && (
            <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, overflow: "hidden" }}>
              <Confetti />
              <VictoryPlayer videoId={VICTORY_VIDEO_ID} />
              <p className="animate-trophy" style={{ fontSize: 64, lineHeight: 1 }}>🏆</p>
              <p style={label}>遊戲結束 · Winner!</p>
              <h2 className="title-outlined" style={{ fontSize: 48 }}>{state.players[state.winner ?? ""]?.name ?? "?"}</h2>
              <div style={{ width: "100%", maxWidth: 520, position: "relative", zIndex: 1 }}>
                <PlayerList players={state.players} placements={{}} targetCardCount={state.targetCardCount} activePlayerId={null} />
              </div>
            </div>
          )}

          {/* ── Lyrics mode ──────────────────────────────────────────────────── */}
          {lyricsState?.phase === "loading" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
              <div className="animate-vinyl" style={{ width: 64, height: 64, borderRadius: "50%", background: "radial-gradient(circle at 35% 35%, #3a3a4a, var(--ink) 70%)" }} />
              <p style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>AI 正在準備歌詞…</p>
            </div>
          )}
          {lyricsState?.phase === "preview" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <p style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>歌曲已準備好 · Ready</p>
              <p style={{ fontSize: 14, color: "var(--text3)" }}>等待主持人確認開始</p>
            </div>
          )}
          {(lyricsState?.phase === "playing" || lyricsState?.phase === "guessing") && lyricsState.currentRound && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <p style={label}>第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合</p>
                {scoreRow(lyricsState.players)}
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 24 }}>
                <p style={{ textAlign: "center", color: "var(--text2)", fontSize: 20, lineHeight: 1.6, maxWidth: 780, whiteSpace: "pre-wrap" }}>
                  {lyricsState.currentRound.lyricContext}
                </p>
                {lyricsState.phase === "guessing" && (
                  <p style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 140, lineHeight: 1, color: (lyricsTimerLeft ?? 99) <= 5 ? "var(--red)" : "var(--orange)" }}>
                    {String(lyricsTimerLeft ?? lyricsState.timerSeconds).padStart(2, "0")}
                  </p>
                )}
              </div>
            </div>
          )}
          {lyricsState?.phase === "results" && lyricsState.currentRound && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
              <p style={label}>第 {lyricsState.currentRoundIndex + 1} / {lyricsState.totalRounds} 回合 · 結果</p>
              <div style={{ background: "var(--surface2)", borderRadius: 16, padding: "20px 24px", textAlign: "center" }}>
                <p style={{ fontSize: 13, color: "var(--text3)" }}>{lyricsState.currentRound.title} · {lyricsState.currentRound.artist}</p>
                <p style={{ fontSize: 26, fontWeight: 900, color: "var(--orange)", marginTop: 4 }}>{lyricsState.currentRound.blankSentence ?? "（已揭曉）"}</p>
              </div>
              <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.entries(lyricsState.players).sort(([, a], [, b]) => b.score - a.score).map(([id, p]) => {
                  const ans = lyricsState.answers[id];
                  return (
                    <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: ans?.correct ? "rgba(0,200,150,.08)" : "rgba(255,107,53,.04)", borderRadius: 12, padding: "10px 16px" }}>
                      <span style={{ fontWeight: 700, color: "var(--ink)", flex: 1 }}>{p.name}</span>
                      {ans ? <span style={{ fontWeight: 900, color: ans.correct ? "var(--mint)" : "var(--red)" }}>{ans.correct ? `+${ans.points}` : "✗"}</span> : <span style={{ color: "var(--text3)" }}>未作答</span>}
                      <span style={{ fontWeight: 900, color: "var(--orange)", minWidth: 40, textAlign: "right" }}>{p.score}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {lyricsState?.phase === "ended" && (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
              <p style={label}>歌詞模式結束 · Lyrics Mode Over!</p>
              <h2 className="title-outlined" style={{ fontSize: 48 }}>
                {Object.entries(lyricsState.players).sort(([, a], [, b]) => b.score - a.score)[0]?.[1]?.name ?? "?"}
              </h2>
              <div style={{ width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.entries(lyricsState.players).sort(([, a], [, b]) => b.score - a.score).map(([id, p], i) => (
                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: i === 0 ? "var(--ink)" : "white", border: "2px solid rgba(255,107,53,.15)", borderRadius: 14, padding: "10px 18px" }}>
                    <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--text3)", minWidth: 28 }}>#{i + 1}</span>
                    <span style={{ fontWeight: 700, color: i === 0 ? "var(--bg)" : "var(--ink)", flex: 1 }}>{p.name}</span>
                    <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--orange)", fontFamily: "var(--font-mono)" }}>{p.score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      {isAudioPhase(lyricsState) && <LyricsPlayer {...lyricsAudioProps(lyricsState, lyricsAudio)} />}
    </Stage>
  );
}

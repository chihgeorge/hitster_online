"use client";

// Guess Mode UI (docs/designs/guess-mode-song-artist.md): the song plays, players name the title
// and/or artist. One file for all three surfaces — phone (GuessPlay), TV (GuessScreen), host
// controls (GuessHostControls) — so each page only wires state in. Mirrors Lyrics mode's screens.

import { useEffect, useRef, useState } from "react";
import Vinyl from "@/components/Vinyl";
import { isAudioPhase } from "@/components/LyricsPlayer";
import { decodeEntities } from "@/lib/utils";
import type { GuessAnswer, PublicGuessGameState } from "@/lib/game";

type AudioReply = { videoId: string | null; roundIndex: number };

/**
 * Unlike Lyrics (audible, then cut for guessing), Guess plays the song WHILE players guess:
 * silent (cued) until the host starts the round, audible through guessing and the reveal.
 */
export function guessAudioProps(state: PublicGuessGameState | null, audio: AudioReply | null) {
  if (!state || !isAudioPhase(state) || !audio?.videoId || audio.roundIndex !== state.currentRoundIndex) {
    return { videoId: null, playing: false };
  }
  return { videoId: audio.videoId, playing: state.phase !== "playing" };
}

/** Seconds left in the guessing phase, null outside it. */
export function useCountdown(state: PublicGuessGameState | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const phase = state?.phase;
  const roundStart = state?.roundStart ?? null;
  const timerSeconds = state?.timerSeconds ?? 0;
  const active = phase === "guessing" && roundStart !== null;
  useEffect(() => {
    if (!active) return;
    const deadline = roundStart + timerSeconds * 1000;
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    const id = setInterval(tick, 200);
    queueMicrotask(tick);
    // Drop the old value on the way out, or the next round's first render shows last round's 0.
    return () => { clearInterval(id); setLeft(null); };
  }, [active, roundStart, timerSeconds]);
  return active ? left : null;
}

// Server text is HTML-escaped (sanitizeText); React escapes again, so decode for display.
const show = (s: string | null | undefined) => decodeEntities(s ?? "");

const ranked = (state: PublicGuessGameState) =>
  Object.entries(state.players).sort(([, a], [, b]) => b.score - a.score);

/** Sole or tied top scorer with at least one point — the only player whose score shows in gold. */
export const isLeader = (state: { players: Record<string, { score: number }> }, playerId: string) => {
  const me = state.players[playerId]?.score ?? 0;
  return me > 0 && Object.values(state.players).every((p) => p.score <= me);
};

const roundLabel = (state: PublicGuessGameState) => `第 ${state.currentRoundIndex + 1} / ${state.totalRounds} 回合`;

function Mark({ ok }: { ok: boolean }) {
  return <span style={{ fontWeight: 900, color: ok ? "var(--mint)" : "var(--red)" }}>{ok ? "✓" : "✗"}</span>;
}

// ── Phone ──────────────────────────────────────────────────────────────────────

interface PlayProps {
  state: PublicGuessGameState;
  playerId: string;
  playerName: string;
  tooLate: boolean;
  onSubmit: (title: string, artist: string) => void;
}

export function GuessPlay({ state, playerId, playerName, tooLate, onSubmit }: PlayProps) {
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [sent, setSent] = useState(false);
  const left = useCountdown(state);
  const me = state.players[playerId] ?? null;
  const myAnswer = state.answers[playerId] ?? null;
  const hasArtist = state.currentRound?.hasArtist ?? true;

  // New round, or a new game that restarts at round 0 (e.g. after a quit while this phone was offline).
  const roundKey = `${state.currentRoundIndex}:${state.phase === "playing"}`;
  useEffect(() => {
    setTitle(""); setArtist(""); setSent(false);
  }, [roundKey]);

  const main = (children: React.ReactNode, center = false) => (
    <main className={`flex min-h-screen flex-col items-center ${center ? "justify-center" : ""} gap-6 px-5 py-12`} style={{ background: "var(--bg)" }}>
      {children}
    </main>
  );
  const score = (
    <div style={{ background: "var(--ink)", borderRadius: 12, padding: "6px 14px", textAlign: "center" }}>
      {/* DESIGN.md: gold means "current leader", nothing else */}
      <p style={{ fontFamily: "var(--font-mono)", color: isLeader(state, playerId) ? "var(--gold)" : "var(--orange)", fontWeight: 700, fontSize: 20, lineHeight: 1 }}>{me?.score ?? 0}</p>
      <p style={{ fontSize: 9, color: "var(--text2)", textTransform: "uppercase", letterSpacing: ".08em" }}>pts</p>
    </div>
  );

  if (state.phase === "playing") {
    return main(<>
      <Vinyl size={70} />
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 4 }}>{roundLabel(state)}</p>
        <p style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>準備猜歌！等待主持人播放…</p>
        <p style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Get ready — waiting for the host to play the song</p>
      </div>
      <div style={{ fontSize: 18, fontWeight: 900, color: "var(--orange)", fontFamily: "var(--font-mono)" }}>{me?.score ?? 0} pts</div>
    </>, true);
  }

  if (state.phase === "guessing") {
    // A reconnecting player still sees "submitted": the redacted answer key survives on the wire.
    const submitted = (sent && !tooLate) || !!myAnswer; // TOO_LATE means the server dropped it
    const timeUp = left === 0 || tooLate;
    const canSend = !submitted && !timeUp && (title.trim() !== "" || (hasArtist && artist.trim() !== ""));
    const submit = () => {
      if (!canSend) return;
      setSent(true);
      onSubmit(title.trim(), hasArtist ? artist.trim() : "");
    };
    const input: React.CSSProperties = { background: "white", border: "2px solid rgba(255,107,53,.3)", borderRadius: 14, padding: "14px 16px", fontSize: 18, color: "var(--ink)", fontFamily: "var(--font-zh)", width: "100%", boxSizing: "border-box" };
    return main(<>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", maxWidth: 400 }}>
        <p style={{ fontWeight: 700, color: "var(--ink)", fontSize: 15 }}>{playerName}</p>
        {score}
      </div>
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 56, fontWeight: 900, color: (left ?? 99) <= 5 ? "var(--red)" : "var(--orange)", fontFamily: "var(--font-mono)", lineHeight: 1 }}>{left ?? state.timerSeconds}</p>
        <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".08em" }}>秒</p>
      </div>
      <p style={{ fontSize: 18, fontWeight: 900, color: "var(--ink)" }}>🎧 這是什麼歌？ · Name that song!</p>
      {submitted ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 16, fontWeight: 900, color: "var(--mint)" }}>✓ 已送出 · Submitted!</p>
          <p style={{ fontSize: 12, color: "var(--text3)" }}>等待揭曉…</p>
        </div>
      ) : timeUp ? (
        <div style={{ textAlign: "center" }}>
          <p style={{ fontSize: 16, fontWeight: 900, color: "var(--red)" }}>⏰ 時間到 · Time&apos;s up!</p>
          <p style={{ fontSize: 12, color: "var(--text3)" }}>等待揭曉…</p>
        </div>
      ) : (
        <div style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 10 }}>
          <input data-testid="guess-title-input" type="text" lang="zh-TW" autoFocus placeholder="歌名 · Song title"
            value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }} style={input} />
          {hasArtist && (
            <input data-testid="guess-artist-input" type="text" lang="zh-TW" placeholder="歌手 · Artist"
              value={artist} onChange={(e) => setArtist(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }} style={input} />
          )}
          <button data-testid="guess-submit-btn" onClick={submit} disabled={!canSend}
            style={{ background: canSend ? "var(--orange)" : "rgba(255,107,53,.35)", color: "white", border: "none", borderRadius: 14, padding: "14px", fontSize: 16, fontWeight: 900, cursor: canSend ? "pointer" : "not-allowed", fontFamily: "var(--font-zh)" }}>
            送出 · Submit
          </button>
          <p style={{ fontSize: 11, color: "var(--text3)", textAlign: "center" }}>
            {hasArtist ? "猜中一個就有分，兩個都對再加分 · One right scores, both right earns a bonus" : "本回合只猜歌名 · Title only this round"}
          </p>
        </div>
      )}
    </>);
  }

  if (state.phase === "results" && state.currentRound) {
    const r = state.currentRound;
    return main(<>
      <Vinyl size={70} />
      <p style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{roundLabel(state)} · 結果</p>
      <div style={{ background: "white", borderRadius: 16, padding: "18px 20px", width: "100%", maxWidth: 400, textAlign: "center", border: "2px solid rgba(255,107,53,.15)" }}>
        <p style={{ fontSize: 11, color: "var(--text3)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".08em" }}>正確答案</p>
        <p data-testid="guess-answer-title" style={{ fontSize: 20, fontWeight: 900, color: "var(--orange)", fontFamily: "var(--font-zh)" }}>{show(r.title)}</p>
        {r.hasArtist && <p style={{ fontSize: 15, fontWeight: 700, color: "var(--text2)", marginTop: 2 }}>{show(r.artist)}</p>}
      </div>
      {myAnswer ? <MyResult answer={myAnswer} hasArtist={r.hasArtist} /> : (
        <div style={{ background: "rgba(176,175,188,.06)", border: "2px solid rgba(176,175,188,.2)", borderRadius: 16, padding: "18px 20px", width: "100%", maxWidth: 400, textAlign: "center" }}>
          <p style={{ fontSize: 14, color: "var(--text3)" }}>未作答</p>
        </div>
      )}
      <div style={{ textAlign: "center" }}>
        <p style={{ fontSize: 28, fontWeight: 900, color: "var(--orange)", fontFamily: "var(--font-mono)" }}>{me?.score ?? 0} pts</p>
        <p style={{ fontSize: 11, color: "var(--text3)" }}>等待主持人繼續…</p>
      </div>
    </>);
  }

  if (state.phase === "ended") {
    const sorted = ranked(state);
    const myRank = sorted.findIndex(([id]) => id === playerId);
    return main(<>
      <Vinyl size={90} />
      <div style={{ textAlign: "center" }}>
        {myRank === 0 ? (
          <>
            <h1 className="title-outlined" style={{ fontSize: 48, lineHeight: 1.05 }}>WINNER!</h1>
            <p style={{ color: "var(--text2)", fontSize: 15, marginTop: 6 }}>你贏了猜歌模式！ 🎧🎉</p>
          </>
        ) : (
          <>
            <p style={{ color: "var(--text3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>猜歌模式結束</p>
            <h1 style={{ fontSize: 26, fontWeight: 900, color: "var(--ink)" }}>#{myRank + 1} — {me?.score ?? 0} pts</h1>
          </>
        )}
      </div>
      <Standings state={state} highlight={playerId} />
    </>, true);
  }

  return null;
}

function MyResult({ answer, hasArtist }: { answer: GuessAnswer; hasArtist: boolean }) {
  const any = answer.points > 0;
  const row = (label: string, text: string, ok: boolean, pts: number) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
      <span style={{ fontSize: 12, color: "var(--text3)", minWidth: 40, textAlign: "left" }}>{label}</span>
      <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: "var(--ink)", textAlign: "left", fontFamily: "var(--font-zh)" }}>{text ? show(text) : "—"}</span>
      <Mark ok={ok} />
      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: ok ? "var(--mint)" : "var(--text3)", minWidth: 44, textAlign: "right" }}>+{pts}</span>
    </div>
  );
  return (
    <div data-testid="guess-my-result" style={{ background: any ? "rgba(0,200,150,.06)" : "rgba(255,59,92,.06)", border: `2px solid ${any ? "rgba(0,200,150,.3)" : "rgba(255,59,92,.25)"}`, borderRadius: 16, padding: "16px 18px", width: "100%", maxWidth: 400, display: "flex", flexDirection: "column", gap: 8 }}>
      <p style={{ fontSize: 12, color: "var(--text3)" }}>你的答案 · Your answer</p>
      {row("歌名", answer.title, answer.titleCorrect, answer.titlePoints)}
      {hasArtist && row("歌手", answer.artist, answer.artistCorrect, answer.artistPoints)}
      {answer.bonusPoints > 0 && (
        <p style={{ fontSize: 13, fontWeight: 900, color: "var(--mint)", textAlign: "right" }}>全對加分 · Bonus +{answer.bonusPoints}</p>
      )}
      <p style={{ fontSize: 24, fontWeight: 900, color: any ? "var(--mint)" : "var(--red)", textAlign: "center" }}>
        {any ? `+${answer.points} pts 🎉` : "✗ 沒猜中"}
      </p>
    </div>
  );
}

function Standings({ state, highlight }: { state: PublicGuessGameState; highlight?: string }) {
  return (
    <div style={{ background: "white", borderRadius: 20, padding: 20, width: "100%", maxWidth: 340 }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", marginBottom: 12 }}>最終排名 · Final Scores</p>
      <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ranked(state).map(([id, p], idx) => (
          <li key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: id === highlight ? "var(--surface2)" : "#F8F8FC", borderRadius: 14, padding: "11px 14px", border: id === highlight ? "2px solid rgba(255,107,53,.3)" : "2px solid transparent" }}>
            <span style={{ width: 24, height: 24, borderRadius: "50%", background: idx === 0 ? "var(--gold)" : idx === 1 ? "#C0C0C0" : idx === 2 ? "#CD7F32" : "#E8E8F0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 900, color: "var(--ink)", flexShrink: 0 }}>{idx + 1}</span>
            <span style={{ fontWeight: 700, color: "var(--ink)", fontSize: 14, flex: 1 }}>{p.name}</span>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--orange)", fontWeight: 700, fontSize: 16 }}>{p.score}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── TV (read-only, inside the 960×540 Stage) ─────────────────────────────────────

export function GuessScreen({ state }: { state: PublicGuessGameState }) {
  const left = useCountdown(state);
  const label: React.CSSProperties = { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" };
  const answered = Object.keys(state.answers).length;
  const total = Object.keys(state.players).length;

  if (state.phase === "playing" || state.phase === "guessing") {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <p style={label}>{roundLabel(state)}</p>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {ranked(state).map(([id, p]) => (
              <span key={id} style={{ fontSize: 13, color: "var(--text2)", fontWeight: 600 }}>{p.name}: <span style={{ color: "var(--orange)", fontFamily: "var(--font-mono)" }}>{p.score}</span></span>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18 }}>
          <div className="animate-vinyl" style={{ width: 72, height: 72, borderRadius: "50%", background: "radial-gradient(circle at 35% 35%, #3a3a4a, var(--ink) 70%)" }} />
          <p style={{ fontSize: 30, fontWeight: 900, color: "var(--ink)" }}>🎧 這是什麼歌？</p>
          {state.phase === "guessing" ? (
            <>
              <p style={{ fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 120, lineHeight: 1, color: (left ?? 99) <= 5 ? "var(--red)" : "var(--orange)" }}>
                {String(left ?? state.timerSeconds).padStart(2, "0")}
              </p>
              <p style={{ fontSize: 16, color: "var(--text2)" }}>已作答 <span style={{ fontFamily: "var(--font-mono)", color: "var(--orange)", fontWeight: 700 }}>{answered} / {total}</span></p>
            </>
          ) : (
            <p style={{ fontSize: 16, color: "var(--text3)" }}>準備好了嗎？等待主持人播放 · Get ready…</p>
          )}
        </div>
      </div>
    );
  }

  if (state.phase === "results" && state.currentRound) {
    const r = state.currentRound;
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16, minHeight: 0 }}>
        <p style={label}>{roundLabel(state)} · 結果</p>
        <div style={{ background: "var(--surface2)", borderRadius: 16, padding: "18px 24px", textAlign: "center" }}>
          <p style={{ fontSize: 30, fontWeight: 900, color: "var(--orange)" }}>{show(r.title)}</p>
          {r.hasArtist && <p style={{ fontSize: 18, fontWeight: 700, color: "var(--text2)", marginTop: 2 }}>{show(r.artist)}</p>}
        </div>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
          {ranked(state).map(([id, p]) => {
            const a = state.answers[id];
            return (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 14, background: a && a.points > 0 ? "rgba(0,200,150,.08)" : "rgba(255,107,53,.04)", borderRadius: 12, padding: "10px 16px" }}>
                <span style={{ fontWeight: 700, color: "var(--ink)", flex: 1 }}>{p.name}</span>
                {a ? (
                  <>
                    <span style={{ fontSize: 13, color: "var(--text2)" }}>歌名 <Mark ok={a.titleCorrect} /></span>
                    {r.hasArtist && <span style={{ fontSize: 13, color: "var(--text2)" }}>歌手 <Mark ok={a.artistCorrect} /></span>}
                    <span style={{ fontWeight: 900, color: a.points > 0 ? "var(--mint)" : "var(--text3)", fontFamily: "var(--font-mono)", minWidth: 56, textAlign: "right" }}>+{a.points}</span>
                  </>
                ) : <span style={{ color: "var(--text3)" }}>未作答</span>}
                <span style={{ fontWeight: 900, color: "var(--orange)", fontFamily: "var(--font-mono)", minWidth: 48, textAlign: "right" }}>{p.score}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (state.phase === "ended") {
    const sorted = ranked(state);
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
        <p style={label}>猜歌模式結束 · Guess Mode Over!</p>
        <h2 className="title-outlined" style={{ fontSize: 48 }}>{sorted[0]?.[1]?.name ?? "?"}</h2>
        <div style={{ width: "100%", maxWidth: 520, display: "flex", flexDirection: "column", gap: 8 }}>
          {sorted.map(([id, p], i) => (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: i === 0 ? "var(--ink)" : "white", border: "2px solid rgba(255,107,53,.15)", borderRadius: 14, padding: "10px 18px" }}>
              <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--text3)", minWidth: 28 }}>#{i + 1}</span>
              <span style={{ fontWeight: 700, color: i === 0 ? "var(--bg)" : "var(--ink)", flex: 1 }}>{p.name}</span>
              <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--orange)", fontFamily: "var(--font-mono)" }}>{p.score}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

// ── Host controls ──────────────────────────────────────────────────────────────

/** Mid-game quit for Lyrics and Guess (server allows RESET_*_GAME in any phase). Confirms first. */
export function QuitGameButton({ onQuit }: { onQuit: () => void }) {
  return (
    <button type="button" data-testid="quit-game-btn"
      onClick={() => { if (window.confirm("結束這場遊戲？所有分數都會清除。 · End this game? Scores will be cleared.")) onQuit(); }}
      style={{ background: "none", border: "none", color: "var(--text3)", fontSize: 12, textDecoration: "underline", cursor: "pointer", alignSelf: "center", fontFamily: "var(--font-zh)", minHeight: 44, padding: "0 16px" }}>
      結束遊戲 · Quit game
    </button>
  );
}

interface HostProps {
  state: PublicGuessGameState;
  panel: React.CSSProperties;
  onStartRound: () => void;
  onShowResults: () => void;
  onNext: () => void;
  onReset: () => void;
}

export function GuessHostControls({ state, panel, onStartRound, onShowResults, onNext, onReset }: HostProps) {
  // Play / Show Results / Next all render as the same button in the same spot, so a double-tap
  // could skip the reveal. Ignore taps while one is in flight for this phase, and for a moment
  // after the phase changes (the second tap of a double-tap lands on the NEW button).
  const stateKey = `${state.phase}:${state.currentRoundIndex}`;
  const [tappedKey, setTappedKey] = useState<string | null>(null);
  const shownAt = useRef(0);
  useEffect(() => { shownAt.current = Date.now(); }, [stateKey]);
  const busy = tappedKey === stateKey;
  const once = (fn: () => void) => () => {
    if (busy || Date.now() - shownAt.current < 400) return;
    setTappedKey(stateKey);
    fn();
  };
  const label: React.CSSProperties = { fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" };
  const primary: React.CSSProperties = { background: "var(--orange)", color: "white", border: "none", borderRadius: 14, padding: "15px", fontSize: 16, fontWeight: 900, cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.3)" };

  if (state.phase === "ended") {
    return (
      <div style={{ ...panel, display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "36px 24px" }}>
        <p style={{ ...label, letterSpacing: ".12em" }}>猜歌模式結束 · Guess Mode Over!</p>
        <h2 className="title-outlined" style={{ fontSize: 32, lineHeight: 1.05 }}>{ranked(state)[0]?.[1]?.name ?? "?"}</h2>
        <button data-testid="guess-play-again-btn" onClick={onReset} style={{ ...primary, padding: "14px 32px", fontSize: 15 }}>再玩一次 · Play Again</button>
      </div>
    );
  }
  const r = state.currentRound;
  return (
    <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 14 }}>
      {state.phase === "playing" && (<>
        <p style={label}>{roundLabel(state)} · 猜歌模式</p>
        <button data-testid="guess-start-round-btn" onClick={once(onStartRound)} disabled={busy} style={primary}>▶ 播放！Play</button>
      </>)}
      {state.phase === "guessing" && (<>
        <p style={label}>{roundLabel(state)} · 猜歌中 — 已作答 {Object.keys(state.answers).length} / {Object.keys(state.players).length}</p>
        <button data-testid="guess-show-results-btn" onClick={once(onShowResults)} disabled={busy} style={{ ...primary, background: "var(--ink)", boxShadow: "none", fontSize: 15 }}>🔍 揭曉答案 · Show Results</button>
      </>)}
      {state.phase === "results" && r && (<>
        <p style={label}>{roundLabel(state)} · 答案：{show(r.title)}{r.hasArtist ? ` — ${show(r.artist)}` : ""}</p>
        <button data-testid="guess-next-btn" onClick={once(onNext)} disabled={busy} style={{ ...primary, fontSize: 15 }}>
          {state.currentRoundIndex + 1 >= state.totalRounds ? "🏆 查看排名 · See Rankings" : "▶ 下一回合 · Next Round"}
        </button>
      </>)}
      <QuitGameButton onQuit={onReset} />
    </div>
  );
}

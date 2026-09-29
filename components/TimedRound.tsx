"use client";

// UI shared by the two simultaneous-timed-round modes (Lyrics, Guess): the countdown, the gold
// leader rule, the phone's final standings, and the TV's score row and end screen. Typed
// structurally so either mode's public state fits.

import { useEffect, useState } from "react";
import { rankPlayers, wonOnTime } from "@/lib/game";
import { serverNow } from "@/lib/server-clock";

type Players = Record<string, { name: string; score: number; timeMs?: number }>;

/**
 * TV player lists: one column for up to 4 players, two above that. The 960×540 Stage can't
 * scroll, and 8 full-width rows (the room's cap) don't fit under a heading or answer card.
 */
export function tvListStyle(count: number, gap = 8): React.CSSProperties {
  return count > 4
    ? { display: "grid", gridTemplateColumns: "1fr 1fr", gridAutoRows: "min-content", gap, alignContent: "start" }
    : { display: "flex", flexDirection: "column", gap };
}

/** Seconds left in the guessing phase, null outside it. Counts against the server's clock. */
export function useCountdown(state: { phase: string; roundStart: number | null; timerSeconds: number } | null): number | null {
  const [left, setLeft] = useState<number | null>(null);
  const phase = state?.phase;
  const roundStart = state?.roundStart ?? null;
  const timerSeconds = state?.timerSeconds ?? 0;
  const active = phase === "guessing" && roundStart !== null;
  useEffect(() => {
    if (!active) return;
    const deadline = roundStart + timerSeconds * 1000;
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - serverNow()) / 1000)));
    const id = setInterval(tick, 200);
    queueMicrotask(tick);
    // Drop the old value on the way out, or the next round's first render shows last round's 0.
    return () => { clearInterval(id); setLeft(null); };
  }, [active, roundStart, timerSeconds]);
  return active ? left : null;
}

/** The current leader by rankPlayers (ties go to the faster answers), with at least one point —
 * the only player whose score shows in gold (DESIGN.md: gold = current leader only). */
export const isLeader = (state: { players: Record<string, { score: number; timeMs?: number }> }, playerId: string) => {
  const [top] = rankPlayers(state.players);
  return !!top && top[0] === playerId && top[1].score > 0;
};

const TIE_NOTE = "同分，答得較快的人獲勝 · Tied on points — faster answers won";

/** Phone: small note under the result heading when time decided the winner. */
export function WonOnTimeNote({ players }: { players: Players }) {
  if (!wonOnTime(players)) return null;
  return <p data-testid="won-on-time" style={{ fontSize: 12, color: "var(--text3)", marginTop: 8 }}>{TIE_NOTE}</p>;
}

/** Phone: final ranking, with this player's row highlighted. */
export function Standings({ players, highlight }: { players: Players; highlight?: string }) {
  return (
    <div style={{ background: "white", borderRadius: 20, padding: 20, width: "100%", maxWidth: 340 }}>
      <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", marginBottom: 12 }}>最終排名 · Final Scores</p>
      <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {rankPlayers(players).map(([id, p], idx) => (
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

/** TV: one-line live scores, best first. */
export function TvScoreRow({ players }: { players: Players }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
      {rankPlayers(players).map(([id, p]) => (
        <span key={id} style={{ fontSize: 13, color: "var(--text2)", fontWeight: 600 }}>{p.name}: <span style={{ color: "var(--orange)", fontFamily: "var(--font-mono)" }}>{p.score}</span></span>
      ))}
    </div>
  );
}

/** TV: end-of-game screen — mode label, winner, tie note, ranked list. */
export function TvFinal({ players, title }: { players: Players; title: string }) {
  const sorted = rankPlayers(players);
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <p style={{ fontSize: 11, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em" }}>{title}</p>
      <h2 className="title-outlined" style={{ fontSize: 48 }}>{sorted[0]?.[1]?.name ?? "?"}</h2>
      {wonOnTime(players) && <p data-testid="won-on-time" style={{ fontSize: 14, color: "var(--text2)", fontWeight: 700 }}>{TIE_NOTE}</p>}
      <div data-testid="tv-final-list" style={{ width: "100%", maxWidth: sorted.length > 4 ? 860 : 520, ...tvListStyle(sorted.length) }}>
        {sorted.map(([id, p], i) => (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 12, background: i === 0 ? "var(--ink)" : "white", border: "2px solid rgba(255,107,53,.15)", borderRadius: 14, padding: "10px 18px" }}>
            <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--text3)", minWidth: 28 }}>#{i + 1}</span>
            <span style={{ fontWeight: 700, color: i === 0 ? "var(--bg)" : "var(--ink)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            <span style={{ fontWeight: 900, color: i === 0 ? "var(--gold)" : "var(--orange)", fontFamily: "var(--font-mono)" }}>{p.score}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shown for a few seconds after a round was skipped because its song couldn't play. */
export function SkipNotice() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(t);
  }, []);
  if (!visible) return null;
  return (
    <div role="status" data-testid="round-skipped" style={{ position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 50, maxWidth: "92vw", textAlign: "center", background: "var(--surface2)", border: "2px solid rgba(255,59,92,.4)", borderRadius: 14, padding: "10px 18px", fontSize: 15, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-zh)", }}>
      ⏭️ 這首歌無法播放，已換下一首 · That song couldn&apos;t play — skipped to the next one
    </div>
  );
}

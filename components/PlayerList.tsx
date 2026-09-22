"use client";

import type { Card, GamePhase, Player } from "@/lib/game";

interface Props {
  players: Record<string, Player>;
  placements: Record<string, number>;
  targetCardCount: number;
  activePlayerId?: string | null;
  phase?: GamePhase;
}

export default function PlayerList({ players, placements, targetCardCount, activePlayerId, phase }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(players).map(([playerId, player]) => {
        const hasPlaced = playerId in placements;
        const isActive = playerId === activePlayerId;
        return (
          <div
            key={playerId}
            style={{
              borderRadius: 14, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8,
              background: isActive ? "rgba(255,107,53,.1)" : "var(--surface2)",
              border: isActive ? "1.5px solid rgba(255,107,53,.35)" : "1.5px solid transparent",
            }}
          >
            {/* Name row */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <p style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" }}>{player.name}</p>
                {isActive && phase === "guessing" && (
                  <span style={{ fontSize: 10, color: "var(--orange)", fontWeight: 900, textTransform: "uppercase", letterSpacing: ".1em", flexShrink: 0 }}>
                    guessing
                  </span>
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, fontSize: 14 }}>
                <span style={{ fontWeight: 900, color: "var(--orange)", fontFamily: "var(--font-mono)" }}>{player.cardCount}</span>
                <span style={{ color: "#4A4A5A" }}>/{targetCardCount}</span>
                <span style={{ color: hasPlaced ? "var(--mint)" : "#4A4A5A" }}>{hasPlaced ? "✓" : "…"}</span>
              </div>
            </div>

            {/* Horizontal timeline tiles */}
            {player.timeline.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {player.timeline.map((card, i) => (
                  <MiniTile key={card.id ?? i} card={card} />
                ))}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 4 }}>
                {Array.from({ length: Math.min(targetCardCount, 12) }).map((_, i) => (
                  <div key={i} style={{ height: 6, width: 20, borderRadius: 4, background: "rgba(255,107,53,.15)", flexShrink: 0 }} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MiniTile({ card }: { card: Card }) {
  return (
    <div
      style={{
        flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center",
        borderRadius: 10, border: "1.5px solid rgba(255,107,53,.2)", padding: "6px 6px",
        width: 60, gap: 2, background: "rgba(255,107,53,.06)",
      }}
      title={`${card.title} – ${card.artist}`}
    >
      <p style={{ fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--orange)", fontSize: 14, lineHeight: 1 }}>{card.year}</p>
      <p style={{ fontSize: 9, color: "var(--text2)", lineHeight: 1.2, width: "100%", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.artist}</p>
      <p style={{ fontSize: 9, color: "#4A4A5A", lineHeight: 1.2, width: "100%", textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{card.title}</p>
    </div>
  );
}

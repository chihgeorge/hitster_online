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
            className={`rounded-xl px-4 py-3 flex flex-col gap-2 ${
              isActive ? "bg-yellow-400/10 border border-yellow-400/30" : "bg-white/5"
            }`}
          >
            {/* Name row */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <p className="font-medium truncate">{player.name}</p>
                {isActive && phase === "guessing" && (
                  <span className="text-xs text-yellow-400 font-semibold uppercase tracking-wide shrink-0">
                    guessing
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0 text-sm">
                <span className="font-bold text-yellow-400">{player.cardCount}</span>
                <span className="text-gray-500">/{targetCardCount}</span>
                <span>{hasPlaced ? "✓" : "…"}</span>
              </div>
            </div>

            {/* Horizontal timeline tiles */}
            {player.timeline.length > 0 ? (
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {player.timeline.map((card, i) => (
                  <MiniTile key={card.id ?? i} card={card} />
                ))}
              </div>
            ) : (
              <div className="flex gap-1">
                {Array.from({ length: Math.min(targetCardCount, 12) }).map((_, i) => (
                  <div key={i} className="h-1.5 w-5 rounded-sm bg-white/10 shrink-0" />
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
      className="shrink-0 flex flex-col items-center rounded-lg border border-white/15 px-2 py-2 w-[60px] gap-0.5"
      style={{ background: "rgba(255,255,255,0.07)" }}
      title={`${card.title} – ${card.artist}`}
    >
      <p className="font-mono font-bold text-yellow-400 text-base leading-none">{card.year}</p>
      <p className="text-[9px] text-white/60 leading-tight w-full text-center truncate">{card.artist}</p>
      <p className="text-[9px] text-gray-500 leading-tight w-full text-center truncate">{card.title}</p>
    </div>
  );
}

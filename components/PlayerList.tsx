"use client";

import type { Player } from "@/lib/game";

interface Props {
  players: Record<string, Player>;
  placements: Record<string, number>;
  targetCardCount: number;
  activePlayerId?: string | null;
}

export default function PlayerList({ players, placements, targetCardCount, activePlayerId }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {Object.entries(players).map(([playerId, player]) => {
        const hasPlaced = playerId in placements;
        const isActive = playerId === activePlayerId;
        return (
          <div
            key={playerId}
            className={`flex items-center gap-3 rounded-xl px-4 py-3 ${
              isActive ? "bg-yellow-400/10 border border-yellow-400/30" : "bg-white/5"
            }`}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-medium truncate">{player.name}</p>
                {isActive && (
                  <span className="text-xs text-yellow-400 font-semibold uppercase tracking-wide">
                    guessing
                  </span>
                )}
              </div>
              <div className="mt-1 flex gap-1">
                {Array.from({ length: targetCardCount }).map((_, i) => (
                  <div
                    key={i}
                    className={`h-2 w-4 rounded-sm ${
                      i < player.cardCount ? "bg-yellow-400" : "bg-white/10"
                    }`}
                  />
                ))}
              </div>
            </div>
            <div className="text-right shrink-0">
              <span className="text-lg font-bold text-yellow-400">{player.cardCount}</span>
              <span className="text-xs text-gray-500">/{targetCardCount}</span>
            </div>
            <div className="text-lg">
              {hasPlaced ? "✓" : "…"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

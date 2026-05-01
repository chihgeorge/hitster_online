"use client";

import type { Card, GamePhase } from "@/lib/game";

interface Props {
  timeline: Card[];
  currentSong: Card | null;
  phase: GamePhase;
  selectedPosition: number | null;
  onSelectPosition: (position: number) => void;
  onPlace: () => void;
  hasPlaced: boolean;
  tooLate: boolean;
}

export default function Timeline({
  timeline,
  currentSong,
  phase,
  selectedPosition,
  onSelectPosition,
  onPlace,
  hasPlaced,
  tooLate,
}: Props) {
  const canPlace = phase === "guessing" && !hasPlaced && !tooLate;

  return (
    <div className="flex flex-col gap-1 pb-24">
      {/* Drop zone: before the first card */}
      {canPlace && (
        <DropZone
          position={0}
          selected={selectedPosition === 0}
          onSelect={() => onSelectPosition(0)}
        />
      )}

      {timeline.map((card, idx) => (
        <div key={card.id}>
          <TimelineCard card={card} />
          {/* Drop zone after this card */}
          {canPlace && (
            <DropZone
              position={idx + 1}
              selected={selectedPosition === idx + 1}
              onSelect={() => onSelectPosition(idx + 1)}
            />
          )}
        </div>
      ))}

      {timeline.length === 0 && canPlace && (
        <p className="text-xs text-gray-500 text-center py-2">Your timeline is empty — place this card anywhere</p>
      )}

      {/* Current song card at bottom */}
      {currentSong && phase === "guessing" && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#1a1a2e]/95 backdrop-blur border-t border-white/10">
          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1 rounded-xl bg-yellow-400/10 border border-yellow-400/30 px-4 py-3">
              <p className="text-xs text-yellow-400 uppercase tracking-widest">Now playing</p>
              <p className="font-semibold text-yellow-300">🎵 Listening…</p>
            </div>
          </div>
          {hasPlaced ? (
            <p className="text-center text-green-400 font-medium">Placed ✓ — waiting for reveal</p>
          ) : tooLate ? (
            <p className="text-center text-red-400 font-medium">Too late!</p>
          ) : selectedPosition !== null ? (
            <button
              onClick={onPlace}
              className="w-full rounded-xl bg-yellow-400 py-3 font-bold text-black hover:bg-yellow-300 transition-colors"
            >
              Place here →
            </button>
          ) : (
            <p className="text-center text-gray-400 text-sm">Tap a position on your timeline</p>
          )}
        </div>
      )}

      {/* Reveal result */}
      {currentSong && phase === "reveal" && (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-[#1a1a2e]/95 backdrop-blur border-t border-white/10">
          <div className="rounded-xl bg-white/5 px-4 py-3 text-center">
            <p className="text-sm text-gray-400">The answer was</p>
            <p className="font-bold text-lg text-yellow-400">{currentSong.year}</p>
            <p className="text-sm text-gray-300">{currentSong.title}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineCard({ card }: { card: Card }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3 mx-1">
      <div className="font-mono text-yellow-400 font-bold text-lg w-12 shrink-0 text-center">
        {card.year}
      </div>
      <div className="min-w-0">
        <p className="font-medium truncate text-sm">{card.title}</p>
        <p className="text-xs text-gray-500 truncate">{card.artist}</p>
      </div>
    </div>
  );
}

function DropZone({
  position,
  selected,
  onSelect,
}: {
  position: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full py-2 px-4 rounded-xl border-2 border-dashed text-sm font-medium transition-all ${
        selected
          ? "border-yellow-400 bg-yellow-400/10 text-yellow-400"
          : "border-white/15 text-gray-600 hover:border-white/30 hover:text-gray-400"
      }`}
    >
      {selected ? "▶ Place here" : "+ Place here"}
    </button>
  );
}

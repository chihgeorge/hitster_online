"use client";

import { useEffect, useRef, useState } from "react";
import type { Card, GamePhase } from "@/lib/game";

interface Props {
  currentSong: Card | null;
  phase: GamePhase;
  onReveal: () => void;
  onNextRound: () => void;
}

export default function MusicPlayer({ currentSong, phase, onReveal, onNextRound }: Props) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerReady, setPlayerReady] = useState(false);

  useEffect(() => {
    if (!currentSong || typeof window === "undefined") return;

    // Load YouTube IFrame API once
    if (!window.YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }

    let player: YT.Player | null = null;

    function initPlayer() {
      if (!playerRef.current || !currentSong) return;
      player = new window.YT.Player(playerRef.current, {
        videoId: currentSong.videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          modestbranding: 1,
          playsinline: 1, // required for iOS Safari to stay in-page
          rel: 0,
        },
        events: {
          onReady: () => setPlayerReady(true),
        },
      });
    }

    if (window.YT?.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }

    return () => {
      player?.destroy();
      setPlayerReady(false);
    };
  }, [currentSong?.videoId]);

  if (!currentSong) {
    return (
      <div className="flex items-center justify-center h-64 rounded-2xl bg-white/5">
        <p className="text-gray-500">No song loaded</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-2xl overflow-hidden bg-black">
      {/* YouTube IFrame target */}
      <div ref={playerRef} className="w-full aspect-video" />

      {/* Overlay — covers video during guessing phase, reveals on reveal phase */}
      {phase === "guessing" && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center bg-[#1a1a2e]/95 backdrop-blur-sm"
          style={{ willChange: "opacity" }}
        >
          {/* CSS waveform — static keyframe animation, no JS RAF */}
          <div className="flex items-end gap-1 h-16 mb-6" aria-label="Audio playing">
            {[0.4, 0.7, 1, 0.6, 0.9, 0.5, 0.8, 0.3, 0.75, 0.55].map((h, i) => (
              <div
                key={i}
                className="w-2 rounded-full bg-yellow-400 animate-[waveform_1.2s_ease-in-out_infinite_alternate]"
                style={{
                  height: `${h * 100}%`,
                  animationDelay: `${i * 0.12}s`,
                  willChange: "height",
                }}
              />
            ))}
          </div>
          <p className="text-gray-300 text-sm">Listening…</p>
        </div>
      )}

      {/* Reveal phase: show song info */}
      {phase === "reveal" && (
        <div className="mt-3 px-2">
          <p className="text-xl font-bold">{currentSong.title}</p>
          <p className="text-yellow-400 font-mono text-lg">{currentSong.year}</p>
        </div>
      )}

      {/* Host controls */}
      <div className="mt-4 flex gap-3">
        {phase === "guessing" && (
          <button
            onClick={onReveal}
            className="flex-1 rounded-xl bg-yellow-400 py-3 font-bold text-black hover:bg-yellow-300 transition-colors"
          >
            Reveal →
          </button>
        )}
        {phase === "reveal" && (
          <button
            onClick={onNextRound}
            className="flex-1 rounded-xl bg-white/10 py-3 font-semibold text-white hover:bg-white/20 transition-colors"
          >
            Next round
          </button>
        )}
      </div>
    </div>
  );
}

// Extend window type for YouTube IFrame API
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

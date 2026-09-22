"use client";

import { useEffect, useRef, useState } from "react";
import type { Card, GamePhase } from "@/lib/game";
import { whenYouTubeApiReady } from "@/lib/youtube-iframe-api";

interface Props {
  currentSong: Card | null;
  phase: GamePhase;
}

// Display-only: the video, its guessing-phase overlay, and the reveal-phase song info.
// Reveal/Next Round are host controls, not display — they live on /host, not here.
export default function MusicPlayer({ currentSong, phase }: Props) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [playerReady, setPlayerReady] = useState(false);

  useEffect(() => {
    if (!currentSong || typeof window === "undefined") return;

    let cancelled = false;
    let player: YT.Player | null = null;

    function initPlayer() {
      if (!playerRef.current || !currentSong) return;
      // The YouTube API throws "Invalid video id" for a malformed id (e.g. a hand-made saved playlist).
      // Thrown inside this effect it would take down the whole host page, so keep the round playable without audio.
      try {
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
      } catch (err) {
        console.warn("MusicPlayer: could not start the video", err);
      }
    }

    whenYouTubeApiReady(() => { if (!cancelled) initPlayer(); });

    return () => {
      cancelled = true;
      if (typeof player?.destroy === "function") player.destroy(); // absent until onReady on the real API
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
    <div className="flex flex-col gap-4">
      {/* Video + overlay — self-contained, overflow-hidden for rounded corners */}
      <div className="relative rounded-2xl overflow-hidden bg-black">
        {/* YouTube IFrame target */}
        <div ref={playerRef} className="w-full aspect-video" />

        {/* Overlay — covers video during guessing phase */}
        {phase === "guessing" && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--ink)]/90 backdrop-blur-sm"
            style={{ willChange: "opacity" }}
          >
            {/* CSS waveform */}
            <div className="flex items-end gap-1 h-16 mb-6" aria-label="Audio playing">
              {[0.4, 0.7, 1, 0.6, 0.9, 0.5, 0.8, 0.3, 0.75, 0.55].map((h, i) => (
                <div
                  key={i}
                  className="w-2 rounded-full animate-wave"
                  style={{
                    ["--h" as string]: `${h * 64}px`,
                    height: `${h * 64}px`,
                    background: "var(--orange)",
                    animationDelay: `${i * 0.1}s`,
                  }}
                />
              ))}
            </div>
            <p style={{ color: "var(--text3)", fontSize: 13 }}>聆聽中… Listening</p>
          </div>
        )}
      </div>

      {/* Reveal phase: show song info */}
      {phase === "reveal" && (
        <div style={{ background: "rgba(255,214,0,.08)", borderRadius: 14, padding: "14px 16px", border: "1.5px solid rgba(255,214,0,.2)" }}>
          <p style={{ fontWeight: 900, fontSize: 16, color: "var(--ink)" }}>{currentSong.title}</p>
          <p style={{ fontFamily: "var(--font-mono)", color: "var(--orange)", fontSize: 22, fontWeight: 700, marginTop: 2 }}>{currentSong.year}</p>
          <p style={{ color: "var(--text2)", fontSize: 12, marginTop: 2 }}>{currentSong.artist}</p>
        </div>
      )}
    </div>
  );
}

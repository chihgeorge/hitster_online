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
  const targetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const loadedRef = useRef<string | null>(null);
  const wantIdRef = useRef<string | null>(currentSong?.videoId ?? null);
  wantIdRef.current = currentSong?.videoId ?? null;
  const [blocked, setBlocked] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null);

  function sync() {
    const p = playerRef.current;
    if (!p || typeof p.loadVideoById !== "function") return; // API not ready yet; onReady calls sync again
    const wantId = wantIdRef.current;
    if (!wantId || loadedRef.current === wantId) return;
    loadedRef.current = wantId;
    try {
      p.loadVideoById(wantId);
    } catch (err) {
      // A malformed id makes the API throw; the round stays playable without audio/video.
      console.warn("MusicPlayer: could not load the video", err);
      setFailedId(wantId);
    }
  }

  useEffect(() => {
    let cancelled = false;

    function create() {
      if (cancelled || !targetRef.current) return;
      // YT.Player replaces its target with an iframe, so give every create its own child element,
      // and only ever create ONE player for the life of this component — song changes flow through
      // sync()/loadVideoById below, never a second `new YT.Player(...)`. Recreating the player on
      // every videoId change (the old code did this via a `[currentSong?.videoId]` effect dep) reused
      // the same now-detached target across constructions: the second construction silently produced
      // a player with no video loaded — no error, no video, no audio, invisible in a screenshot because
      // the guessing-phase CSS overlay renders regardless of whether the player behind it works. This
      // was the exact shape of the "screen has no audio" bug: it only hit connections that mounted
      // MusicPlayer with a not-yet-privileged (redacted, empty) videoId first and a real one moments
      // later — i.e. /screen opened after the round had already started (see JOIN_SCREEN in party/index.ts).
      const el = document.createElement("div");
      // YT.Player carries the target element's class over to the iframe that replaces it — without
      // this, the player falls back to YouTube's default 640x390 instead of filling the container.
      el.className = "w-full aspect-video";
      targetRef.current.appendChild(el);
      try {
        playerRef.current = new window.YT.Player(el, {
          playerVars: { autoplay: 1, controls: 0, modestbranding: 1, playsinline: 1, rel: 0 },
          events: {
            onReady: () => sync(),
            onAutoplayBlocked: () => setBlocked(true),
            onStateChange: (e: { data: number }) => { if (e.data === 1) setBlocked(false); }, // 1 = playing
            onError: () => setFailedId(wantIdRef.current),
          },
        });
      } catch (err) {
        console.warn("MusicPlayer: could not start the video", err);
      }
    }

    whenYouTubeApiReady(() => { if (!cancelled) create(); });

    return () => {
      cancelled = true;
      const p = playerRef.current;
      if (typeof p?.destroy === "function") p.destroy(); // absent until onReady on the real API
      targetRef.current?.replaceChildren();
      playerRef.current = null;
      loadedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; sync reads the latest id via wantIdRef
  }, []);

  useEffect(() => {
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync reads the latest id via wantIdRef
  }, [currentSong?.videoId]);

  if (!currentSong) {
    return (
      <div className="flex items-center justify-center h-64 rounded-2xl bg-white/5">
        <p className="text-gray-500">No song loaded</p>
      </div>
    );
  }

  const failed = failedId === currentSong.videoId;
  const showBlocked = !failed && blocked;

  return (
    <div className="flex flex-col gap-4">
      {/* Video + overlay — self-contained, overflow-hidden for rounded corners */}
      <div className="relative rounded-2xl overflow-hidden bg-black">
        {/* YouTube IFrame target */}
        <div ref={targetRef} className="w-full aspect-video" />

        {/* Overlay — covers video during guessing phase */}
        {phase === "guessing" && !failed && !showBlocked && (
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

        {/* Browser blocked unmuted autoplay (common on /screen, which nobody taps) — one click unlocks
            audio for the rest of the page's lifetime, same fix LyricsPlayer already uses on /host. */}
        {showBlocked && (
          <button
            type="button"
            data-testid="music-play-btn"
            onClick={() => { setBlocked(false); playerRef.current?.playVideo(); }}
            className="absolute inset-0 flex items-center justify-center"
            style={{ background: "var(--ink)", border: "none", cursor: "pointer" }}
          >
            <span style={{ background: "var(--orange)", borderRadius: 14, padding: "12px 20px", fontSize: 15, fontWeight: 900, color: "white", fontFamily: "var(--font-zh)", boxShadow: "0 6px 20px rgba(255,107,53,.4)" }}>
              🔊 瀏覽器擋住了自動播放，點此播放 · Click to play
            </span>
          </button>
        )}

        {failed && (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: "var(--ink)" }}>
            <p data-testid="music-audio-error" style={{ color: "var(--text3)", fontSize: 14, fontWeight: 700, textAlign: "center", padding: "0 20px", fontFamily: "var(--font-zh)" }}>
              ⚠️ 這首歌無法播放，本回合沒有音樂 · This song can&apos;t be played, no audio this round
            </p>
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

"use client";

import { useEffect, useRef, useState } from "react";
import { whenYouTubeApiReady } from "@/lib/youtube-iframe-api";

interface Props {
  /** Fixed victory-song video id, or null to play nothing (no song configured yet). */
  videoId: string | null;
}

/**
 * Audio for the winner screen — one song, autoplays once, no switching. Same safe pattern as
 * LyricsPlayer/MusicPlayer: create the YT.Player exactly once (see the root-cause comment in
 * MusicPlayer.tsx for why recreating it is broken), hidden like LyricsPlayer since only the
 * confetti/trophy visual should show, not a video. Includes the same autoplay-blocked fallback —
 * /screen is a passive tab nobody taps, so the browser often blocks unmuted autoplay outright.
 */
export default function VictoryPlayer({ videoId }: Props) {
  const targetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;

    function create() {
      if (cancelled || !targetRef.current) return;
      const el = document.createElement("div");
      targetRef.current!.appendChild(el);
      try {
        playerRef.current = new window.YT.Player(el, {
          width: "200",
          height: "200",
          videoId,
          playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0 },
          events: { onAutoplayBlocked: () => setBlocked(true) },
        });
      } catch (err) {
        console.warn("VictoryPlayer: could not start the victory song", err);
      }
    }

    whenYouTubeApiReady(() => { if (!cancelled) create(); });

    return () => {
      cancelled = true;
      const p = playerRef.current;
      if (typeof p?.destroy === "function") p.destroy();
      targetRef.current?.replaceChildren();
      playerRef.current = null;
    };
  }, [videoId]);

  if (!videoId) return null;

  return (
    <>
      {/* Kept in the layout (not display:none) so the browser still lets it play */}
      <div aria-hidden style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}>
        <div ref={targetRef} />
      </div>
      {blocked && (
        <button
          type="button"
          data-testid="victory-play-btn"
          onClick={() => { setBlocked(false); playerRef.current?.playVideo(); }}
          style={{
            position: "absolute", left: "50%", bottom: 16, transform: "translateX(-50%)",
            background: "var(--orange)", border: "none", borderRadius: 14, padding: "10px 18px",
            fontSize: 14, fontWeight: 900, color: "white", cursor: "pointer", fontFamily: "var(--font-zh)",
            boxShadow: "0 6px 20px rgba(255,107,53,.4)", zIndex: 10,
          }}
        >
          🔊 點此播放音樂 · Click for victory music
        </button>
      )}
    </>
  );
}

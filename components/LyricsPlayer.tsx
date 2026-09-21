"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Video for the current round, or null when nothing should be loaded (lobby, preview, ended). */
  videoId: string | null;
  /** true = audible (round start and results), false = paused (host has cut the song). */
  playing: boolean;
}

// Host-side audio for Lyrics Mode. One persistent YouTube player: it autoplays when a round starts,
// pauses on Cut, resumes on the results screen, and loads the next song each round. The video is
// visually hidden so lyric videos don't show the answer on a shared screen.
export default function LyricsPlayer({ videoId, playing }: Props) {
  const targetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const loadedRef = useRef<string | null>(null);
  const wantRef = useRef({ videoId, playing });
  wantRef.current = { videoId, playing };
  const [blocked, setBlocked] = useState(false);

  function sync() {
    const p = playerRef.current;
    if (!p || typeof p.loadVideoById !== "function") return; // API not ready yet; onReady calls sync again
    const want = wantRef.current;
    if (!want.videoId) {
      p.pauseVideo();
      return;
    }
    if (loadedRef.current !== want.videoId) {
      loadedRef.current = want.videoId;
      if (want.playing) p.loadVideoById(want.videoId);
      else p.cueVideoById(want.videoId);
      return;
    }
    if (want.playing) p.playVideo();
    else p.pauseVideo();
  }

  useEffect(() => {
    let cancelled = false;

    function create() {
      if (cancelled || !targetRef.current) return;
      playerRef.current = new window.YT.Player(targetRef.current, {
        width: "200",
        height: "200",
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0 },
        events: {
          onReady: () => sync(),
          onAutoplayBlocked: () => setBlocked(true),
        },
      });
    }

    if (window.YT?.Player) {
      create();
    } else {
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
      }
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        create();
      };
    }

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      loadedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; sync reads the latest props via wantRef
  }, []);

  useEffect(() => {
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync reads the latest props via wantRef
  }, [videoId, playing]);

  return (
    <>
      {/* Kept in the layout (not display:none) so the browser still lets it play */}
      <div
        aria-hidden
        style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}
      >
        <div ref={targetRef} />
      </div>
      {blocked && playing && videoId && (
        <button
          type="button"
          data-testid="lyrics-play-btn"
          onClick={() => { setBlocked(false); playerRef.current?.playVideo(); }}
          style={{ background: "#FFF0E8", border: "2px solid rgba(255,107,53,.3)", borderRadius: 12, padding: "10px 14px", fontSize: 13, fontWeight: 700, color: "#1A1A2E", cursor: "pointer", fontFamily: "var(--font-zh)" }}
        >
          🔊 瀏覽器擋住了自動播放，點此播放 · Click to play
        </button>
      )}
    </>
  );
}

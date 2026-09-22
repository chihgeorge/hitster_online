"use client";

import { useEffect, useRef, useState } from "react";
import { whenYouTubeApiReady } from "@/lib/youtube-iframe-api";

interface Props {
  /** Video for the current round, or null when nothing should be loaded (lobby, preview, ended). */
  videoId: string | null;
  /** true = audible (round start and results), false = paused (host has cut the song). */
  playing: boolean;
}

type AudioReply = { videoId: string | null; roundIndex: number };
type AudioState = { phase: string; currentRoundIndex: number };

/** The host player exists only while a round is running; it stays mounted across rounds. */
export function isAudioPhase(state: { phase: string } | null): boolean {
  return !!state && ["playing", "guessing", "results"].includes(state.phase);
}

/**
 * Maps the lyrics game state plus the host-only LYRICS_AUDIO reply to what the player should do:
 * audible in `playing` and `results`, paused on Cut. A reply for another round is ignored, so the
 * player pauses (rather than replays the old song) until the new round's reply arrives.
 */
export function lyricsAudioProps(state: AudioState | null, audio: AudioReply | null): Props {
  if (!state || !isAudioPhase(state) || !audio?.videoId || audio.roundIndex !== state.currentRoundIndex) {
    return { videoId: null, playing: false };
  }
  return { videoId: audio.videoId, playing: state.phase !== "guessing" };
}

/** True when the host still has to ask the server for this round's video id. A reply with a null id counts as answered. */
export function needsLyricsAudio(state: AudioState | null, audio: AudioReply | null): boolean {
  return isAudioPhase(state) && audio?.roundIndex !== state!.currentRoundIndex;
}

// Host-side audio for Lyrics Mode. One persistent YouTube player (the host page keeps it mounted for the
// whole game): it autoplays when a round starts, pauses on Cut, resumes on the results screen, and loads
// the next song each round. The video is
// visually hidden so lyric videos don't show the answer on a shared screen.
export default function LyricsPlayer({ videoId, playing }: Props) {
  const targetRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YT.Player | null>(null);
  const loadedRef = useRef<string | null>(null);
  const wantRef = useRef({ videoId, playing });
  wantRef.current = { videoId, playing };
  const [blocked, setBlocked] = useState(false);
  const [failedId, setFailedId] = useState<string | null>(null); // video the embed refused to play

  function sync() {
    const p = playerRef.current;
    if (!p || typeof p.loadVideoById !== "function") return; // API not ready yet; onReady calls sync again
    const want = wantRef.current;
    if (!want.videoId) {
      p.pauseVideo();
      loadedRef.current = null; // a repeat of the same song later must restart, not resume
      return;
    }
    if (loadedRef.current !== want.videoId) {
      loadedRef.current = want.videoId;
      try {
        if (want.playing) p.loadVideoById(want.videoId);
        else p.cueVideoById(want.videoId);
      } catch (err) {
        // A malformed id makes the API throw; show the can't-play notice instead of crashing the host page
        console.warn("LyricsPlayer: could not load the video", err);
        setFailedId(want.videoId);
      }
      return;
    }
    if (want.playing) p.playVideo();
    else p.pauseVideo();
  }

  useEffect(() => {
    let cancelled = false;

    function create() {
      if (cancelled || !targetRef.current) return;
      // YT.Player replaces its target with an iframe, so give every create its own element
      const el = document.createElement("div");
      targetRef.current.appendChild(el);
      playerRef.current = new window.YT.Player(el, {
        // 200px is the smallest size YouTube embeds reliably play at; the wrapper below clips it to 1px
        width: "200",
        height: "200",
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0 },
        events: {
          onReady: () => sync(),
          onAutoplayBlocked: () => setBlocked(true),
          onStateChange: (e: { data: number }) => { if (e.data === 1) setBlocked(false); }, // 1 = playing
          // Embedding blocked, video removed or age-restricted: the round continues, just without audio
          onError: () => setFailedId(wantRef.current.videoId),
        },
      });
    }

    whenYouTubeApiReady(create);

    return () => {
      cancelled = true;
      const p = playerRef.current;
      if (typeof p?.destroy === "function") p.destroy(); // absent until onReady on the real API
      targetRef.current?.replaceChildren();
      playerRef.current = null;
      loadedRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; sync reads the latest props via wantRef
  }, []);

  useEffect(() => {
    sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync reads the latest props via wantRef
  }, [videoId, playing]);

  const failed = !!videoId && failedId === videoId;
  const showBlocked = !failed && blocked && playing && !!videoId;

  return (
    <>
      {/* Kept in the layout (not display:none) so the browser still lets it play */}
      <div
        aria-hidden
        style={{ position: "fixed", bottom: 0, left: 0, width: 1, height: 1, opacity: 0, overflow: "hidden", pointerEvents: "none" }}
      >
        <div ref={targetRef} />
      </div>
      {/* Fixed so the host sees it whatever the scroll position */}
      {failed || showBlocked ? (
        <div
          role="status"
          style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 50, width: "min(92vw, 420px)" }}
        >
          {failed ? (
            <div data-testid="lyrics-audio-error" style={{ background: "var(--surface2)", border: "2px solid rgba(255,59,92,.4)", borderRadius: 14, padding: "12px 16px", fontSize: 14, fontWeight: 700, color: "var(--ink)", textAlign: "center", fontFamily: "var(--font-zh)", boxShadow: "0 6px 20px rgba(0,0,0,.15)" }}>
              ⚠️ 這首歌無法播放，本回合沒有音樂 · This song can&apos;t be played, no audio this round
            </div>
          ) : (
            <button
              type="button"
              data-testid="lyrics-play-btn"
              onClick={() => { setBlocked(false); playerRef.current?.playVideo(); }}
              style={{ width: "100%", minHeight: 48, background: "var(--orange)", border: "none", borderRadius: 14, padding: "12px 16px", fontSize: 15, fontWeight: 900, color: "white", cursor: "pointer", fontFamily: "var(--font-zh)", boxShadow: "0 6px 20px rgba(255,107,53,.4)" }}
            >
              🔊 瀏覽器擋住了自動播放，點此播放 · Click to play
            </button>
          )}
        </div>
      ) : null}
    </>
  );
}

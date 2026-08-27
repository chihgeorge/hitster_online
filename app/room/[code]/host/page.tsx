"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import MusicPlayer from "@/components/MusicPlayer";
import PlayerList from "@/components/PlayerList";
import type { GameState, ServerMessage, ClientMessage, SongDiagnostic } from "@/lib/game";

function getOrCreateHostId(): string {
  const key = "hitster_host_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function HostPage() {
  const params = useParams<{ code: string }>();
  const [state, setState] = useState<GameState | null>(null);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [targetCount, setTargetCount] = useState(10);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [diagnostic, setDiagnostic] = useState<SongDiagnostic[] | null>(null);
  const [showDiagnostic, setShowDiagnostic] = useState(false);
  const hostIdRef = useRef<string>("");
  const startingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    hostIdRef.current = getOrCreateHostId();
  }, []);

  function stopStarting() {
    if (startingTimerRef.current) {
      clearTimeout(startingTimerRef.current);
      startingTimerRef.current = null;
    }
    setStarting(false);
  }

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      if (msg.type === "STATE") {
        setState(msg.state);
        if (msg.state.phase !== "lobby") stopStarting();
      }
      if (msg.type === "ERROR") {
        setError(msg.error);
        stopStarting();
      }
      if (msg.type === "DIAGNOSTIC") {
        setDiagnostic(msg.songs);
      }
    },
  });

  function send(msg: ClientMessage) {
    socket.send(JSON.stringify(msg));
  }

  function handleStartGame(e: React.FormEvent) {
    e.preventDefault();
    if (!playlistUrl.trim()) { setError("missing_url"); return; }
    setError("");
    setDiagnostic(null);
    setShowDiagnostic(false);
    setStarting(true);
    startingTimerRef.current = setTimeout(() => {
      startingTimerRef.current = null;
      setStarting(false);
      setError("game_creation_timeout");
    }, 90_000);
    send({
      type: "START_GAME",
      hostId: hostIdRef.current,
      playlistUrl: playlistUrl.trim(),
      targetCardCount: targetCount,
    });
  }

  function handleReveal() {
    send({ type: "REVEAL", hostId: hostIdRef.current });
  }

  function handleNextRound() {
    send({ type: "NEXT_ROUND", hostId: hostIdRef.current });
  }

  function handleResetGame() {
    send({ type: "RESET_GAME", hostId: hostIdRef.current });
  }

  const phase = state?.phase ?? "lobby";
  const playerCount = Object.keys(state?.players ?? {}).length;

  return (
    <div className="min-h-screen flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-gray-500">Room code</p>
          <h1 className="text-4xl font-mono font-bold tracking-[0.3em] text-yellow-400">
            {params.code}
          </h1>
        </div>
        <div className="text-right text-sm text-gray-400">
          {playerCount} player{playerCount !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Creating game loading screen */}
      {phase === "lobby" && starting && (
        <div className="flex flex-col items-center justify-center gap-6 py-16">
          <div className="relative w-16 h-16">
            <div className="absolute inset-0 rounded-full border-4 border-white/10" />
            <div className="absolute inset-0 rounded-full border-4 border-yellow-400 border-t-transparent animate-spin" />
          </div>
          <div className="text-center flex flex-col gap-1">
            <p className="text-xl font-semibold text-white">Creating game…</p>
            <p className="text-sm text-gray-400">Fetching playlist and looking up release years</p>
          </div>
          {diagnostic && (
            <div className="w-full max-w-2xl">
              <DiagnosticTable songs={diagnostic} />
            </div>
          )}
        </div>
      )}

      {/* Lobby setup */}
      {phase === "lobby" && !starting && (
        <form onSubmit={handleStartGame} className="flex flex-col gap-4 bg-white/5 rounded-2xl p-6">
          <h2 className="font-semibold text-lg">Set up the game</h2>
          <div>
            <label className="text-sm text-gray-400 mb-1 block">YouTube playlist URL</label>
            <input
              type="url"
              placeholder="https://www.youtube.com/playlist?list=..."
              value={playlistUrl}
              onChange={(e) => { setPlaylistUrl(e.target.value); setError(""); }}
              className="w-full rounded-xl bg-white/10 px-4 py-3 text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-yellow-400"
            />
          </div>
          <div>
            <label className="text-sm text-gray-400 mb-1 block">
              Cards to win: <span className="text-yellow-400 font-bold">{targetCount}</span>
            </label>
            <input
              type="range"
              min={5}
              max={20}
              value={targetCount}
              onChange={(e) => setTargetCount(Number(e.target.value))}
              className="w-full"
            />
          </div>
          {error && <ErrorBanner code={error} />}
          {diagnostic && <DiagnosticTable songs={diagnostic} />}
          <button
            type="submit"
            disabled={playerCount === 0}
            className="rounded-xl bg-yellow-400 py-3 font-bold text-black hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            Start Game
          </button>
          {playerCount === 0 && (
            <p className="text-xs text-gray-500 text-center">
              Share code <span className="font-mono text-yellow-400">{params.code}</span> — waiting for players to join
            </p>
          )}
        </form>
      )}

      {/* Game in progress */}
      {(phase === "guessing" || phase === "reveal") && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          <MusicPlayer
            currentSong={state?.currentSong ?? null}
            phase={phase}
            placementCount={Object.keys(state?.placements ?? {}).length}
            onReveal={handleReveal}
            onNextRound={handleNextRound}
          />
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500 mb-3">
              Round {state?.currentRound}
            </p>
            <PlayerList
              players={state?.players ?? {}}
              placements={state?.placements ?? {}}
              targetCardCount={state?.targetCardCount ?? 10}
              activePlayerId={state?.activePlayerId}
              phase={phase}
            />
          </div>
        </div>
      )}

      {/* Game ended */}
      {phase === "ended" && state && (
        <div className="flex flex-col items-center gap-6 py-12">
          <p className="text-gray-400 uppercase tracking-widest text-sm">Winner!</p>
          <h2 className="text-4xl font-bold text-yellow-400">
            {state.players[state.winner ?? ""]?.name ?? "Unknown"}
          </h2>
          <div className="w-full max-w-sm">
            <PlayerList
              players={state.players}
              placements={{}}
              targetCardCount={state.targetCardCount}
              activePlayerId={null}
            />
          </div>
          <button
            onClick={handleResetGame}
            className="rounded-xl bg-white/10 px-8 py-3 font-semibold hover:bg-white/20 transition-colors"
          >
            Play again
          </button>
        </div>
      )}

      {/* Persistent song metadata panel */}
      {diagnostic && phase !== "lobby" && (
        <div className="border border-white/10 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowDiagnostic((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-3 text-sm text-gray-400 hover:bg-white/5 transition-colors"
          >
            <span>
              Song metadata{" "}
              <span className="text-yellow-400 font-semibold">
                {diagnostic.filter((s) => s.year !== null).length}
              </span>
              <span className="text-gray-500">/{diagnostic.length} years resolved</span>
            </span>
            <span className="text-gray-500 text-xs">{showDiagnostic ? "▲ hide" : "▼ show"}</span>
          </button>
          {showDiagnostic && (
            <div className="px-5 pb-5">
              <DiagnosticTable songs={diagnostic} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiagnosticTable({ songs }: { songs: SongDiagnostic[] }) {
  const resolved = songs.filter((s) => s.year !== null).length;
  const total = songs.length;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-gray-400">
        Resolved <span className="text-yellow-400 font-semibold">{resolved}</span> of{" "}
        <span className="font-semibold">{total}</span> songs
      </p>
      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-white/10">
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="px-3 py-2 font-medium">Artist</th>
              <th className="px-3 py-2 font-medium">Year</th>
              <th className="px-3 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {songs.map((s, i) => (
              <tr key={i} className={`border-b border-white/5 last:border-0 ${s.year ? "" : "opacity-40"}`}>
                <td className="px-3 py-2 max-w-[200px] truncate text-white/80" title={s.title}>
                  {s.title}
                </td>
                <td className="px-3 py-2 max-w-[120px] truncate text-white/60" title={s.artist}>
                  {s.artist}
                </td>
                <td className="px-3 py-2 font-mono text-yellow-400">
                  {s.year ?? "—"}
                </td>
                <td className="px-3 py-2">
                  {s.yearSource === "description" && <span className="text-green-400">YouTube</span>}
                  {s.yearSource === "title" && <span className="text-blue-400">title</span>}
                  {s.yearSource === "spotify" && <span className="text-purple-400">Spotify</span>}
                  {s.yearSource === "google" && <span className="text-sky-400">Google</span>}
                  {s.yearSource === null && <span className="text-red-400">not found</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ErrorBanner({ code }: { code: string }) {
  const info = errorInfo(code);
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex flex-col gap-1">
      <p className="text-red-400 text-sm font-semibold">{info.message}</p>
      {info.detail && <p className="text-red-300/70 text-xs">{info.detail}</p>}
      {info.hint && (
        <p className="text-gray-400 text-xs mt-1">
          <span className="text-yellow-400">Hint:</span> {info.hint}
        </p>
      )}
    </div>
  );
}

function errorInfo(code: string): { message: string; detail?: string; hint?: string } {
  if (code === "missing_url") return { message: "Paste a YouTube playlist URL" };
  if (code === "unauthorized") return { message: "Host token mismatch — refresh and try again" };
  if (code === "quota_exceeded") return {
    message: "YouTube API quota exceeded",
    detail: "The daily quota for the YouTube Data API has been used up.",
    hint: "Try again after midnight Pacific Time when the quota resets.",
  };
  if (code === "game_creation_timeout") return {
    message: "Game creation timed out",
    detail: "The server took over 90 seconds to process the playlist.",
    hint: "Spotify may be temporarily rate-limited. Try again in a minute or two.",
  };
  if (code === "not_enough_songs") return {
    message: "Not enough songs with known release years",
    detail: "Fewer than 2 songs had a resolvable year (from description, title, or Spotify).",
    hint: "Try a playlist with more mainstream tracks, or one from YouTube Music.",
  };
  if (code === "api_key_missing") return {
    message: "API key not configured",
    detail: "The server is missing YOUTUBE_API_KEY or Spotify credentials.",
    hint: "Check that the environment variables are set in the PartyKit deployment.",
  };
  if (code === "playlist_forbidden") return {
    message: "Playlist access denied (403)",
    detail: "The YouTube API key may be restricted, or the playlist is private.",
    hint: "Make sure the playlist is public and the API key has no referrer/IP restrictions.",
  };
  if (code === "playlist_not_found") return {
    message: "Playlist not found (404)",
    detail: "YouTube returned a 404 for this playlist ID.",
    hint: "Double-check the URL — the playlist may have been deleted or set to private.",
  };
  if (code === "spotify_error") return {
    message: "Spotify API error",
    detail: "Could not get a Spotify access token. Client ID or secret may be wrong.",
    hint: "Year lookup will fail for any songs without years in their title or description.",
  };
  if (code.startsWith("youtube_error:")) {
    const status = code.split(":")[1];
    return {
      message: `YouTube API error (HTTP ${status})`,
      detail: `The YouTube Data API returned status ${status}.`,
      hint: status === "400" ? "The playlist URL may be malformed." : "Check the API key and playlist visibility.",
    };
  }
  if (code === "playlist_load_failed") return {
    message: "Couldn't load this playlist",
    detail: "An unexpected error occurred while fetching the playlist.",
    hint: "Check the URL format: it should be a youtube.com/playlist?list=... link.",
  };
  return { message: `Error: ${code}` };
}

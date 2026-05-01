"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import MusicPlayer from "@/components/MusicPlayer";
import PlayerList from "@/components/PlayerList";
import type { GameState, ServerMessage, ClientMessage } from "@/lib/game";

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
  const hostIdRef = useRef<string>("");

  useEffect(() => {
    hostIdRef.current = getOrCreateHostId();
  }, []);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onMessage(event: MessageEvent) {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      if (msg.type === "STATE") {
        setState(msg.state);
        setStarting(false);
      }
      if (msg.type === "ERROR") {
        setError(msg.error);
        setStarting(false);
      }
    },
  });

  function send(msg: ClientMessage) {
    socket.send(JSON.stringify(msg));
  }

  function handleStartGame(e: React.FormEvent) {
    e.preventDefault();
    if (!playlistUrl.trim()) { setError("Paste a YouTube playlist URL"); return; }
    setError("");
    setStarting(true);
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

      {/* Lobby setup */}
      {phase === "lobby" && (
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
          {error && <p className="text-red-400 text-sm">{errorMessage(error)}</p>}
          <button
            type="submit"
            disabled={starting || playerCount === 0}
            className="rounded-xl bg-yellow-400 py-3 font-bold text-black hover:bg-yellow-300 transition-colors disabled:opacity-50"
          >
            {starting ? "Loading playlist…" : "Start Game"}
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
            />
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-xl bg-white/10 px-8 py-3 font-semibold hover:bg-white/20 transition-colors"
          >
            Play again
          </button>
        </div>
      )}
    </div>
  );
}

function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    quota_exceeded: "YouTube API quota exceeded — try again after midnight PT",
    not_enough_songs: "Couldn't resolve enough song years from this playlist (need at least 2)",
    playlist_load_failed: "Couldn't load this playlist — check the URL and try again",
    unauthorized: "Host token mismatch — refresh and try again",
  };
  return messages[code] ?? `Error: ${code}`;
}

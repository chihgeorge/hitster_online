"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import usePartySocket from "partysocket/react";
import Timeline from "@/components/Timeline";
import type { GameState, ServerMessage, ClientMessage, Player } from "@/lib/game";

function getOrCreatePlayerId(): string {
  const key = "hitster_player_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

export default function PlayPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const playerName = searchParams.get("name") ?? "Player";

  const [state, setState] = useState<GameState | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<number | null>(null);
  const [hasPlaced, setHasPlaced] = useState(false);
  const [tooLate, setTooLate] = useState(false);
  const playerIdRef = useRef<string>("");

  useEffect(() => {
    playerIdRef.current = getOrCreatePlayerId();
  }, []);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onOpen() {
      // Join or rejoin
      const stored = localStorage.getItem("hitster_player_id");
      if (stored) {
        send({ type: "REJOIN", playerId: stored, name: playerName });
      } else {
        playerIdRef.current = getOrCreatePlayerId();
        send({ type: "JOIN", playerId: playerIdRef.current, name: playerName });
      }
    },
    onMessage(event: MessageEvent) {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      switch (msg.type) {
        case "STATE":
          setState(msg.state);
          // Reset placement state when a new round starts
          if (msg.state.phase === "guessing" && state?.phase !== "guessing") {
            setHasPlaced(false);
            setTooLate(false);
            setSelectedPosition(null);
          }
          break;
        case "PLACEMENT_ACK":
          if (msg.playerId === playerIdRef.current) setHasPlaced(true);
          break;
        case "TOO_LATE":
          setTooLate(true);
          break;
      }
    },
  });

  function send(msg: ClientMessage) {
    socket.send(JSON.stringify(msg));
  }

  function handlePlace() {
    if (selectedPosition === null) return;
    send({ type: "PLACE", playerId: playerIdRef.current, position: selectedPosition });
  }

  const phase = state?.phase ?? "lobby";
  const myPlayer: Player | null = state?.players[playerIdRef.current] ?? null;

  if (phase === "lobby") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4">
        <h1 className="text-3xl font-bold text-yellow-400">HITSTER!</h1>
        <p className="text-gray-400">
          You&apos;re in — waiting for the host to start…
        </p>
        <p className="text-sm text-gray-600">
          Room <span className="font-mono text-yellow-400">{params.code}</span> · {playerName}
        </p>
      </main>
    );
  }

  if (phase === "ended" && state) {
    const winner = state.players[state.winner ?? ""];
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-gray-400 text-sm uppercase tracking-widest">Game over</p>
        {state.winner === playerIdRef.current ? (
          <h1 className="text-4xl font-bold text-yellow-400">You won! 🎉</h1>
        ) : (
          <>
            <h1 className="text-2xl font-bold">Winner: {winner?.name ?? "Unknown"}</h1>
            <p className="text-gray-400">You collected {myPlayer?.cardCount ?? 0} cards</p>
          </>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen pb-40 px-3 pt-4">
      {/* Mini header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs text-gray-500 uppercase tracking-widest">Round {state?.currentRound}</p>
          <p className="font-semibold">{playerName}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-yellow-400">{myPlayer?.cardCount ?? 0}</p>
          <p className="text-xs text-gray-500">cards</p>
        </div>
      </div>

      <Timeline
        timeline={myPlayer?.timeline ?? []}
        currentSong={state?.currentSong ?? null}
        phase={phase}
        selectedPosition={selectedPosition}
        onSelectPosition={setSelectedPosition}
        onPlace={handlePlace}
        hasPlaced={hasPlaced}
        tooLate={tooLate}
      />
    </main>
  );
}

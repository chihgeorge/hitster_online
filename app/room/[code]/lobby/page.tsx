"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import usePartySocket from "partysocket/react";
import type { GameState, ServerMessage } from "@/lib/game";

export default function LobbyPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const [state, setState] = useState<GameState | null>(null);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      if (msg.type === "STATE") {
        setState(msg.state);
        if (msg.state.phase !== "lobby") {
          // Host started the game — redirect to play
          router.push(`/room/${params.code}/play`);
        }
      }
    },
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <p className="text-gray-400 text-sm uppercase tracking-widest">Room</p>
        <h1 className="text-6xl font-mono font-bold tracking-[0.3em] text-yellow-400">
          {params.code}
        </h1>
        <p className="mt-2 text-gray-400">Waiting for host to start…</p>
      </div>

      <div className="w-full max-w-sm">
        <h2 className="text-sm uppercase tracking-widest text-gray-500 mb-3">
          Players ({Object.keys(state?.players ?? {}).length})
        </h2>
        <ul className="flex flex-col gap-2">
          {Object.entries(state?.players ?? {}).map(([playerId, player]) => (
            <li
              key={playerId}
              className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3"
            >
              <span className="h-2 w-2 rounded-full bg-green-400" />
              <span className="font-medium">{player.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

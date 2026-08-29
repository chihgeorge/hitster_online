"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { generateRoomCode } from "@/lib/game";

export default function HomePage() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [mode, setMode] = useState<"home" | "join">("home");
  const [error, setError] = useState("");

  function handleCreateRoom() {
    const code = generateRoomCode();
    router.push(`/room/${code}/host`);
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const name = playerName.trim().slice(0, 20);
    const code = joinCode.trim().toUpperCase();
    if (!name) { setError("Enter your name"); return; }
    if (code.length !== 4) { setError("Enter a 4-letter room code"); return; }
    router.push(`/room/${code}/play?name=${encodeURIComponent(name)}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-5xl font-bold tracking-tight text-yellow-400">HITSTER!</h1>
        <p className="mt-2 text-lg text-gray-400">Music timeline game — online edition</p>
        <p className="mt-1 text-xs text-gray-600">Fan project · Not affiliated with Jumbo/Helvetiq</p>
      </div>

      {mode === "home" && (
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button
            onClick={handleCreateRoom}
            className="rounded-xl bg-yellow-400 px-6 py-4 text-lg font-bold text-black hover:bg-yellow-300 transition-colors"
          >
            Create a room
          </button>
          <button
            onClick={() => setMode("join")}
            className="rounded-xl border border-white/20 px-6 py-4 text-lg font-semibold text-white hover:bg-white/10 transition-colors"
          >
            Join a room
          </button>
        </div>
      )}

      {mode === "join" && (
        <form onSubmit={handleJoin} className="flex flex-col gap-4 w-full max-w-xs">
          <input
            type="text"
            placeholder="Your name"
            value={playerName}
            onChange={(e) => { setPlayerName(e.target.value); setError(""); }}
            maxLength={20}
            className="rounded-xl bg-white/10 px-4 py-3 text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-yellow-400"
          />
          <input
            type="text"
            placeholder="Room code (e.g. ABCD)"
            value={joinCode}
            onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setError(""); }}
            maxLength={4}
            className="rounded-xl bg-white/10 px-4 py-3 text-white placeholder-gray-500 outline-none focus:ring-2 focus:ring-yellow-400 uppercase tracking-widest text-center text-xl font-mono"
          />
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button
            type="submit"
            className="rounded-xl bg-yellow-400 px-6 py-4 text-lg font-bold text-black hover:bg-yellow-300 transition-colors"
          >
            Join
          </button>
          <button
            type="button"
            onClick={() => setMode("home")}
            className="text-sm text-gray-500 hover:text-gray-300"
          >
            ← Back
          </button>
        </form>
      )}
    </main>
  );
}

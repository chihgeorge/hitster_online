"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import usePartySocket from "partysocket/react";
import type { GameState, ServerMessage } from "@/lib/game";

function SmallVinyl() {
  return (
    <div className="animate-vinyl rounded-full mx-auto" style={{
      width: 80, height: 80,
      background: "radial-gradient(circle, #FF6B35 0%, #E85520 34%, #1A1A2E 36%, #1A1A2E 42%, #E85520 44%, #1A1A2E 46%, #1A1A2E 56%, #E85520 58%, #1A1A2E 60%, #1A1A2E 100%)",
      boxShadow: "0 8px 28px rgba(255,107,53,.35)",
      position: "relative",
    }}>
      <div className="absolute rounded-full" style={{
        top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: 16, height: 16, background: "#FFF9F5",
      }} />
    </div>
  );
}

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
          router.push(`/room/${params.code}/play`);
        }
      }
    },
  });

  const playerCount = Object.keys(state?.players ?? {}).length;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-7 px-5 py-12"
      style={{ background: "#FFF9F5" }}>

      {/* Header */}
      <div className="flex flex-col items-center gap-4">
        <SmallVinyl />
        <h1 className="title-outlined" style={{ fontSize: 44, lineHeight: 1 }}>HITSTER!</h1>
      </div>

      {/* Room code chip */}
      <div style={{
        background: "#1A1A2E", borderRadius: 20,
        padding: "16px 32px", textAlign: "center",
      }}>
        <p style={{ fontSize: 11, color: "#7B7B9A", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 4 }}>
          Room Code
        </p>
        <p style={{
          fontFamily: "var(--font-mono)", fontSize: 36, letterSpacing: ".22em",
          color: "#FFD600", fontWeight: 700,
        }}>
          {params.code}
        </p>
      </div>

      {/* Status */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#7B7B9A", fontSize: 14 }}>
        <span className="animate-pulse-dot" style={{
          display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#FF6B35",
        }} />
        等待主持人開始遊戲…
      </div>

      {/* Player list */}
      <div style={{
        background: "white", borderRadius: 20, padding: 20,
        boxShadow: "0 4px 20px rgba(255,107,53,.08)",
        width: "100%", maxWidth: 360,
      }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "#B0AFBC", marginBottom: 12 }}>
          玩家 · Players ({playerCount})
        </p>
        <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {Object.entries(state?.players ?? {}).map(([playerId, player]) => (
            <li key={playerId} className="animate-fade-up" style={{
              display: "flex", alignItems: "center", gap: 12,
              background: "#FFF0E8", borderRadius: 14, padding: "11px 14px",
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%", background: "#00C896",
                flexShrink: 0, boxShadow: "0 0 6px rgba(0,200,150,.5)",
              }} />
              <span style={{ fontWeight: 700, color: "#1A1A2E", fontSize: 15 }}>{player.name}</span>
            </li>
          ))}
          {playerCount === 0 && (
            <li style={{ textAlign: "center", color: "#C0B8B0", fontSize: 13, padding: "8px 0" }}>
              還沒有玩家…
            </li>
          )}
        </ul>
      </div>
    </main>
  );
}

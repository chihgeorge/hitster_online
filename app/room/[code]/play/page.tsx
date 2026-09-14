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

function SmallVinyl({ size = 80 }: { size?: number }) {
  return (
    <div className="animate-vinyl rounded-full mx-auto" style={{
      width: size, height: size,
      background: "radial-gradient(circle, #FF6B35 0%, #E85520 34%, #1A1A2E 36%, #1A1A2E 42%, #E85520 44%, #1A1A2E 46%, #1A1A2E 56%, #E85520 58%, #1A1A2E 60%, #1A1A2E 100%)",
      boxShadow: "0 8px 28px rgba(255,107,53,.35)",
      position: "relative", flexShrink: 0,
    }}>
      <div className="absolute rounded-full" style={{
        top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: size * 0.2, height: size * 0.2, background: "#FFF9F5",
      }} />
    </div>
  );
}

export default function PlayPage() {
  const params = useParams<{ code: string }>();
  const searchParams = useSearchParams();
  const playerName = searchParams.get("name") ?? "Player";

  const [state, setState] = useState<GameState | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<number | null>(null);
  const [hasPlaced, setHasPlaced] = useState(false);
  const [tooLate, setTooLate] = useState(false);
  const [showCodeWarning, setShowCodeWarning] = useState(false);
  const playerIdRef = useRef<string>("");

  useEffect(() => {
    playerIdRef.current = getOrCreatePlayerId();
  }, []);

  useEffect(() => {
    if (state?.phase === "guessing") {
      setHasPlaced(false);
      setTooLate(false);
      setSelectedPosition(null);
    }
  }, [state?.phase]);

  useEffect(() => {
    if (state !== null && state.phase !== "lobby") return;
    const timer = setTimeout(() => setShowCodeWarning(true), 90_000);
    return () => clearTimeout(timer);
  }, [state]);

  const socket = usePartySocket({
    host: process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999",
    room: params.code,
    onOpen() {
      const stored = localStorage.getItem("hitster_player_id");
      if (stored) {
        send({ type: "REJOIN", playerId: stored, name: playerName });
      } else {
        playerIdRef.current = getOrCreatePlayerId();
        send({ type: "JOIN", playerId: playerIdRef.current, name: playerName });
      }
    },
    onMessage(event: MessageEvent) {
      let msg: ServerMessage;
      try { msg = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
      switch (msg.type) {
        case "STATE":
          setState(msg.state);
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
  const isMyTurn = state?.activePlayerId === playerIdRef.current;
  const activePlayer = state?.activePlayerId ? state.players[state.activePlayerId] : null;

  /* ── Lobby waiting view ── */
  if (phase === "lobby") {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-5 py-12"
        style={{ background: "#FFF9F5" }}>
        <SmallVinyl size={80} />
        <h1 className="title-outlined" style={{ fontSize: 40, lineHeight: 1 }}>HITSTER!</h1>

        <div style={{
          background: "white", borderRadius: 20, padding: "20px 24px",
          boxShadow: "0 4px 20px rgba(255,107,53,.08)",
          width: "100%", maxWidth: 340, textAlign: "center",
        }}>
          <p style={{ fontSize: 14, color: "#1A1A2E", fontWeight: 700 }}>{playerName}</p>
          <p style={{ fontSize: 12, color: "#B0AFBC", marginTop: 2 }}>
            房間 · Room{" "}
            <span style={{ fontFamily: "var(--font-mono)", color: "#FF6B35", fontWeight: 700 }}>
              {params.code}
            </span>
          </p>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 16 }}>
            <span className="animate-pulse-dot" style={{
              display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: "#FF6B35",
            }} />
            <span style={{ color: "#7B7B9A", fontSize: 14 }}>等待主持人開始遊戲…</span>
          </div>
        </div>

        {showCodeWarning && (
          <div style={{
            background: "#FFF0E8", border: "2px solid rgba(255,107,53,.4)", borderRadius: 16,
            padding: "14px 18px", maxWidth: 340, textAlign: "center",
          }}>
            <p style={{ color: "#E85520", fontSize: 13, fontWeight: 700 }}>
              等待超過 90 秒？請確認房間代碼是否正確。
            </p>
          </div>
        )}
      </main>
    );
  }

  /* ── Game ended view ── */
  if (phase === "ended" && state) {
    const winner = state.players[state.winner ?? ""];
    const isWinner = state.winner === playerIdRef.current;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-5 py-12"
        style={{ background: "#FFF9F5" }}>
        <SmallVinyl size={90} />
        <div style={{ textAlign: "center" }}>
          {isWinner ? (
            <>
              <h1 className="title-outlined" style={{ fontSize: 48, lineHeight: 1.05 }}>WINNER!</h1>
              <p style={{ color: "#7B7B9A", fontSize: 15, marginTop: 6 }}>你贏了！ 🎉</p>
            </>
          ) : (
            <>
              <p style={{ color: "#B0AFBC", fontSize: 12, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>
                遊戲結束 · Game Over
              </p>
              <h1 style={{ fontSize: 26, fontWeight: 900, color: "#1A1A2E" }}>
                {winner?.name ?? "Unknown"} 贏了！
              </h1>
            </>
          )}
        </div>

        {/* Leaderboard */}
        <div style={{
          background: "white", borderRadius: 20, padding: 20,
          boxShadow: "0 4px 20px rgba(255,107,53,.08)",
          width: "100%", maxWidth: 340,
        }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: "#B0AFBC", marginBottom: 12 }}>
            最終排名 · Final Scores
          </p>
          <ul style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {Object.entries(state.players)
              .sort(([, a], [, b]) => b.cardCount - a.cardCount)
              .map(([id, player], idx) => (
                <li key={id} style={{
                  display: "flex", alignItems: "center", gap: 12,
                  background: id === state.winner ? "#FFF0E8" : "#F8F8FC",
                  borderRadius: 14, padding: "11px 14px",
                  border: id === state.winner ? "2px solid rgba(255,107,53,.3)" : "2px solid transparent",
                }}>
                  <span style={{
                    width: 24, height: 24, borderRadius: "50%",
                    background: idx === 0 ? "#FFD600" : idx === 1 ? "#C0C0C0" : idx === 2 ? "#CD7F32" : "#E8E8F0",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 900, color: "#1A1A2E", flexShrink: 0,
                  }}>{idx + 1}</span>
                  <span style={{ fontWeight: 700, color: "#1A1A2E", fontSize: 14, flex: 1 }}>{player.name}</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "#FF6B35", fontWeight: 700, fontSize: 16 }}>
                    {player.cardCount}
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </main>
    );
  }

  /* ── Active game view (guessing / reveal) ── */
  return (
    <main className="min-h-screen px-4 pt-5" style={{ background: "#FFF9F5", paddingBottom: 220 }}>
      {/* Header bar */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 18,
      }}>
        <div>
          <p style={{ fontSize: 10, color: "#B0AFBC", textTransform: "uppercase", letterSpacing: ".1em" }}>
            第 {state?.currentRound} 回合 · Round
          </p>
          <p style={{ fontWeight: 900, color: "#1A1A2E", fontSize: 16 }}>{playerName}</p>
        </div>
        <div style={{
          background: "#1A1A2E", borderRadius: 14, padding: "8px 16px", textAlign: "center",
        }}>
          <p style={{ fontFamily: "var(--font-mono)", color: "#FFD600", fontWeight: 700, fontSize: 22, lineHeight: 1 }}>
            {myPlayer?.cardCount ?? 0}
          </p>
          <p style={{ fontSize: 9, color: "#7B7B9A", textTransform: "uppercase", letterSpacing: ".08em" }}>cards</p>
        </div>
      </div>

      <Timeline
        timeline={myPlayer?.timeline ?? []}
        currentSong={state?.currentSong ?? null}
        phase={phase}
        isMyTurn={isMyTurn}
        activePlayerName={activePlayer?.name ?? null}
        selectedPosition={selectedPosition}
        onSelectPosition={setSelectedPosition}
        onPlace={handlePlace}
        hasPlaced={hasPlaced}
        tooLate={tooLate}
      />
    </main>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { generateRoomCode } from "@/lib/game";

function Vinyl({ size = 160 }: { size?: number }) {
  return (
    <div
      className="animate-vinyl rounded-full flex-shrink-0 relative"
      style={{
        width: size, height: size,
        background: `radial-gradient(circle, var(--orange) 0%, var(--orange-dk) 34%, var(--ink) 36%, var(--ink) 42%, var(--orange-dk) 44%, var(--ink) 46%, var(--ink) 56%, var(--orange-dk) 58%, var(--ink) 60%, var(--ink) 100%)`,
        boxShadow: "0 12px 48px rgba(255,107,53,.38), 0 4px 12px rgba(0,0,0,.2)",
      }}
    >
      <div className="absolute rounded-full" style={{
        top: "50%", left: "50%", transform: "translate(-50%,-50%)",
        width: size * 0.2, height: size * 0.2,
        background: "var(--bg)",
        boxShadow: `0 0 0 ${size * 0.05}px rgba(255,107,53,.18)`,
      }} />
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [joinCode, setJoinCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [error, setError] = useState("");

  function handleCreateRoom() {
    const code = generateRoomCode();
    router.push(`/room/${code}/host`);
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const name = playerName.trim().slice(0, 20);
    const code = joinCode.trim().toUpperCase();
    if (!name) { setError("請輸入你的名字"); return; }
    if (code.length !== 4) { setError("請輸入 4 碼房間代碼"); return; }
    router.push(`/room/${code}/play?name=${encodeURIComponent(name)}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-5 py-12"
      style={{ background: "var(--bg)" }}>

      {/* Hero */}
      <div className="flex flex-col items-center gap-5">
        <div className="relative">
          <Vinyl size={160} />
          <span className="animate-sparkle absolute" style={{ top: -22, right: -28, fontSize: 18, color: "var(--orange)" }}>✦</span>
          <span className="animate-sparkle absolute" style={{ bottom: -10, left: -34, fontSize: 13, color: "var(--gold)", animationDelay: ".9s" }}>✦</span>
          <span className="animate-sparkle absolute" style={{ top: 18, left: -40, fontSize: 15, color: "var(--orange)", animationDelay: "1.5s" }}>✦</span>
        </div>
        <div className="text-center">
          <h1 className="title-outlined" style={{ fontSize: "clamp(52px,10vw,80px)", lineHeight: 1.05, letterSpacing: "-.5px" }}>
            HITSTER!
          </h1>
          <p style={{ color: "var(--text2)", fontSize: 15, marginTop: 6, fontWeight: 400 }}>
            聆聽歌曲 · 猜猜發行年份 · 贏得勝利
          </p>
        </div>
      </div>

      {/* Join box */}
      <form onSubmit={handleJoin} style={{
        background: "white", borderRadius: 24, padding: "24px 24px",
        boxShadow: "0 8px 40px rgba(255,107,53,.1), 0 2px 8px rgba(0,0,0,.04)",
        width: "100%", maxWidth: 380, display: "flex", flexDirection: "column", gap: 12,
      }}>
        <p style={{ fontSize: 12, fontWeight: 700, color: "var(--text3)", marginBottom: 2 }}>
          加入現有房間
        </p>
        <input
          type="text"
          placeholder="你的名字"
          value={playerName}
          onChange={(e) => { setPlayerName(e.target.value); setError(""); }}
          maxLength={20}
          style={{
            background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
            padding: "13px 16px", fontSize: 15, color: "var(--ink)", outline: "none",
            fontFamily: "var(--font-zh)",
          }}
          onFocus={(e) => (e.target.style.borderColor = "var(--orange)")}
          onBlur={(e) => (e.target.style.borderColor = "rgba(255,107,53,.2)")}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <input
            type="text"
            placeholder="房間代碼"
            value={joinCode}
            onChange={(e) => { setJoinCode(e.target.value.toUpperCase()); setError(""); }}
            maxLength={4}
            style={{
              flex: 1, minWidth: 0, background: "var(--surface2)", border: "2px solid rgba(255,107,53,.2)", borderRadius: 14,
              padding: "13px 16px", fontSize: 16, color: "var(--ink)", outline: "none",
              fontFamily: "var(--font-mono)", letterSpacing: ".18em", textAlign: "center", textTransform: "uppercase",
            }}
            onFocus={(e) => (e.target.style.borderColor = "var(--orange)")}
            onBlur={(e) => (e.target.style.borderColor = "rgba(255,107,53,.2)")}
          />
          <button type="submit" style={{
            background: "var(--orange)", color: "white", border: "none", borderRadius: 14,
            padding: "13px 20px", fontSize: 15, fontWeight: 900, cursor: "pointer",
            fontFamily: "var(--font-zh)", whiteSpace: "nowrap",
            boxShadow: "0 4px 12px rgba(255,107,53,.3)",
            alignSelf: "stretch",
          }}>
            加入 →
          </button>
        </div>
        {error && (
          <p style={{ color: "var(--red)", fontSize: 13, textAlign: "center" }}>{error}</p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#D0C8C0", fontSize: 12 }}>
          <div style={{ flex: 1, height: 1, background: "#F0E8E0" }} />
          或
          <div style={{ flex: 1, height: 1, background: "#F0E8E0" }} />
        </div>

        <button type="button" onClick={handleCreateRoom} style={{
          background: "var(--orange)", color: "white", border: "none", borderRadius: 14,
          padding: "14px", fontSize: 15, fontWeight: 900, cursor: "pointer",
          fontFamily: "var(--font-zh)", boxShadow: "0 4px 16px rgba(255,107,53,.35)",
        }}>
          🎮 主持遊戲 · Create a Room
        </button>
      </form>

      <p style={{ fontSize: 11, color: "#C0B8B0", textAlign: "center" }}>
        Fan project · Not affiliated with Jumbo/Helvetiq
      </p>
    </main>
  );
}

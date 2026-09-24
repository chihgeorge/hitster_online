"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Vinyl from "@/components/Vinyl";
import { generateRoomCode } from "@/lib/game";

// useSearchParams() (for the QR-embedded ?code=) requires a Suspense boundary on a statically
// prerendered page, or `next build` fails: "useSearchParams() should be wrapped in a suspense
// boundary". The homepage has no meaningful loading state — Vinyl renders instantly either way —
// so the fallback is the same page shell with an empty join box, not a spinner.
export default function HomePage() {
  return (
    <Suspense fallback={<HomePageShell />}>
      <HomePageContent />
    </Suspense>
  );
}

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [joinCode, setJoinCode] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [error, setError] = useState("");
  // A player scanning the /screen QR arrives with ?code=<roomcode> already embedded — they only
  // ever need to type their name. The field itself stays reachable (never removed) as a fallback
  // for anyone who typed the URL by hand or is joining without scanning.
  const [showCodeField, setShowCodeField] = useState(true);

  useEffect(() => {
    const codeFromUrl = searchParams.get("code")?.trim().toUpperCase() ?? "";
    if (codeFromUrl.length === 4) {
      setJoinCode(codeFromUrl);
      setShowCodeField(false);
    }
  }, [searchParams]);

  function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const name = playerName.trim().slice(0, 20);
    const code = joinCode.trim().toUpperCase();
    if (!name) { setError("請輸入你的名字"); return; }
    if (code.length !== 4) { setError("請輸入 4 碼房間代碼"); return; }
    router.push(`/room/${code}/play?name=${encodeURIComponent(name)}`);
  }

  // Room creation is an explicit, deliberate action — not something a page load does on its
  // own. The site is public: anyone can reach this page, so nothing here creates a room just
  // from being visited (see /room/[code]/screen's isCreator comment for the rest of that story).
  function handleCreateRoom() {
    const code = generateRoomCode();
    router.push(`/room/${code}/screen?created=1`);
  }

  // Cross-device host handoff: the room code isn't secret (it's on the screen already), but
  // reaching /host from it is a PERMANENT, one-shot claim with no re-claim path — an
  // accidental tap here would silently lock the real host out for the rest of the game.
  // The confirm is the one cheap guard that keeps that risk where it was before this link
  // existed (deliberate action only), per /plan-eng-review's outside-voice finding.
  function handleManageAsHost() {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 4) return;
    const ok = window.confirm("只有負責設定這個房間的人才需要點這個，繼續嗎？\nOnly tap this if you set up this room — continue?");
    if (ok) router.push(`/room/${code}/host`);
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
          data-testid="join-name-input"
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
        {showCodeField ? (
          <div style={{ display: "flex", gap: 10 }}>
            <input
              type="text"
              data-testid="join-code-input"
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
            <button type="submit" data-testid="join-room-btn" style={{
              background: "var(--orange)", color: "white", border: "none", borderRadius: 14,
              padding: "13px 20px", fontSize: 15, fontWeight: 900, cursor: "pointer",
              fontFamily: "var(--font-zh)", whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(255,107,53,.3)",
              alignSelf: "stretch",
            }}>
              加入 →
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ background: "var(--surface2)", borderRadius: 14, padding: "13px 16px", fontFamily: "var(--font-mono)", fontSize: 16, letterSpacing: ".18em", color: "var(--ink)" }}>
              {joinCode}
            </div>
            <button
              type="button"
              data-testid="change-code-btn"
              onClick={() => setShowCodeField(true)}
              style={{ background: "none", border: "none", color: "var(--text3)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
            >
              更改代碼
            </button>
            <button type="submit" data-testid="join-room-btn" style={{
              background: "var(--orange)", color: "white", border: "none", borderRadius: 14,
              padding: "13px 20px", fontSize: 15, fontWeight: 900, cursor: "pointer",
              fontFamily: "var(--font-zh)", whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(255,107,53,.3)",
            }}>
              加入 →
            </button>
          </div>
        )}
        {error && (
          <p style={{ color: "var(--red)", fontSize: 13, textAlign: "center" }}>{error}</p>
        )}
        {joinCode.trim().length === 4 && (
          <button
            type="button"
            data-testid="manage-as-host-link"
            onClick={handleManageAsHost}
            style={{
              background: "none", border: "none", color: "var(--text3)", fontSize: 11,
              cursor: "pointer", textDecoration: "underline", alignSelf: "center", padding: 0,
            }}
          >
            或者：管理此房間 · Or: manage this room
          </button>
        )}
      </form>

      {/* Room creation lives here, not on a page that creates one just by being loaded — see
          handleCreateRoom. Goes to /screen (the big-screen lobby with the join QR), not
          straight to /host: this device gets a private host link there, same as before. */}
      <button
        type="button"
        onClick={handleCreateRoom}
        style={{
          background: "white", color: "var(--orange)", border: "2px solid rgba(255,107,53,.25)", borderRadius: 16,
          padding: "13px 28px", fontSize: 14, fontWeight: 800, cursor: "pointer",
          fontFamily: "var(--font-zh)", boxShadow: "0 4px 14px rgba(255,107,53,.08)",
        }}
      >
        📺 建立房間 · Create a Room
      </button>

      <p style={{ fontSize: 11, color: "#C0B8B0", textAlign: "center" }}>
        Fan project · Not affiliated with Jumbo/Helvetiq
      </p>
    </main>
  );
}

/** Suspense fallback — just the hero; the join form appears a frame later once ?code= resolves. */
function HomePageShell() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 px-5 py-12"
      style={{ background: "var(--bg)" }}>
      <div className="flex flex-col items-center gap-5">
        <Vinyl size={160} />
        <div className="text-center">
          <h1 className="title-outlined" style={{ fontSize: "clamp(52px,10vw,80px)", lineHeight: 1.05, letterSpacing: "-.5px" }}>
            HITSTER!
          </h1>
        </div>
      </div>
    </main>
  );
}

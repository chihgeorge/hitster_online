"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Vinyl from "@/components/Vinyl";

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
        {showCodeField ? (
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
            <button type="submit" style={{
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
      </form>

      <Link href="/screen" style={{ fontSize: 13, color: "var(--text2)", textDecoration: "underline" }}>
        設定電視 / 大螢幕 → Setting up the TV?
      </Link>

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

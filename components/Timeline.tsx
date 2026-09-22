"use client";

import type { Card, GamePhase } from "@/lib/game";

interface Props {
  timeline: Card[];
  currentSong: Card | null;
  phase: GamePhase;
  isMyTurn: boolean;
  activePlayerName: string | null;
  selectedPosition: number | null;
  onSelectPosition: (position: number) => void;
  onPlace: () => void;
  hasPlaced: boolean;
  tooLate: boolean;
}

export default function Timeline({
  timeline,
  currentSong,
  phase,
  isMyTurn,
  activePlayerName,
  selectedPosition,
  onSelectPosition,
  onPlace,
  hasPlaced,
  tooLate,
}: Props) {
  const canPlace = phase === "guessing" && isMyTurn && !hasPlaced && !tooLate;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, paddingBottom: 200 }}>

      {/* Now-playing card — shown during guessing for my-turn player */}
      {currentSong && phase === "guessing" && isMyTurn && (
        <div style={{ marginBottom: 20 }}>
          <div style={{
            background: "var(--orange)", borderRadius: 20, padding: "18px 20px",
            boxShadow: "0 8px 32px rgba(255,107,53,.35)",
          }}>
            <p style={{ fontSize: 11, color: "rgba(255,255,255,.7)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 8 }}>
              🎵 現正播放 · Now Playing
            </p>
            {/* Waveform bars */}
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 28, marginBottom: 10 }}>
              {[22, 14, 26, 18, 30, 12, 24, 16, 20, 28].map((h, i) => (
                <div key={i} className="animate-wave" style={{
                  ["--h" as string]: `${h}px`,
                  width: 4, height: `${h}px`, borderRadius: 3,
                  background: "rgba(255,255,255,.85)",
                  animationDelay: `${i * 0.08}s`,
                }} />
              ))}
            </div>
            <p style={{ color: "white", fontWeight: 900, fontSize: 16, lineHeight: 1.2 }}>聆聽歌曲，然後放到時間線上</p>
            <p style={{ color: "rgba(255,255,255,.7)", fontSize: 12, marginTop: 3 }}>Listen and place it on your timeline</p>
          </div>
        </div>
      )}

      {/* Spectator notice */}
      {currentSong && phase === "guessing" && !isMyTurn && (
        <div style={{
          background: "var(--surface2)", borderRadius: 16, padding: "14px 16px",
          border: "2px solid rgba(255,107,53,.2)", marginBottom: 16, textAlign: "center",
        }}>
          <p style={{ color: "var(--text2)", fontSize: 14 }}>
            <span style={{ color: "var(--orange)", fontWeight: 900 }}>{activePlayerName ?? "玩家"}</span> 正在猜測中…
          </p>
        </div>
      )}

      {/* Reveal result card */}
      {currentSong && phase === "reveal" && (
        <div style={{
          background: "var(--ink)", borderRadius: 20, padding: "20px 20px",
          boxShadow: "0 8px 32px rgba(26,26,46,.3)", marginBottom: 20, textAlign: "center",
        }}>
          <p style={{ color: "var(--text2)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 6 }}>答案 · The Answer</p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 44, color: "var(--gold)", fontWeight: 700, lineHeight: 1 }}>{currentSong.year}</p>
          <p style={{ color: "white", fontWeight: 700, fontSize: 15, marginTop: 6 }}>{currentSong.title}</p>
          <p style={{ color: "var(--text2)", fontSize: 13 }}>{currentSong.artist}</p>
        </div>
      )}

      {/* Timeline label */}
      <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 10 }}>
        你的時間線 · Your Timeline ({timeline.length} cards)
      </p>

      {/* Horizontal scroll timeline */}
      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <div style={{
          display: "flex", flexDirection: "row", gap: 8, alignItems: "stretch",
          minWidth: "max-content", paddingRight: 4,
        }}>
          {/* Drop zone before first card */}
          {canPlace && (
            <DropZone
              position={0}
              selected={selectedPosition === 0}
              onSelect={() => onSelectPosition(0)}
            />
          )}

          {timeline.map((card, idx) => (
            <div key={card.id} style={{ display: "flex", alignItems: "stretch", gap: 8 }}>
              <TimelineCard card={card} />
              {canPlace && (
                <DropZone
                  position={idx + 1}
                  selected={selectedPosition === idx + 1}
                  onSelect={() => onSelectPosition(idx + 1)}
                />
              )}
            </div>
          ))}

          {timeline.length === 0 && !canPlace && (
            <div style={{
              width: 160, background: "var(--surface2)", borderRadius: 16,
              border: "2px dashed rgba(255,107,53,.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              padding: "16px 12px", minHeight: 100,
            }}>
              <p style={{ color: "#C0B8B0", fontSize: 12, textAlign: "center" }}>
                時間線是空的<br/>Timeline empty
              </p>
            </div>
          )}

          {timeline.length === 0 && canPlace && (
            <p style={{ color: "var(--text3)", fontSize: 12, alignSelf: "center", padding: "0 8px" }}>
              放在任何位置
            </p>
          )}
        </div>
      </div>

      {/* CTA bar */}
      {canPlace && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, padding: "16px 16px 24px",
          background: "linear-gradient(to top, var(--bg) 70%, transparent)",
        }}>
          {hasPlaced ? (
            <div style={{
              background: "var(--mint)", borderRadius: 16, padding: "15px", textAlign: "center",
            }}>
              <p style={{ color: "white", fontWeight: 900, fontSize: 16 }}>已放置 ✓ 等待主持人揭曉</p>
            </div>
          ) : tooLate ? (
            <div style={{
              background: "var(--red)", borderRadius: 16, padding: "15px", textAlign: "center",
            }}>
              <p style={{ color: "white", fontWeight: 900, fontSize: 16 }}>太晚了！</p>
            </div>
          ) : selectedPosition !== null ? (
            <button data-testid="place-btn" onClick={onPlace} style={{
              width: "100%", background: "var(--orange)", color: "white",
              border: "none", borderRadius: 16, padding: "16px",
              fontSize: 17, fontWeight: 900, cursor: "pointer",
              fontFamily: "var(--font-zh)",
              boxShadow: "0 4px 20px rgba(255,107,53,.4)",
            }}>
              確認放置 →
            </button>
          ) : (
            <div style={{
              background: "white", borderRadius: 16, padding: "15px", textAlign: "center",
              border: "2px solid rgba(255,107,53,.2)",
            }}>
              <p style={{ color: "var(--text3)", fontSize: 14 }}>← 滑動時間線，點選位置 →</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineCard({ card }: { card: Card }) {
  return (
    <div style={{
      width: 92, flexShrink: 0, background: "white", borderRadius: 16,
      border: "2px solid rgba(255,107,53,.15)",
      padding: "14px 10px", textAlign: "center", minHeight: 100,
      display: "flex", flexDirection: "column", justifyContent: "center", gap: 4,
      boxShadow: "0 2px 10px rgba(255,107,53,.07)",
    }}>
      <p style={{
        fontFamily: "var(--font-mono)", color: "var(--orange)", fontWeight: 700,
        fontSize: 22, lineHeight: 1,
      }}>
        {card.year}
      </p>
      <p style={{
        fontWeight: 700, color: "var(--ink)", fontSize: 11,
        lineHeight: 1.3, overflow: "hidden", display: "-webkit-box",
        WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      }}>
        {card.artist}
      </p>
      <p style={{
        color: "var(--text3)", fontSize: 10,
        overflow: "hidden", display: "-webkit-box",
        WebkitLineClamp: 2, WebkitBoxOrient: "vertical", lineHeight: 1.3,
      }}>
        {card.title}
      </p>
    </div>
  );
}

function DropZone({
  position,
  selected,
  onSelect,
}: {
  position: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={selected ? "" : "animate-dz-pulse"}
      style={{
        width: 52, flexShrink: 0, minHeight: 100,
        border: `2px dashed ${selected ? "var(--orange)" : "rgba(255,107,53,.35)"}`,
        borderRadius: 16, background: selected ? "rgba(255,107,53,.1)" : "transparent",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        transition: "border-color .15s, background .15s",
      }}
    >
      <span style={{ fontSize: selected ? 18 : 16, color: selected ? "var(--orange)" : "rgba(255,107,53,.5)" }}>
        {selected ? "▶" : "+"}
      </span>
    </button>
  );
}

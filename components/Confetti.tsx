"use client";

import { useMemo } from "react";

const COLORS = ["var(--orange)", "var(--gold)", "var(--mint)", "var(--orange-dk)", "var(--red)"];

/** Falling confetti overlay for the winner screen — pure CSS, no assets. */
export default function Confetti({ count = 40 }: { count?: number }) {
  // Randomize once per mount, not per render, so pieces don't jump around on every re-render.
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        color: COLORS[i % COLORS.length],
        size: 6 + Math.random() * 8,
        duration: 2.5 + Math.random() * 2.5,
        delay: Math.random() * 3,
        round: Math.random() > 0.5,
      })),
    [count]
  );

  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      {pieces.map((p) => (
        <div
          key={p.id}
          className="animate-confetti"
          style={{
            position: "absolute", top: 0, left: `${p.left}%`,
            width: p.size, height: p.size * (p.round ? 1 : 1.6),
            background: p.color, borderRadius: p.round ? "50%" : 2,
            animationDuration: `${p.duration}s`, animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

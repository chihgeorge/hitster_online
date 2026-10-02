"use client";

import { useMemo } from "react";

const COLORS = ["var(--orange)", "var(--gold)", "var(--mint)", "var(--orange-dk)", "var(--red)"];

// Deterministic 0..1 noise: render stays pure (React compiler) and pieces never jump between renders.
const noise = (n: number) => {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

/** Falling confetti overlay for the winner screen — pure CSS, no assets. */
export default function Confetti({ count = 40 }: { count?: number }) {
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        left: ((i + noise(i + 1)) / count) * 100, // one piece per column slot, jittered: no clumps
        color: COLORS[Math.floor(noise(i + 501) * COLORS.length)], // independent of i so colors don't stripe across columns
        size: 6 + noise(i + 101) * 8,
        duration: 2.5 + noise(i + 201) * 2.5,
        delay: noise(i + 301) * 3,
        round: noise(i + 401) > 0.5,
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

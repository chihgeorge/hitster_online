"use client";

import { useSyncExternalStore, type ReactNode } from "react";

// Ported from the sibling project critical-answer's Stage component (see DESIGN.md).
/** Logical size of the big-screen stage — every /screen layout is built at this size. */
export const STAGE_W = 960;
export const STAGE_H = 540;

function subscribe(cb: () => void) {
  addEventListener("resize", cb);
  return () => removeEventListener("resize", cb);
}
const fitScale = () => Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H);

/**
 * Fixed-size stage scaled to fit the window with transform: scale(), centered and letterboxed
 * outside 16:9. Because the whole canvas scales as one unit, /screen needs no separate TV
 * breakpoint — relative spacing holds at any physical screen size.
 */
export function Stage({ children }: { children: ReactNode }) {
  // Server-rendered fallback (scale 1) avoids a hydration mismatch; the real scale applies on mount.
  const scale = useSyncExternalStore(subscribe, fitScale, () => 1);
  return (
    <div style={{ position: "fixed", inset: 0, overflow: "hidden", background: "#000" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: STAGE_W,
          height: STAGE_H,
          background: "var(--bg)",
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

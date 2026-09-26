"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code for `text`, drawn in the panel colors. Holds its size with a blank box until ready (or while `text` is empty). */
export function Qr({ text, size = 88, alt = "掃描開啟" }: { text: string; size?: number; alt?: string }) {
  // Remember which text the image was drawn for, so a stale code never shows for new text.
  const [drawn, setDrawn] = useState<{ text: string; src: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    // Literal hex, not var(--ink)/var(--surface): the qrcode library draws to a canvas and needs
    // a real color string, not a CSS custom property it can't resolve outside the DOM style system.
    QRCode.toDataURL(text, { width: size, margin: 1, color: { dark: "#1A1A2E", light: "#FFFFFF" } }).then((url) => {
      if (live) setDrawn({ text, src: url });
    }).catch(() => {
      // Too much data for a QR (e.g. a hand-typed, very long room code): keep the blank box.
    });
    return () => {
      live = false;
    };
  }, [text, size]);
  const src = drawn?.text === text ? drawn.src : "";
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} width={size} height={size} alt={alt} style={{ display: "block", borderRadius: 4 }} /> : <div style={{ width: size, height: size }} />;
}

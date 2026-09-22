"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** A QR code for `text`, drawn in the panel colors. Renders nothing until ready. */
export function Qr({ text, size = 88, alt = "掃描開啟" }: { text: string; size?: number; alt?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    // Literal hex, not var(--ink)/var(--surface): the qrcode library draws to a canvas and needs
    // a real color string, not a CSS custom property it can't resolve outside the DOM style system.
    QRCode.toDataURL(text, { width: size, margin: 1, color: { dark: "#1A1A2E", light: "#FFFFFF" } }).then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [text, size]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} width={size} height={size} alt={alt} style={{ display: "block", borderRadius: 4 }} /> : null;
}

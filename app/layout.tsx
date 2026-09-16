import type { Metadata, Viewport } from "next";
import { Nunito, DM_Mono } from "next/font/google";
import "./globals.css";

const nunito = Nunito({ variable: "--font-nunito", weight: ["400", "600", "700", "800", "900"], subsets: ["latin"], display: "swap" });
const dmMono = DM_Mono({ variable: "--font-dm-mono", weight: ["400", "500"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "HITSTER! Online",
  description: "Fan-made online version of the HITSTER! music timeline game. Not affiliated with Jumbo/Helvetiq.",
  manifest: "/manifest.json",
  icons: { apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: "#FF6B35",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW" className={`${nunito.variable} ${dmMono.variable} h-full`}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;700;900&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}

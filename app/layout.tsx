import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "HITSTER! Online",
  description: "Fan-made online version of the HITSTER! music timeline game. Not affiliated with Jumbo/Helvetiq.",
  manifest: "/manifest.json",
  themeColor: "#1a1a2e",
  icons: {
    apple: "/icons/icon-192.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`}>
      <body className="min-h-full bg-[#1a1a2e] text-white antialiased">{children}</body>
    </html>
  );
}

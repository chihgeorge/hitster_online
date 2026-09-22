"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { generateRoomCode } from "@/lib/game";
import Vinyl from "@/components/Vinyl";

// Entry point for setting up the big screen: generates a fresh room and redirects to its
// room-scoped screen view. `created=1` tells THAT page this specific browser is the one that
// made the room, so it (and only it) gets the private "manage as host" link — see
// app/room/[code]/screen/page.tsx. Nothing about a room's existence lives here; this route's
// only job is picking a code and leaving.
export default function ScreenLandingPage() {
  const router = useRouter();

  useEffect(() => {
    const code = generateRoomCode();
    router.replace(`/room/${code}/screen?created=1`);
  }, [router]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6" style={{ background: "var(--bg)" }}>
      <Vinyl size={120} />
      <p style={{ color: "var(--text2)", fontSize: 14 }}>建立房間中… Creating room…</p>
    </main>
  );
}

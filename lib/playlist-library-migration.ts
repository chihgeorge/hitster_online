// One-time migration (docs/designs/decouple-quiz-bank.md, decision D2b): existing hosts
// already have their saved-playlist index in browser localStorage only (the
// "hitster_playlists" key host/page.tsx has always used). Switching either page's source of
// truth to the new server-side library.ts index (D2) would otherwise make those playlists
// silently vanish from the UI on deploy — a data-loss-shaped regression, not just a UX gap.
//
// Silent, idempotent, best-effort: called once per page load from both app/playlists/page.tsx
// and app/room/[code]/host/page.tsx. library.ts's IMPORT action never overwrites an entry
// already present, so calling this on every load (no "have we migrated yet" flag to track) is
// safe — after the first successful run it POSTs the same already-present entries and they're
// all skipped. localStorage itself is left untouched, never cleared, so a failed/partial
// import never loses data; it just gets retried on the next load.

const LOCAL_STORAGE_KEY = "hitster_playlists";

interface LocalPlaylistMeta {
  id: string;
  name: string;
  songCount: number;
}

function readLocalIndex(): LocalPlaylistMeta[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is LocalPlaylistMeta =>
        typeof e === "object" && e !== null &&
        typeof (e as LocalPlaylistMeta).id === "string" &&
        typeof (e as LocalPlaylistMeta).name === "string" &&
        typeof (e as LocalPlaylistMeta).songCount === "number"
    );
  } catch {
    return [];
  }
}

/** Best-effort, fire-and-forget-safe (the caller doesn't need to await or handle rejection —
 * this function never throws). Returns how many entries were newly imported, mostly useful
 * for tests. */
export async function importLocalPlaylistsToLibrary(hostId: string, partyKitHost: string): Promise<number> {
  const entries = readLocalIndex();
  if (entries.length === 0) return 0;
  try {
    const protocol = partyKitHost.startsWith("localhost") ? "http" : "https";
    const res = await fetch(`${protocol}://${partyKitHost}/parties/library/${hostId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "IMPORT", entries }),
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { added?: number };
    return typeof body.added === "number" ? body.added : 0;
  } catch {
    return 0;
  }
}

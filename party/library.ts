// A host's playlist library index — one Durable Object per hostId, storing which
// playlists that host owns (id, name, songCount), so the "Saved Playlists" panel and the
// standalone quiz-bank page (docs/designs/decouple-quiz-bank.md, decision D2) can list a
// host's playlists from ANY device instead of relying on that browser's own localStorage.
//
// Same trust model as everywhere else hostId is used in this app (the P3 TODO on
// "whoever holds the token" — this DO's id IS the hostId, a long random UUID from
// lib/device-id.ts's getOrCreatePersistedId, never transmitted anywhere but the owning
// device except when explicitly shared, e.g. the manage-as-host link). Not a new gap.
//
// Written to by party/playlist.ts's own POST/DELETE handlers via room.context.parties
// (decision D2a) — never by the client directly calling UPSERT/REMOVE, so a playlist and
// its library entry can't drift out of sync from a client that only calls one of the two.
// The one exception is IMPORT, used once by the client-side migration (decision D2b) to
// backfill entries for playlists that predate this DO and only ever lived in localStorage.

import type * as Party from "partykit/server";
import { sanitizeText } from "../lib/utils";

const MAX_ENTRIES = 100;
const MAX_NAME_LEN = 80;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

export interface LibraryEntry {
  id: string;
  name: string;
  songCount: number;
  /** Mirrors SavedPlaylist.sourceUrl (lib/game.ts) — carried in the index too so the host
   * page can dedup-check against the library list it already has, without fetching every
   * individual playlist. Optional, same reasons as there. */
  sourceUrl?: string;
}

function validEntry(raw: unknown): raw is LibraryEntry {
  if (typeof raw !== "object" || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.id === "string" && e.id.trim().length > 0 &&
    typeof e.name === "string" && e.name.trim().length > 0 &&
    typeof e.songCount === "number" && Number.isInteger(e.songCount) && e.songCount >= 0 &&
    (e.sourceUrl === undefined || typeof e.sourceUrl === "string")
  );
}

export default class LibraryParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request): Promise<Response> {
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /parties/library/:hostId — list this host's playlists
    if (method === "GET") {
      const entries = (await this.room.storage.get<Record<string, LibraryEntry>>("entries")) ?? {};
      return json({ entries: Object.values(entries) });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return err("Invalid JSON");
    }

    // PUT /parties/library/:hostId — UPSERT one entry, REMOVE one, or IMPORT many
    if (method === "PUT") {
      const action = body.action;
      const entries = (await this.room.storage.get<Record<string, LibraryEntry>>("entries")) ?? {};

      if (action === "UPSERT") {
        if (!validEntry(body.entry)) return err("entry invalid — {id, name, songCount} required");
        const entry = body.entry as LibraryEntry;
        if (!entries[entry.id] && Object.keys(entries).length >= MAX_ENTRIES) {
          return err(`Library is full (max ${MAX_ENTRIES} playlists)`, 400);
        }
        entries[entry.id] = {
          id: entry.id,
          name: sanitizeText(entry.name, MAX_NAME_LEN),
          songCount: entry.songCount,
          ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}),
        };
        await this.room.storage.put("entries", entries);
        return json({ ok: true });
      }

      if (action === "REMOVE") {
        const { id } = body as { id?: unknown };
        if (typeof id !== "string") return err("id required");
        delete entries[id];
        await this.room.storage.put("entries", entries);
        return json({ ok: true });
      }

      // IMPORT: one-time client-side migration (D2b) — idempotent bulk upsert, skips
      // anything already present so re-running it (e.g. two tabs) is harmless.
      if (action === "IMPORT") {
        const { entries: imported } = body as { entries?: unknown };
        if (!Array.isArray(imported)) return err("entries must be an array");
        let added = 0;
        for (const raw of imported) {
          if (!validEntry(raw)) continue;
          const e = raw as LibraryEntry;
          if (entries[e.id]) continue; // already present — never overwrite a live entry
          if (Object.keys(entries).length >= MAX_ENTRIES) break;
          entries[e.id] = { id: e.id, name: sanitizeText(e.name, MAX_NAME_LEN), songCount: e.songCount };
          added++;
        }
        await this.room.storage.put("entries", entries);
        return json({ ok: true, added });
      }

      return err(`Unknown action ${String(action)}`);
    }

    return err("Method not allowed", 405);
  }

  onConnect(_conn: Party.Connection): void {}
}

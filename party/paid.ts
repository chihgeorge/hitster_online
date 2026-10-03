import type * as Party from "partykit/server";
import type { Storage as PartyStorage } from "partykit/server";
import { resolveEnv, storageBatchGet, STORAGE_BATCH } from "../lib/playlist-resolver";
import { json, err } from "./http";

// One global instance guarding the server's paid third-party work (YouTube Data API quota and
// Anthropic spend): a daily cap on how many paid pipelines may start, and the AI-generated caches
// (title/artist/year metadata, lyric rounds, popularity summaries), shared by every room and saved
// playlist so a song is only ever asked about once.
//
// Every party is reachable over public HTTP, so this one only answers requests carrying a token
// derived from the server's own API key: a browser can't spend the budget down or write fake
// answers into the cache. Public untokened traffic is turned away at the edge (onBeforeRequest /
// onBeforeConnect) before it reaches the Durable Object. Rooms' own calls (context.parties) go
// straight to the Durable Object, skipping the edge, so onRequest checks the token again.

/** Paid pipelines (a playlist resolve, a Lyrics start or an AI edit request) allowed per UTC day. Override with PAID_DAILY_CAP. */
export const DEFAULT_DAILY_CAP = 300;
// The AI-generated cache families party/index.ts and lib/playlist-resolver.ts read and write, and
// their "no usable result" markers (NO_RESULT in lib/playlist-resolver.ts).
const CACHE_PREFIXES = [
  "aiMeta:", "lyrics:", "lyrics-sonnet:", "lyrics-popularity:",
  "noResult:aiMeta:", "noResult:lyrics:", "noResult:lyrics-sonnet:",
];
// ponytail: one global Durable Object for budget and cache, fine at a few hundred pipelines a day;
// shard the cache by videoId across instances (budget stays global) if traffic grows.
const INSTANCE = "global";
// Shared entries never expire. Bump this after a prompt or model change (or to purge a bad
// answer): every room then starts from an empty shared cache.
const CACHE_VERSION = "v1:";
const PAID_TIMEOUT_MS = 5000; // a stalled paid party falls back like an unreachable one

async function internalToken(env: Party.Room["env"]): Promise<string | null> {
  const { anthropicKey, youtubeKey } = resolveEnv(env);
  const secret = anthropicKey ?? youtubeKey;
  if (!secret) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`hitster-paid:${secret}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cacheKey = (k: unknown): k is string => typeof k === "string" && CACHE_PREFIXES.some((p) => k.startsWith(p));

function dailyCap(env: Party.Room["env"]): number {
  const raw = env?.PAID_DAILY_CAP;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP; // "0" really means 0: paid calls off
}

export default class PaidParty implements Party.Server {
  constructor(readonly room: Party.Room) {}

  static async onBeforeRequest(req: Party.Request, lobby: Party.Lobby) {
    const token = await internalToken(lobby.env);
    return token && req.headers.get("x-hitster-internal") === token ? req : err("Not found", 404);
  }

  static onBeforeConnect() {
    return err("Not found", 404); // nothing here speaks WebSocket
  }

  async onRequest(req: Party.Request): Promise<Response> {
    if ((await PaidParty.onBeforeRequest(req, { env: this.room.env } as Party.Lobby)) !== req) return err("Not found", 404);
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return err("Invalid JSON"); }
    const path = new URL(req.url).pathname;

    if (path.endsWith("/budget")) {
      const cap = dailyCap(this.room.env);
      const day = new Date().toISOString().slice(0, 10);
      const key = `budget:${day}`;
      const used = (await this.room.storage.get<number>(key)) ?? 0;
      if (used >= cap) return json({ ok: false, used, cap }, 429);
      await this.room.storage.put(key, used + 1);
      // Once per day, so a global lockout (abuse or real growth) shows up in the logs, not just as complaints.
      if (used + 1 === cap) console.warn(JSON.stringify({ event: "paid_budget_exhausted", day, cap }));
      return json({ ok: true, used: used + 1, cap });
    }
    if (path.endsWith("/cache/get")) {
      const keys = (Array.isArray(body.keys) ? body.keys.filter(cacheKey) : []).map((k) => CACHE_VERSION + k);
      const found = await storageBatchGet(this.room.storage, keys);
      return json({ entries: [...found].map(([k, v]) => [k.slice(CACHE_VERSION.length), v]) });
    }
    if (path.endsWith("/cache/put")) {
      const entries = Object.entries((body.entries ?? {}) as Record<string, unknown>)
        .filter(([k]) => cacheKey(k)).map(([k, v]) => [CACHE_VERSION + k, v]);
      for (let i = 0; i < entries.length; i += STORAGE_BATCH) await this.room.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
      return json({ ok: true });
    }
    return err("Not found", 404);
  }
}

async function callPaid(room: Party.Room, path: string, body: unknown): Promise<Response | null> {
  try {
    const token = await internalToken(room.env);
    if (!token) return null;
    return await room.context.parties.paid.get(INSTANCE).fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hitster-internal": token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

/**
 * Spends one unit of the shared daily budget before a paid pipeline starts. False only when today's
 * cap is used up. Fails open (logged) when the budget can't be reached, so a platform hiccup never
 * blocks a real game night.
 */
export async function spendPaidBudget(room: Party.Room): Promise<boolean> {
  const res = await callPaid(room, "/budget", {});
  if (res?.status === 429) return false;
  if (!res?.ok) console.error(JSON.stringify({ event: "paid_budget_unreachable", status: res?.status ?? null }));
  return true;
}

async function sharedGet(room: Party.Room, keys: string[]): Promise<Map<string, unknown> | null> {
  const res = await callPaid(room, "/cache/get", { keys });
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { entries?: [string, unknown][] } | null;
  return Array.isArray(body?.entries) ? new Map(body.entries) : null;
}

/**
 * The shared AI cache as the get(keys)/put(entries) slice of PartyKit storage the resolvers use.
 * Falls back to this room's own storage when the shared cache can't be reached, which is exactly
 * the per-room cache it replaces.
 *
 * Only for tracks whose title/artist came from YouTube. Client-supplied songs (a saved playlist,
 * a test seed) use the room's own storage instead: made-up titles must not put wrong answers
 * under a real videoId for every room, and a host's own title edits must not be replaced by
 * shared ones.
 */
export function sharedAICache(room: Party.Room): PartyStorage {
  // Once a call fails, the rest of this pipeline uses room storage instead of waiting on each
  // remaining call's timeout in turn.
  let down = false;
  return {
    async get(keys: string[]) {
      const shared = down ? null : await sharedGet(room, keys);
      if (!shared) down = true;
      return shared ?? room.storage.get(keys);
    },
    async put(entries: Record<string, unknown>) {
      if (!down && (await callPaid(room, "/cache/put", { entries }))?.ok) return;
      down = true;
      await room.storage.put(entries);
    },
  } as unknown as PartyStorage;
}

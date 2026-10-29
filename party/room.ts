import type { Room, Storage } from "./types";

// Durable Object bindings the parties call each other through, keyed by URL party name.
// Kept free of `cloudflare:workers` imports so vitest can test it.
export const PARTY_BINDINGS = { main: "Main", playlist: "Playlist", library: "Library", paid: "Paid" } as const;

interface Namespace {
  getByName(name: string): { fetch(req: Request): Promise<Response> };
}

/** The Room the party classes expect, backed by one PartyServer Durable Object. */
export function makeRoom(server: {
  name: string;
  env: Record<string, unknown>;
  ctx: { storage: unknown };
  broadcast(message: string, without?: string[]): void;
}): Room {
  const parties = Object.fromEntries(
    Object.entries(PARTY_BINDINGS).map(([party, binding]) => [party, {
      get: (id: string) => ({
        // getByName sets ctx.id.name, which PartyServer reads as this.name; the origin is a placeholder.
        fetch: (path: string, init?: RequestInit) =>
          (server.env[binding] as Namespace).getByName(id).fetch(new Request(`https://party/parties/${party}/${id}${path}`, init)),
      }),
    }])
  );
  return {
    get id() { return server.name; },
    env: server.env,
    storage: server.ctx.storage as Storage,
    broadcast: (message, without) => server.broadcast(message, without),
    context: { parties },
  };
}

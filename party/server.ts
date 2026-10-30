// Cloudflare Worker entry (wrangler.jsonc). Runs each party class unchanged inside a PartyServer
// Durable Object, so the URLs the clients use stay the same: /parties/<party>/<id>, with
// partysocket's default "main" party for the game room.
import { Server, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import HitsterRoom from "./index";
import PlaylistParty from "./playlist";
import LibraryParty from "./library";
import PaidParty from "./paid";
import { makeRoom, paidGate } from "./room";
import { err } from "./http";
import type { Room } from "./types";

interface Party {
  onStart?(): void | Promise<void>;
  onConnect?(conn: Connection): void | Promise<void>;
  onMessage?(message: string, conn: Connection): void | Promise<void>;
  onClose?(conn: Connection): void | Promise<void>;
  onRequest?(req: Request): Response | Promise<Response>;
}

// Not hibernating (the PartyServer default): HitsterRoom keeps game state and Connection
// objects in memory, which hibernation would drop.
function adapt(Inner: new (room: Room) => Party) {
  return class extends Server<Cloudflare.Env> {
    #party?: Party;
    // partysocket keeps one _pk (PartyServer's connection id) across reconnects, and PartyServer's
    // own list drops by id: an old socket's late close would remove the reconnected phone from
    // every broadcast. So broadcast to the Connection objects we hold instead.
    #conns = new Set<Connection>();
    get party() { return (this.#party ??= new Inner(makeRoom(this as never))); }
    broadcast(message: string, without: string[] = []) {
      for (const conn of this.#conns) {
        if (without.includes(conn.id)) continue;
        try { conn.send(message); } catch { /* closing socket; its close/error drops it */ }
      }
    }
    onStart() { return this.party.onStart?.(); }
    onConnect(conn: Connection) {
      this.#conns.add(conn);
      return this.party.onConnect?.(conn);
    }
    onMessage(conn: Connection, message: WSMessage) {
      if (typeof message === "string") return this.party.onMessage?.(message, conn);
    }
    onClose(conn: Connection) {
      if (!this.#conns.delete(conn)) return;
      return this.party.onClose?.(conn);
    }
    // A dropped socket may report only an error, never a close.
    onError(conn: Connection) { return this.onClose(conn); }
    async onRequest(req: Request) {
      try {
        return (await this.party.onRequest?.(req)) ?? err("Not found", 404);
      } catch (e) {
        // PartyServer would answer with the stack trace and no CORS headers.
        console.error(JSON.stringify({ event: "request_failed", party: Inner.name, error: String(e) }));
        return err("Internal error", 500);
      }
    }
  };
}

export const Main = adapt(HitsterRoom);
export const Playlist = adapt(PlaylistParty);
export const Library = adapt(LibraryParty);
export const Paid = adapt(PaidParty);

export default {
  async fetch(req: Request, env: Cloudflare.Env) {
    return (await routePartykitRequest(req, env as never, { onBeforeRequest: paidGate, onBeforeConnect: paidGate })) ?? err("Not found", 404);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

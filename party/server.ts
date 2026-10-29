// Cloudflare Worker entry (wrangler.jsonc). Runs each party class unchanged inside a PartyServer
// Durable Object, so the URLs the clients use stay the same: /parties/<party>/<id>, with
// partysocket's default "main" party for the game room.
import { Server, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import HitsterRoom from "./index";
import PlaylistParty from "./playlist";
import LibraryParty from "./library";
import PaidParty from "./paid";
import { makeRoom, PARTY_BINDINGS } from "./room";
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
    get party() { return (this.#party ??= new Inner(makeRoom(this as never))); }
    onStart() { return this.party.onStart?.(); }
    onConnect(conn: Connection) { return this.party.onConnect?.(conn); }
    onMessage(conn: Connection, message: WSMessage) {
      if (typeof message === "string") return this.party.onMessage?.(message, conn);
    }
    onClose(conn: Connection) { return this.party.onClose?.(conn); }
    onRequest(req: Request) { return this.party.onRequest?.(req) ?? err("Not found", 404); }
  };
}

export const Main = adapt(HitsterRoom);
export const Playlist = adapt(PlaylistParty);
export const Library = adapt(LibraryParty);
export const Paid = adapt(PaidParty);

// paid is only for the server's own calls (party/room.ts); keep public traffic out entirely.
const gate = (_req: Request, lobby: { className: string }) =>
  lobby.className === PARTY_BINDINGS.paid ? err("Not found", 404) : undefined;

export default {
  async fetch(req: Request, env: Cloudflare.Env) {
    return (await routePartykitRequest(req, env as never, { onBeforeRequest: gate, onBeforeConnect: gate })) ?? err("Not found", 404);
  },
} satisfies ExportedHandler<Cloudflare.Env>;

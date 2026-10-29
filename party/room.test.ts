import { describe, it, expect, vi } from "vitest";
import { makeRoom, paidGate, PARTY_BINDINGS } from "./room";

function setup() {
  const stubFetch = vi.fn((_req: Request) => Promise.resolve(new Response("ok")));
  const namespaces = Object.fromEntries(
    Object.values(PARTY_BINDINGS).map((binding) => [binding, { getByName: vi.fn(() => ({ fetch: stubFetch })) }])
  );
  const env: Record<string, unknown> = { ...namespaces, YOUTUBE_API_KEY: "yt" };
  const storage = { get: vi.fn() };
  const server = { name: "ABCD", env, ctx: { storage }, broadcast: vi.fn() };
  return { room: makeRoom(server), server, namespaces, stubFetch, storage };
}

describe("makeRoom (PartyServer → party Room)", () => {
  // Value: protects=rooms reach the paid budget/cache and playlists reach the library on Cloudflare; fails_when=a stub gets a relative URL, the wrong binding or name, or loses headers/body (paid then fails open: no cap); why_new=party unit tests hand-build context.parties; seam=none; no_claim=workerd routing (fake namespaces)
  it("sends another party's calls to that binding by name, as an absolute URL with init intact", async () => {
    const { room, namespaces, stubFetch } = setup();
    await room.context.parties.paid.get("global").fetch("/budget", {
      method: "POST",
      headers: { "x-hitster-internal": "tok" },
      body: '{"a":1}',
    });
    expect(namespaces.Paid.getByName).toHaveBeenCalledWith("global");
    const req = stubFetch.mock.calls[0][0];
    expect(req.url).toBe("https://party/parties/paid/global/budget");
    expect(req.method).toBe("POST");
    expect(req.headers.get("x-hitster-internal")).toBe("tok");
    expect(await req.text()).toBe('{"a":1}');

    await room.context.parties.library.get("host-1").fetch("/", { method: "PUT", body: "{}" });
    expect(namespaces.Library.getByName).toHaveBeenCalledWith("host-1");
    expect(stubFetch.mock.calls[1][0].url).toBe("https://party/parties/library/host-1/");
  });

  // Value: protects=parties see their own name, env secrets and storage; fails_when=id/env/storage/broadcast is wired to the wrong field; why_new=new adapter; seam=none; no_claim=PartyServer's own broadcast
  it("exposes the server's name, env, storage and broadcast", () => {
    const { room, server, storage } = setup();
    expect(room.id).toBe("ABCD");
    expect(room.env.YOUTUBE_API_KEY).toBe("yt");
    expect(room.storage).toBe(storage);
    room.broadcast("hi", ["c1"]);
    expect(server.broadcast).toHaveBeenCalledWith("hi", ["c1"]);
  });
});

describe("paidGate (worker onBeforeRequest/onBeforeConnect)", () => {
  // Value: protects=nobody outside the server can spend the daily budget or write the AI cache; fails_when=the gate stops matching the Paid binding or starts blocking another party; why_new=the edge gate moved from PartyKit's static hooks to the worker, and an e2e HTTP 404 can't tell it from PaidParty's own token check; seam=none; no_claim=routePartykitRequest calling the hook (e2e/paid-gate.spec.ts WebSocket half)
  it("404s the paid party and lets every other party through", () => {
    const req = new Request("https://x/parties/paid/global/budget", { method: "POST" });
    expect((paidGate(req, { className: PARTY_BINDINGS.paid }) as Response).status).toBe(404);
    for (const className of [PARTY_BINDINGS.main, PARTY_BINDINGS.playlist, PARTY_BINDINGS.library]) {
      expect(paidGate(req, { className })).toBeUndefined();
    }
  });
});

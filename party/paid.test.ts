import { describe, it, expect, vi, afterEach } from "vitest";
import partykitConfig from "../partykit.json";
import PaidParty, { spendPaidBudget, sharedAICache, DEFAULT_DAILY_CAP } from "./paid";

type Env = Record<string, string>;

function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn((key: string | string[]) =>
      Promise.resolve(Array.isArray(key) ? new Map(key.filter((k) => store.has(k)).map((k) => [k, store.get(k)])) : store.get(key))),
    put: vi.fn((key: string | Record<string, unknown>, val?: unknown) => {
      if (typeof key === "string") store.set(key, val);
      else for (const [k, v] of Object.entries(key)) store.set(k, v);
      return Promise.resolve();
    }),
  };
}

/** The global paid party plus a caller room whose context.parties.paid routes to it, like PartyKit does. */
function setup(env: Env = { ANTHROPIC_API_KEY: "sk-test" }) {
  const paidStorage = makeStorage();
  const paid = new PaidParty({ id: "global", env, storage: paidStorage } as unknown as import("partykit/server").Room);
  const paidFetch = vi.fn((path: string, init: RequestInit) =>
    paid.onRequest(new Request(`http://localhost/parties/paid/global${path}`, init) as unknown as import("partykit/server").Request));
  const callerStorage = makeStorage();
  const caller = {
    id: "room-1",
    env,
    storage: callerStorage,
    context: { parties: { paid: { get: () => ({ fetch: paidFetch }) } } },
  } as unknown as import("partykit/server").Room;
  return { paid, paidStorage, paidFetch, caller, callerStorage };
}

const publicRequest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost/parties/paid/global${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }) as unknown as import("partykit/server").Request;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("paid party: daily budget", () => {
  // Value: protects=the server's Anthropic spend and YouTube quota (anyone on the internet can start a playlist resolve); fails_when=the cap stops counting, resets, or lets a call through after it is reached; why_new=nothing limited paid calls before; seam=none
  it("lets the cap's worth of paid pipelines through each day, then refuses", async () => {
    const { caller } = setup({ ANTHROPIC_API_KEY: "sk-test", PAID_DAILY_CAP: "3" });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await spendPaidBudget(caller));
    expect(results).toEqual([true, true, true, false, false]);
  });

  // Value: protects=an unset or garbled PAID_DAILY_CAP still caps at the default, and "0" really turns paid calls off; fails_when=the fallback is dropped (NaN means no cap) or 0 is read as "unset"; why_new=only "3" was tested; seam=none
  it.each([
    [undefined, DEFAULT_DAILY_CAP - 1, true],
    [undefined, DEFAULT_DAILY_CAP, false],
    ["not-a-number", DEFAULT_DAILY_CAP, false],
    ["0", 0, false],
  ])("PAID_DAILY_CAP=%s with %i used today allows: %s", async (cap, used, allowed) => {
    const { caller, paidStorage } = setup({ ANTHROPIC_API_KEY: "sk-test", ...(cap === undefined ? {} : { PAID_DAILY_CAP: cap }) });
    paidStorage.store.set(`budget:${new Date().toISOString().slice(0, 10)}`, used);
    expect(await spendPaidBudget(caller)).toBe(allowed);
  });

  // Value: protects=the cap resets at the next UTC day instead of locking the server out for good; fails_when=the budget key stops changing per UTC day; why_new=no test moved the clock; seam=none
  it("starts a fresh budget on the next UTC day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T23:59:00Z"));
    const { caller } = setup({ ANTHROPIC_API_KEY: "sk-test", PAID_DAILY_CAP: "1" });
    expect(await spendPaidBudget(caller)).toBe(true);
    expect(await spendPaidBudget(caller)).toBe(false);
    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));
    expect(await spendPaidBudget(caller)).toBe(true);
  });

  // Value: protects=the operator can tell a global lockout happened; fails_when=reaching the cap stops logging paid_budget_exhausted, or logs on every refused call; why_new=new log; seam=none
  it("logs once when the day's cap is reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { caller } = setup({ ANTHROPIC_API_KEY: "sk-test", PAID_DAILY_CAP: "2" });
    for (let i = 0; i < 4; i++) await spendPaidBudget(caller);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("paid_budget_exhausted"))).toHaveLength(1);
  });

  // Value: protects=a platform hiccup never blocks a real game night; fails_when=an unreachable budget party makes spendPaidBudget refuse; why_new=new failure path; seam=none
  it.each([
    ["throws", () => Promise.reject(new Error("down"))],
    ["answers 404 (token mismatch)", () => Promise.resolve(new Response("{}", { status: 404 }))],
    ["answers 500", () => Promise.resolve(new Response("{}", { status: 500 }))],
  ])("fails open when the budget party %s", async (_, answer) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { caller, paidFetch } = setup();
    paidFetch.mockImplementation(answer as never);
    expect(await spendPaidBudget(caller)).toBe(true);
  });

  it("fails open, without calling out, when the server has no API key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", ""); // resolveEnv falls back to process.env
    vi.stubEnv("YOUTUBE_API_KEY", "");
    const { caller, paidFetch } = setup({});
    expect(await spendPaidBudget(caller)).toBe(true);
    expect(paidFetch).not.toHaveBeenCalled();
  });

  // Value: protects=the room code can actually reach the paid party in a real deploy; fails_when=partykit.json drops or renames the "paid" party (every call then fails open: no cap); why_new=unit tests hand-build context.parties; seam=none
  it("is registered in partykit.json under the name the room code calls", () => {
    expect((partykitConfig as { parties: Record<string, string> }).parties.paid).toBe("party/paid.ts");
  });

  // Value: protects=a public caller can't spend the budget down (denial of service) or read/write the shared cache; fails_when=the paid party answers a request without the server-derived token; why_new=every PartyKit party is reachable over public HTTP; seam=none
  it("answers nothing without the server-derived token", async () => {
    const { paid, paidStorage } = setup();
    for (const path of ["/budget", "/cache/get", "/cache/put"]) {
      const res = await paid.onRequest(publicRequest(path, { keys: ["aiMeta:v1"], entries: { "aiMeta:v1": { year: 1 } } }));
      expect(res.status).toBe(404);
      const forged = await paid.onRequest(publicRequest(path, {}, { "x-hitster-internal": "guess" }));
      expect(forged.status).toBe(404);
    }
    expect(paidStorage.put).not.toHaveBeenCalled();
  });

  // Value: protects=untokened public traffic never reaches the single global Durable Object (so it can't be flooded into failing open); fails_when=onBeforeRequest lets an untokened request through, or onBeforeConnect accepts a socket; why_new=edge gate is new; seam=none
  it("turns untokened traffic away at the edge, before the Durable Object", async () => {
    const lobby = { env: { ANTHROPIC_API_KEY: "sk-test" } } as unknown as import("partykit/server").Lobby;
    expect(((await PaidParty.onBeforeRequest(publicRequest("/budget", {}), lobby)) as Response).status).toBe(404);
    expect((PaidParty.onBeforeConnect() as Response).status).toBe(404);
  });
});

describe("paid party: shared AI cache", () => {
  // Value: protects=a song's AI metadata is fetched once for every room and playlist (a fresh id no longer means a fresh paid call); fails_when=sharedAICache stops writing to or reading from the shared party; why_new=the cache used to be per room/playlist; seam=none
  it("a write from one room is a cache hit for another", async () => {
    const { caller, paidFetch } = setup();
    await sharedAICache(caller).put({ "aiMeta:v1": { title: "T", artist: "A", year: 1999 } });
    const other = { ...caller, id: "room-2", storage: makeStorage(), context: { parties: { paid: { get: () => ({ fetch: paidFetch }) } } } } as unknown as import("partykit/server").Room;
    const got = (await sharedAICache(other).get(["aiMeta:v1", "aiMeta:v2"])) as unknown as Map<string, unknown>;
    expect([...got]).toEqual([["aiMeta:v1", { title: "T", artist: "A", year: 1999 }]]);
  });

  // Value: protects=the shared party can't be used as general storage (only AI-metadata keys); fails_when=the cache accepts or returns keys outside aiMeta:/noResult:aiMeta:; why_new=new endpoint; seam=none
  it("only stores and returns AI-generated cache keys", async () => {
    const { caller, paidStorage } = setup();
    await sharedAICache(caller).put({
      "aiMeta:v1": 1, "noResult:aiMeta:v1:v2": 2, "lyrics:v1": 3, "lyrics-sonnet:v1": 4, "lyrics-popularity:v1": 5,
      "noResult:lyrics:v1:v1": 6, "noResult:lyrics-sonnet:v1:v1": 7, "budget:2099-01-01": 0, "screenId": "x",
    });
    expect([...paidStorage.store.keys()].sort()).toEqual([
      "aiMeta:v1", "lyrics-popularity:v1", "lyrics-sonnet:v1", "lyrics:v1",
      "noResult:aiMeta:v1:v2", "noResult:lyrics-sonnet:v1:v1", "noResult:lyrics:v1:v1",
    ].map((k) => `v1:${k}`));
  });

  // Value: protects=a playlist bigger than one storage call (128 keys) still reads and writes the shared cache; fails_when=PaidParty passes >128 keys straight to Durable Object storage; why_new=the server used to rely on every caller chunking; seam=none
  it("handles more keys than one storage call takes", async () => {
    const { caller } = setup();
    const entries = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`aiMeta:v${i}`, i]));
    await sharedAICache(caller).put(entries);
    const got = (await sharedAICache(caller).get(Object.keys(entries))) as unknown as Map<string, unknown>;
    expect(got.size).toBe(300);
  });

  // Value: protects=a prompt/model change or a bad answer can be purged by bumping one version, instead of living in every room forever; fails_when=shared entries are stored or served without the version prefix; why_new=shared entries never expire; seam=none
  it("stores entries under a cache version and ignores other versions", async () => {
    const { caller, paidStorage } = setup();
    paidStorage.store.set("aiMeta:old", { year: 1066 }); // unversioned (or an older version)
    await sharedAICache(caller).put({ "aiMeta:new": { year: 1999 } });
    expect([...paidStorage.store.keys()]).toContain("v1:aiMeta:new");
    const got = (await sharedAICache(caller).get(["aiMeta:old", "aiMeta:new"])) as unknown as Map<string, unknown>;
    expect([...got]).toEqual([["aiMeta:new", { year: 1999 }]]);
  });

  // Value: protects=a stalled paid party costs one timeout per pipeline, not one per cache call (about 7 on a Lyrics start); fails_when=sharedAICache keeps calling the paid party after a failure; why_new=pass-2 performance review; seam=none
  it("stops calling the shared party for the rest of a pipeline after one failure", async () => {
    const { caller, paidFetch } = setup();
    paidFetch.mockRejectedValue(new Error("down"));
    const cache = sharedAICache(caller);
    await cache.get(["aiMeta:a"]);
    const calls = paidFetch.mock.calls.length;
    await cache.get(["lyrics:a"]);
    await cache.put({ "lyrics:a": 1 });
    expect(paidFetch.mock.calls.length).toBe(calls);
  });

  it("falls back to the room's own storage when the shared party answers garbage", async () => {
    const { caller, callerStorage, paidFetch } = setup();
    callerStorage.store.set("aiMeta:v9", { year: 2001 });
    paidFetch.mockResolvedValue(new Response("not json", { status: 200 }));
    const got = (await sharedAICache(caller).get(["aiMeta:v9"])) as unknown as Map<string, unknown>;
    expect(got.get("aiMeta:v9")).toEqual({ year: 2001 });
  });

  it("falls back to the room's own storage when the shared party is unreachable", async () => {
    const { caller, callerStorage, paidFetch } = setup();
    paidFetch.mockRejectedValue(new Error("down"));
    await sharedAICache(caller).put({ "aiMeta:v9": { year: 2001 } });
    expect(callerStorage.store.get("aiMeta:v9")).toEqual({ year: 2001 });
    const got = (await sharedAICache(caller).get(["aiMeta:v9"])) as unknown as Map<string, unknown>;
    expect(got.get("aiMeta:v9")).toEqual({ year: 2001 });
  });
});

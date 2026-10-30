/**
 * HTTP edges of the worker adapter (party/server.ts): a party with no HTTP handler, or a path no
 * party owns, must still answer with a JSON 404, not an empty or broken response.
 */
import { test, expect } from "@playwright/test";

const PARTYKIT_HOST = process.env.NEXT_PUBLIC_PARTYKIT_HOST ?? "localhost:1999";

test.describe("worker HTTP 404s", () => {
  // Value: protects=HTTP to the game room or an unknown path is a clean 404; fails_when=the `?? err(404)` fallbacks in party/server.ts go (workerd then errors on an undefined Response); why_new=only playlist/paid HTTP was tested; seam=none; no_claim=none beyond protects
  test("the game room and unknown paths 404", async ({ request }) => {
    for (const path of [`/parties/main/ZZ${Date.now() % 10000}`, "/nothing-here"]) {
      const res = await request.get(`http://${PARTYKIT_HOST}${path}`);
      expect(res.status(), path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "Not found" });
    }
  });
});

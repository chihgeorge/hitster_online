// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { lookupYearFromYTMusic } from "./ytmusic";

// These tests make real YTM network calls — run sequentially to avoid rate-limiting.
// Run with: npm test lib/ytmusic.test.ts

describe("lookupYearFromYTMusic", { sequential: true }, () => {
  beforeEach(async () => {
    // Space requests out to avoid YTM rate-limiting during test runs.
    await new Promise((r) => setTimeout(r, 1000));
  });

  it('"體面" by 于文文 — returns 2017', async () => {
    const year = await lookupYearFromYTMusic("于文文", "體面");
    expect(year).toBe(2017);
  }, 15_000);

  it('"光年之外" by G.E.M. — returns 2016', async () => {
    const year = await lookupYearFromYTMusic("G.E.M.", "光年之外");
    expect(year).toBe(2016);
  }, 15_000);

  it('"Blinding Lights" by The Weeknd — returns 2019 or 2020', async () => {
    const year = await lookupYearFromYTMusic("The Weeknd", "Blinding Lights");
    expect(year).not.toBeNull();
    expect(year!).toBeGreaterThanOrEqual(2019);
    expect(year!).toBeLessThanOrEqual(2021);
  }, 15_000);

  it("nonsense query — returns null (confidence guard rejects fuzzy match)", async () => {
    // YTM always returns a "closest match" even for gibberish queries.
    // The confidence guard (isConfidentMatch) must reject it and return null.
    const year = await lookupYearFromYTMusic(
      "xyzyzyzyzyznotanartist",
      "xyzyznotatrack99999"
    );
    expect(year).toBeNull();
  }, 15_000);
});

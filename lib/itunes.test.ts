/**
 * Integration tests for the iTunes Search year lookup.
 * No API key required — runs against the real iTunes Search API.
 *
 * Run: npx vitest run lib/itunes.test.ts
 */

import { describe, it, expect } from "vitest";
import { lookupYearFromItunes } from "./itunes";

describe("lookupYearFromItunes — real API", () => {
  const cases: [string, string, number][] = [
    // [artist, track, expected year]
    ["GEM",             "Light Years Away", 2016],
    ["Taylor Swift",    "Shake It Off",     2014],
    ["Adele",           "Hello",            2015],
    ["Michael Jackson", "Thriller",         1982],
    ["Jay Chou",        "七里香",           2004],
  ];

  for (const [artist, track, expectedYear] of cases) {
    it(`"${track}" by ${artist} → ${expectedYear}`, async () => {
      const year = await lookupYearFromItunes(artist, track);
      expect(year).toBe(expectedYear);
    }, 10_000);
  }

  // 五月天 "知足" — iTunes catalog date varies (another "Mayday" group has 2000 entries);
  // true release is 2003. Accept any year in range — Google Search provides better accuracy.
  it('"知足" by Mayday — iTunes catalog date (range)', async () => {
    const year = await lookupYearFromItunes("Mayday", "知足");
    expect(year).toBeGreaterThanOrEqual(2000);
    expect(year).toBeLessThanOrEqual(2006);
  }, 10_000);
});

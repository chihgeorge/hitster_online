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
    ["Michael Jackson", "Thriller",         1982],
    ["Jay Chou",        "七里香",           2004],
  ];

  for (const [artist, track, expectedYear] of cases) {
    it(`"${track}" by ${artist} → ${expectedYear}`, async () => {
      const result = await lookupYearFromItunes(artist, track);
      expect(result?.year).toBe(expectedYear);
    }, 10_000);
  }

  // "Hello" by Adele — iTunes catalog date varies; 2015 single release but some catalog entries show 2011
  it('"Hello" by Adele — iTunes catalog date (range)', async () => {
    const result = await lookupYearFromItunes("Adele", "Hello");
    expect(result?.year).toBeGreaterThanOrEqual(2011);
    expect(result?.year).toBeLessThanOrEqual(2015);
  }, 10_000);

  // 五月天 "知足" — iTunes catalog date varies (another "Mayday" group has 2000 entries);
  // true release is 2003. Accept any year in range — Google Search provides better accuracy.
  it('"知足" by Mayday — iTunes catalog date (range)', async () => {
    const result = await lookupYearFromItunes("Mayday", "知足");
    expect(result?.year).toBeGreaterThanOrEqual(2000);
    expect(result?.year).toBeLessThanOrEqual(2006);
  }, 10_000);

  // C-pop songs that may only exist in the Taiwan store (country=TW fallback).
  // These returned null from the US store alone (wrong songs with the same title).
  // iTunes regional catalog dates vary — we check a range rather than an exact year.
  it('"體面" by 于文文 — Taiwan store fallback resolves a year', async () => {
    const result = await lookupYearFromItunes("于文文", "體面");
    expect(result).not.toBeNull();
    // Original release 2017; TW store may show a later re-release edition
    expect(result!.year).toBeGreaterThanOrEqual(2017);
    expect(result!.year).toBeLessThanOrEqual(2023);
  }, 15_000);

  it('"光年之外" by G.E.M. — CJK track + known artist via TW store', async () => {
    const result = await lookupYearFromItunes("G.E.M.", "光年之外");
    expect(result).not.toBeNull();
    expect(result!.year).toBeGreaterThanOrEqual(2016);
    expect(result!.year).toBeLessThanOrEqual(2020);
  }, 15_000);
});

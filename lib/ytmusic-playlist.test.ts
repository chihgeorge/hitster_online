// @vitest-environment node

/**
 * Integration tests that verify YTM year lookup for real songs from the C-pop playlist:
 * https://www.youtube.com/playlist?list=PLA9x9-eADvOq0BC1xUWADX4JmQ2c3dcFm
 *
 * Makes real YTM network calls — run sequentially with a delay to avoid rate-limiting.
 * Run with: npm test lib/ytmusic-playlist.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { lookupYearFromYTMusic } from "./ytmusic";

describe("C-pop playlist — YTM year lookup", { sequential: true }, () => {
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 1000));
  });

  it('"小幸運" by 田馥甄 Hebe Tien — returns 2015', async () => {
    const year = await lookupYearFromYTMusic("田馥甄", "小幸運");
    expect(year).toBe(2015);
  }, 15_000);

  it('"體面" by 于文文 — returns 2017', async () => {
    const year = await lookupYearFromYTMusic("于文文", "體面");
    expect(year).toBe(2017);
  }, 15_000);

  it('"告白氣球" by 周杰倫 Jay Chou — returns 2016', async () => {
    const year = await lookupYearFromYTMusic("周杰倫", "告白氣球");
    expect(year).toBe(2016);
  }, 15_000);

  it('"光年之外" by G.E.M. 鄧紫棋 — returns 2016', async () => {
    const year = await lookupYearFromYTMusic("G.E.M.", "光年之外");
    expect(year).toBe(2016);
  }, 15_000);

  it('"可惜沒如果" by 林俊傑 JJ Lin — returns 2014', async () => {
    const year = await lookupYearFromYTMusic("JJ Lin", "可惜沒如果");
    expect(year).toBe(2014);
  }, 15_000);

  it('"你，好不好？" by 周興哲 Eric Chou — returns 2016', async () => {
    const year = await lookupYearFromYTMusic("周興哲", "你，好不好？");
    expect(year).toBe(2016);
  }, 15_000);

  it('"年少有為" by 李榮浩 Ronghao Li — returns 2018', async () => {
    // YTM returns 2018 (album "耳朵" release year)
    const year = await lookupYearFromYTMusic("李榮浩", "年少有為");
    expect(year).toBe(2018);
  }, 15_000);

  it('"那些年" by 胡夏 — returns 2012', async () => {
    // YTM returns 2012 (single/album release on streaming platforms)
    const year = await lookupYearFromYTMusic("胡夏", "那些年");
    expect(year).toBe(2012);
  }, 15_000);
});

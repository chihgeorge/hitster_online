import { describe, it, expect } from "vitest";
import {
  parseArtistAndTrack,
  parseYouTubeMusicDescription,
  channelToArtist,
  extractYearFromTitle,
} from "./youtube";

// ─── parseArtistAndTrack ──────────────────────────────────────────────────────

describe("parseArtistAndTrack", () => {
  it("parses 'Artist - Track' with hyphen", () => {
    const result = parseArtistAndTrack("Frank Mills - Music Box Dancer");
    expect(result).toEqual({ artist: "Frank Mills", track: "Music Box Dancer" });
  });

  it("parses with en-dash separator", () => {
    const result = parseArtistAndTrack("ABBA – Dancing Queen");
    expect(result?.artist).toBe("ABBA");
    expect(result?.track).toBe("Dancing Queen");
  });

  it("parses with em-dash separator", () => {
    const result = parseArtistAndTrack("The Beatles — Hey Jude");
    expect(result?.artist).toBe("The Beatles");
    expect(result?.track).toBe("Hey Jude");
  });

  it("returns null when no separator is present", () => {
    expect(parseArtistAndTrack("Just A Title")).toBeNull();
  });

  it("strips '(Official Video)' suffix from track", () => {
    const result = parseArtistAndTrack("Artist - Track (Official Video)");
    expect(result?.track).toBe("Track");
  });

  it("strips '[Lyrics]' suffix from track", () => {
    const result = parseArtistAndTrack("Artist - Track [Lyrics]");
    expect(result?.track).toBe("Track");
  });

  it("strips '(Official Audio)' suffix from track", () => {
    const result = parseArtistAndTrack("Artist - Track (Official Audio)");
    expect(result?.track).toBe("Track");
  });

  it("strips trailing year like '(1980)' before splitting", () => {
    const result = parseArtistAndTrack("Frank Mills - Music Box Dancer (1980)");
    expect(result?.artist).toBe("Frank Mills");
    expect(result?.track).toBe("Music Box Dancer");
  });

  it("strips trailing year in brackets '[1980]' before splitting", () => {
    const result = parseArtistAndTrack("Frank Mills - Music Box Dancer [1980]");
    expect(result?.artist).toBe("Frank Mills");
    expect(result?.track).toBe("Music Box Dancer");
  });

  it("handles extra whitespace around separator", () => {
    const result = parseArtistAndTrack("  Artist  -  Track  ");
    expect(result?.artist).toBe("Artist");
    expect(result?.track).toBe("Track");
  });
});

// ─── parseYouTubeMusicDescription ────────────────────────────────────────────

describe("parseYouTubeMusicDescription", () => {
  it("extracts year from 'Released on:' line", () => {
    const desc = "Provided to YouTube by Label\nReleased on: 1980-01-01\nArtist: Frank Mills";
    expect(parseYouTubeMusicDescription(desc).year).toBe(1980);
  });

  it("extracts year from copyright symbol '℗ 1980'", () => {
    const desc = "Some Song\n℗ 1980 SomeLabel";
    expect(parseYouTubeMusicDescription(desc).year).toBe(1980);
  });

  it("prefers 'Released on:' year over '℗' year", () => {
    const desc = "Released on: 1980-01-01\n℗ 1975 OldLabel";
    expect(parseYouTubeMusicDescription(desc).year).toBe(1980);
  });

  it("extracts artist from 'Artist:' line", () => {
    const desc = "Released on: 1980-01-01\nArtist: Frank Mills";
    expect(parseYouTubeMusicDescription(desc).artist).toBe("Frank Mills");
  });

  it("extracts artist from '· Artist' dot-separated format", () => {
    const desc = "Music Box Dancer · Frank Mills\nSome Album";
    expect(parseYouTubeMusicDescription(desc).artist).toBe("Frank Mills");
  });

  it("prefers 'Artist:' line over dot format", () => {
    const desc = "Song · OtherArtist\nArtist: Frank Mills";
    expect(parseYouTubeMusicDescription(desc).artist).toBe("Frank Mills");
  });

  it("returns empty object for empty description", () => {
    expect(parseYouTubeMusicDescription("")).toEqual({});
  });

  it("returns empty object when no year or artist found", () => {
    expect(parseYouTubeMusicDescription("Just some random text.")).toEqual({});
  });

  it("handles description with only year", () => {
    const result = parseYouTubeMusicDescription("Released on: 2001-05-15");
    expect(result.year).toBe(2001);
    expect(result.artist).toBeUndefined();
  });
});

// ─── channelToArtist ─────────────────────────────────────────────────────────

describe("channelToArtist", () => {
  it("strips ' - Topic' suffix", () => {
    expect(channelToArtist("Frank Mills - Topic")).toBe("Frank Mills");
  });

  it("passes through channel names without ' - Topic'", () => {
    expect(channelToArtist("Frank Mills")).toBe("Frank Mills");
  });

  it("strips ' - Topic' case-insensitively", () => {
    expect(channelToArtist("ABBA - TOPIC")).toBe("ABBA");
  });

  it("handles trailing whitespace around '- Topic'", () => {
    expect(channelToArtist("Frank Mills  -  Topic  ")).toBe("Frank Mills");
  });

  it("does not strip '- Topic' in the middle of a name", () => {
    expect(channelToArtist("Songs - Topic Mix")).toBe("Songs - Topic Mix");
  });
});

// ─── extractYearFromTitle ─────────────────────────────────────────────────────

describe("extractYearFromTitle", () => {
  it("extracts year in parentheses '(1980)'", () => {
    expect(extractYearFromTitle("Song Name (1980)")).toBe(1980);
  });

  it("extracts year in brackets '[1980]'", () => {
    expect(extractYearFromTitle("Song Name [1980]")).toBe(1980);
  });

  it("extracts trailing bare year", () => {
    expect(extractYearFromTitle("Song Name - Artist 1980")).toBe(1980);
  });

  it("prefers bracketed year over trailing year", () => {
    expect(extractYearFromTitle("Song (1980) 2020")).toBe(1980);
  });

  it("returns null when no year found", () => {
    expect(extractYearFromTitle("Just A Song Name")).toBeNull();
  });

  it("returns null for year before 1900", () => {
    expect(extractYearFromTitle("Old Song (1850)")).toBeNull();
  });

  it("returns null for year far in the future", () => {
    expect(extractYearFromTitle("Future Song (2100)")).toBeNull();
  });

  it("handles year 2000 (20xx prefix)", () => {
    expect(extractYearFromTitle("Song (2000)")).toBe(2000);
  });

  it("handles year 1999 (19xx prefix)", () => {
    expect(extractYearFromTitle("Song (1999)")).toBe(1999);
  });
});

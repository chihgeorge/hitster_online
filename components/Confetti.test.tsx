import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Confetti from "./Confetti";

describe("Confetti", () => {
  it("renders the requested number of pieces", () => {
    const { container } = render(<Confetti count={12} />);
    expect(container.querySelectorAll(".animate-confetti")).toHaveLength(12);
  });

  // Value: protects=winner screen (which renders <Confetti /> with no count) shows its full 40-piece burst; fails_when=the default count prop changes or is dropped; why_new=old assertion only checked >0, so a default of 1 or 5 would pass; seam=none
  it("defaults to 40 pieces", () => {
    const { container } = render(<Confetti />);
    expect(container.querySelectorAll(".animate-confetti")).toHaveLength(40);
  });

  // Value: protects=a lone piece (count=1, one column slot spanning the full width) still lands on-screen; fails_when=column-slot math mis-scales for a single slot (e.g. divides by count-1, giving NaN/Infinity); why_new=count=1 was only setup for the aria test, the bounds test only covers count=40; seam=none
  it("keeps a single piece inside the screen", () => {
    const el = render(<Confetti count={1} />).container.querySelector<HTMLElement>(".animate-confetti")!;
    const left = parseFloat(el.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(100);
  });

  it("is decorative — hidden from assistive tech", () => {
    const { container } = render(<Confetti count={1} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });

  // Value: protects=confetti pieces stay on-screen and don't reshuffle between mounts/renders (winner screen); fails_when=left leaves its column slot (off-screen or clumped) or generation goes back to Math.random/impure render; why_new=existing tests only count pieces and check aria-hidden; seam=none
  it("keeps every piece inside the screen and renders identically each time", () => {
    const lefts = (count: number) =>
      Array.from(render(<Confetti count={count} />).container.querySelectorAll<HTMLElement>(".animate-confetti"), (el) =>
        parseFloat(el.style.left)
      );
    const a = lefts(40);
    a.forEach((l, i) => expect(Math.floor((l * 40) / 100)).toBe(i)); // one piece per column slot: on-screen and no clumps
    expect(lefts(40)).toEqual(a);
  });

  // Value: protects=piece size and fall timing stay within the designed look (6-14px, 2.5-5s falls, starts staggered over 0-3s) and are stable across mounts; fails_when=a size/duration/delay goes out of range (invisible, huge, frozen or never-starting pieces) or those fields revert to Math.random; why_new=the bounds test only checks left position, nothing covers size/timing; seam=none
  it("keeps piece size and timing within the designed ranges, identically each mount", () => {
    const styles = () =>
      Array.from(render(<Confetti count={40} />).container.querySelectorAll<HTMLElement>(".animate-confetti"), (el) => ({
        size: parseFloat(el.style.width),
        duration: parseFloat(el.style.animationDuration),
        delay: parseFloat(el.style.animationDelay),
      }));
    const a = styles();
    for (const { size, duration, delay } of a) {
      expect(size).toBeGreaterThanOrEqual(6);
      expect(size).toBeLessThanOrEqual(14);
      expect(duration).toBeGreaterThanOrEqual(2.5);
      expect(duration).toBeLessThanOrEqual(5);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(3);
    }
    expect(styles()).toEqual(a);
  });
});

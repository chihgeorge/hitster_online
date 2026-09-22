import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Confetti from "./Confetti";

describe("Confetti", () => {
  it("renders the requested number of pieces", () => {
    const { container } = render(<Confetti count={12} />);
    expect(container.querySelectorAll(".animate-confetti")).toHaveLength(12);
  });

  it("defaults to a non-zero piece count", () => {
    const { container } = render(<Confetti />);
    expect(container.querySelectorAll(".animate-confetti").length).toBeGreaterThan(0);
  });

  it("is decorative — hidden from assistive tech", () => {
    const { container } = render(<Confetti count={1} />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

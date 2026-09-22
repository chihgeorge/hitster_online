import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceSpy }),
}));

import ScreenLandingPage from "@/app/screen/page";

beforeEach(() => replaceSpy.mockClear());
afterEach(() => cleanup());

describe("ScreenLandingPage (/screen)", () => {
  it("generates a room and redirects to its screen view, marked as the creator", () => {
    render(<ScreenLandingPage />);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const dest = replaceSpy.mock.calls[0][0] as string;
    expect(dest).toMatch(/^\/room\/[A-Z]{4}\/screen\?created=1$/);
  });
});

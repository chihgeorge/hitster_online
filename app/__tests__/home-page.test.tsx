import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// Regression coverage for /plan-eng-review "restore explicit Create a Room" (the site is public,
// so nothing should create a room just from a page load — see app/page.tsx's handleCreateRoom):
// the homepage keeps its Create-a-Room button alongside ?code= auto-fill from the player-join QR.
const pushSpy = vi.fn();
let searchParamsValue = new URLSearchParams("");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy }),
  useSearchParams: () => searchParamsValue,
}));

import HomePage from "@/app/page";

beforeEach(() => {
  pushSpy.mockClear();
  searchParamsValue = new URLSearchParams("");
});
afterEach(() => cleanup());

describe("HomePage", () => {
  it("creates a room and navigates to its screen lobby, marked as the creator", () => {
    render(<HomePage />);
    fireEvent.click(screen.getByText(/Create a Room/));
    expect(pushSpy).toHaveBeenCalledTimes(1);
    const dest = pushSpy.mock.calls[0][0] as string;
    expect(dest).toMatch(/^\/room\/[A-Z]{4}\/screen\?created=1$/);
  });

  it("shows the manual room-code field when no ?code= is present", () => {
    render(<HomePage />);
    expect(screen.getByPlaceholderText("房間代碼")).toBeTruthy();
  });

  it("auto-fills and hides the code field when ?code= is present, joining with it", () => {
    searchParamsValue = new URLSearchParams("code=WXYZ");
    render(<HomePage />);
    expect(screen.queryByPlaceholderText("房間代碼")).toBeNull();
    expect(screen.getByText("WXYZ")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("你的名字"), { target: { value: "Alice" } });
    fireEvent.click(screen.getByText("加入 →"));
    expect(pushSpy).toHaveBeenCalledWith("/room/WXYZ/play?name=Alice");
  });

  it("falls back to manual entry when the code field is toggled back open", () => {
    searchParamsValue = new URLSearchParams("code=WXYZ");
    render(<HomePage />);
    fireEvent.click(screen.getByTestId("change-code-btn"));
    expect(screen.getByPlaceholderText("房間代碼")).toBeTruthy();
  });

  it("ignores a malformed ?code= (not 4 chars) and keeps the manual field", () => {
    searchParamsValue = new URLSearchParams("code=TOOLONG");
    render(<HomePage />);
    expect(screen.getByPlaceholderText("房間代碼")).toBeTruthy();
  });
});

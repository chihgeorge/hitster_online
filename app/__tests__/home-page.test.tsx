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

// Cross-device host handoff (docs/designs, /plan-eng-review 2026-09-22): a "manage this room"
// link so the host can continue setup from a second device (e.g. their phone) once /screen is
// projected and left untouched. Guarded by a confirm — the claim it leads to is permanent and
// silent (see outside-voice's finding on the missing re-claim path).
describe("HomePage: manage-as-host link", () => {
  it("shows no link with no code entered", () => {
    render(<HomePage />);
    expect(screen.queryByTestId("manage-as-host-link")).toBeNull();
  });

  it("shows no link with a partial (not-yet-4-char) code", () => {
    render(<HomePage />);
    fireEvent.change(screen.getByPlaceholderText("房間代碼"), { target: { value: "AB" } });
    expect(screen.queryByTestId("manage-as-host-link")).toBeNull();
  });

  it("shows the link once a 4-char code is present, typed manually", () => {
    render(<HomePage />);
    fireEvent.change(screen.getByPlaceholderText("房間代碼"), { target: { value: "wxyz" } });
    expect(screen.getByTestId("manage-as-host-link")).toBeTruthy();
  });

  it("shows the link when the code arrived via ?code= (the same QR everyone scans)", () => {
    searchParamsValue = new URLSearchParams("code=WXYZ");
    render(<HomePage />);
    expect(screen.getByTestId("manage-as-host-link")).toBeTruthy();
  });

  it("navigates to /host only if the confirm is accepted", () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal("confirm", confirmMock);
    render(<HomePage />);
    fireEvent.change(screen.getByPlaceholderText("房間代碼"), { target: { value: "wxyz" } });
    fireEvent.click(screen.getByTestId("manage-as-host-link"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith("/room/WXYZ/host");
    vi.unstubAllGlobals();
  });

  it("does not navigate if the confirm is cancelled", () => {
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmMock);
    render(<HomePage />);
    fireEvent.change(screen.getByPlaceholderText("房間代碼"), { target: { value: "wxyz" } });
    fireEvent.click(screen.getByTestId("manage-as-host-link"));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

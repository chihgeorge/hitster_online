import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import QRCode from "qrcode";
import { Qr } from "./Qr";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Qr", () => {
  it("never shows the previous text's code while the new one is drawing", async () => {
    const { rerender } = render(<Qr text="https://a.test/one" alt="qr" />);
    await waitFor(() => screen.getByAltText("qr"));
    vi.spyOn(QRCode, "toDataURL").mockReturnValue(new Promise(() => {}) as never); // never resolves
    rerender(<Qr text="https://a.test/two" alt="qr" />);
    expect(screen.queryByAltText("qr")).toBeNull();
  });

  it("keeps the blank box when the text can't be encoded", async () => {
    vi.spyOn(QRCode, "toDataURL").mockRejectedValue(new Error("too big") as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<Qr text={"x".repeat(5000)} size={64} alt="qr" />);
    await waitFor(() => expect(warn).toHaveBeenCalled()); // failure is logged, not silent
    expect(screen.queryByAltText("qr")).toBeNull();
    expect(container.querySelector("div")?.getAttribute("style")).toContain("64px");
  });

  it("draws nothing for empty text", () => {
    const spy = vi.spyOn(QRCode, "toDataURL");
    render(<Qr text="" alt="qr" />);
    expect(spy).not.toHaveBeenCalled();
  });
});

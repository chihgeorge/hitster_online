import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { Standings, TvScoreRow, TvFinal, WonOnTimeNote } from "./TimedRound";

afterEach(cleanup);

const players = {
  a: { name: "Alice", score: 10, connected: true, timeMs: 9_000 },
  b: { name: "Bob", score: 30, connected: true, timeMs: 1_000 },
  c: { name: "Cara", score: 10, connected: true, timeMs: 4_000 },
};

describe("shared timed-round UI", () => {
  it("Standings ranks with the tie-break and highlights this player", () => {
    render(<Standings players={players} highlight="a" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((r) => within(r).getAllByText(/./)[1].textContent)).toEqual(["Bob", "Cara", "Alice"]);
    expect(rows[2].style.background).toBe("var(--surface2)");
  });

  it("TvScoreRow lists players best first", () => {
    const { container } = render(<TvScoreRow players={players} />);
    expect(container.textContent).toBe("Bob: 30Cara: 10Alice: 10");
  });

  it("TvFinal names the winner and only notes time when the top two tie", () => {
    const { unmount } = render(<TvFinal players={players} title="Over" />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Bob");
    expect(screen.queryByTestId("won-on-time")).toBeNull();
    unmount();
    render(<TvFinal players={{ ...players, b: { ...players.b, score: 10 } }} title="Over" />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Bob");
    expect(screen.getByTestId("won-on-time")).toBeTruthy();
  });

  it("WonOnTimeNote renders nothing without a tie", () => {
    const { container } = render(<WonOnTimeNote players={players} />);
    expect(container.textContent).toBe("");
  });
});

describe("TV lists fit the 960×540 Stage", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { name: `P${i}`, score: n - i, connected: true }]));
  it("TvFinal uses one column up to 4 players and two columns above that", () => {
    const { unmount } = render(<TvFinal players={many(4)} title="Over" />);
    expect(screen.getByTestId("tv-final-list").style.display).toBe("flex");
    unmount();
    render(<TvFinal players={many(8)} title="Over" />);
    const list = screen.getByTestId("tv-final-list");
    expect(list.style.display).toBe("grid");
    expect(list.children).toHaveLength(8);
  });
});

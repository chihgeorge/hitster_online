import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Timeline from "./Timeline";
import type { Card } from "@/lib/game";

const card = (id: string, year: number): Card => ({ id, videoId: id, title: `t${id}`, artist: `a${id}`, year });

const baseProps = {
  currentSong: null,
  isMyTurn: true,
  activePlayerName: null,
  onSelectPosition: () => {},
  onPlace: () => {},
  tooLate: false,
};

describe("Timeline: guess marker", () => {
  it("shows a '?' at the placed position once the player has placed, instead of the picker", () => {
    render(
      <Timeline
        {...baseProps}
        timeline={[card("a", 1990), card("b", 2000)]}
        phase="guessing"
        selectedPosition={1}
        hasPlaced
      />
    );
    expect(screen.getByTestId("guess-marker")).toBeTruthy();
    // Placing hides the interactive picker (canPlace is false once hasPlaced).
    expect(screen.queryByText("確認放置 →")).toBeNull();
  });

  it("marks position 0 (before the first card) correctly", () => {
    render(
      <Timeline
        {...baseProps}
        timeline={[card("a", 1990)]}
        phase="guessing"
        selectedPosition={0}
        hasPlaced
      />
    );
    expect(screen.getByTestId("guess-marker")).toBeTruthy();
  });

  it("shows no marker before placing", () => {
    render(
      <Timeline
        {...baseProps}
        timeline={[card("a", 1990)]}
        phase="guessing"
        selectedPosition={null}
        hasPlaced={false}
      />
    );
    expect(screen.queryByTestId("guess-marker")).toBeNull();
  });

  it("clears the marker once reveal starts (phase leaves guessing)", () => {
    render(
      <Timeline
        {...baseProps}
        timeline={[card("a", 1990)]}
        phase="reveal"
        selectedPosition={1}
        hasPlaced
      />
    );
    expect(screen.queryByTestId("guess-marker")).toBeNull();
  });
});

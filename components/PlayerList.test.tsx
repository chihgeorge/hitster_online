import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PlayerList from "./PlayerList";
import type { Card, Player } from "@/lib/game";

const card = (id: string, year: number): Card => ({ id, videoId: id, title: `t${id}`, artist: `a${id}`, year });
const player = (name: string, timeline: Card[]): Player => ({ name, cardCount: timeline.length, timeline, connected: true });

describe("PlayerList: guess marker", () => {
  it("shows a '?' in the guessing player's timeline row at the placed position", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", [card("a", 1990), card("b", 2000)]) }}
        placements={{ p1: 1 }}
        targetCardCount={10}
        activePlayerId="p1"
        phase="guessing"
      />
    );
    expect(screen.getByTestId("mini-guess-marker")).toBeTruthy();
  });

  it("shows no marker for a player who hasn't placed yet", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", [card("a", 1990)]), p2: player("Bob", [card("c", 1985)]) }}
        placements={{ p1: 0 }}
        targetCardCount={10}
        activePlayerId="p1"
        phase="guessing"
      />
    );
    // Only Alice (the active guesser) gets a marker — Bob isn't guessing.
    expect(screen.getAllByTestId("mini-guess-marker")).toHaveLength(1);
  });

  it("shows no marker outside the guessing phase", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", [card("a", 1990)]) }}
        placements={{ p1: 0 }}
        targetCardCount={10}
        activePlayerId="p1"
        phase="reveal"
      />
    );
    expect(screen.queryByTestId("mini-guess-marker")).toBeNull();
  });
});

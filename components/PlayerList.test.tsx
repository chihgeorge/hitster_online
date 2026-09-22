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

  it("shows the marker at the end of the timeline (placed after the last card)", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", [card("a", 1990), card("b", 2000)]) }}
        placements={{ p1: 2 }}
        targetCardCount={10}
        activePlayerId="p1"
        phase="guessing"
      />
    );
    expect(screen.getByTestId("mini-guess-marker")).toBeTruthy();
  });

  // Coverage/correctness gap found by /ship's audit: a player with an EMPTY timeline (their very
  // first-ever placement — e.g. joining mid-game) took the skeleton-placeholder branch, which never
  // rendered a marker even though they'd validly placed at position 0. Real bug, not just untested.
  it("shows the marker for a player's first-ever placement, even with an empty timeline", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", []) }}
        placements={{ p1: 0 }}
        targetCardCount={10}
        activePlayerId="p1"
        phase="guessing"
      />
    );
    expect(screen.getByTestId("mini-guess-marker")).toBeTruthy();
  });

  it("shows the empty-timeline skeleton placeholder (not a marker) for a player who hasn't placed", () => {
    render(
      <PlayerList
        players={{ p1: player("Alice", []) }}
        placements={{}}
        targetCardCount={10}
        activePlayerId="p1"
        phase="guessing"
      />
    );
    expect(screen.queryByTestId("mini-guess-marker")).toBeNull();
  });
});

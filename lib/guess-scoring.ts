// Guess Mode compound scorer (docs/designs/guess-mode-song-artist.md, Scoring & Grading Rules):
// title and artist are graded independently, plus a bonus for getting both. Every part is
// speed-scaled from the one timestamp of the player's single submit.

import { computePoints, isCorrect } from "./fuzzy";

/** Max points per part, before speed scaling. Tune after playtesting (design Open Question 2). */
export const GUESS_POINTS = { title: 250, artist: 250, bonus: 100 } as const;

export interface GuessScore {
  titleCorrect: boolean;
  artistCorrect: boolean;
  titlePoints: number;
  artistPoints: number;
  bonusPoints: number;
  points: number; // sum of the three
}

/**
 * A blank field is simply wrong for that field (R1-3). With no artist metadata (`target.artist`
 * empty, R1-5) the round is title-only: the artist is never graded, so no bonus is possible.
 */
export function scoreGuess(
  guess: { title: string; artist: string; ts: number },
  target: { title: string; artist: string },
  roundStart: number,
  timerSeconds: number,
  fuzzyEnabled: boolean
): GuessScore {
  const grade = (answer: string, want: string) =>
    answer.trim() !== "" && want.trim() !== "" && isCorrect(answer, want, [], fuzzyEnabled);
  const titleCorrect = grade(guess.title, target.title);
  const artistCorrect = grade(guess.artist, target.artist);
  const scale = (max: number) => computePoints(roundStart, guess.ts, timerSeconds, max);
  const titlePoints = titleCorrect ? scale(GUESS_POINTS.title) : 0;
  const artistPoints = artistCorrect ? scale(GUESS_POINTS.artist) : 0;
  const bonusPoints = titleCorrect && artistCorrect ? scale(GUESS_POINTS.bonus) : 0;
  return { titleCorrect, artistCorrect, titlePoints, artistPoints, bonusPoints, points: titlePoints + artistPoints + bonusPoints };
}

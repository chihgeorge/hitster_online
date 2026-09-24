// Guess Mode compound scorer (docs/designs/guess-mode-song-artist.md, Scoring & Grading Rules):
// title and artist are graded independently, plus a bonus for getting both. Every part is
// speed-scaled from the one timestamp of the player's single submit.

import { distance as levenshtein } from "fastest-levenshtein";
import { computePoints, isCJKText } from "./fuzzy";

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

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/**
 * Guess-mode normalizer. Lyrics' isCorrect doesn't fit raw playlist metadata (review 2026-09-24):
 * titles arrive HTML-escaped (sometimes twice, via saved playlists) so "Don't" never matched,
 * non-Latin/non-CJK scripts normalized to "" and matched anything, and mixed "五月天 Mayday" kept
 * its case. Here: undo escaping, NFKC, lowercase, keep only letters/digits in any script.
 */
/** Undoes sanitizeText's HTML escaping, repeatedly (saved playlists can arrive escaped twice). */
export function decodeEntities(s: string): string {
  let t = s;
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(/&(amp|lt|gt|quot|#39);/g, (e) => HTML_ENTITIES[e]); }
  return t;
}

export function normGuess(s: string): string {
  return decodeEntities(s).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Exact match after normGuess; with fuzzy on, a small typo allowance — but only for targets long
 * enough that the allowance can't match unrelated short guesses ("a" vs "u2").
 */
export function guessMatches(answer: string, target: string, fuzzyEnabled: boolean): boolean {
  const a = normGuess(answer);
  const t = normGuess(target);
  if (!a || !t) return false;
  if (a === t) return true;
  if (!fuzzyEnabled) return false;
  const cjk = isCJKText(t);
  if (t.length <= (cjk ? 2 : 4)) return false;
  return levenshtein(a, t) <= (cjk ? 1 : 2);
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
  const titleCorrect = guessMatches(guess.title, target.title, fuzzyEnabled);
  const artistCorrect = guessMatches(guess.artist, target.artist, fuzzyEnabled);
  const scale = (max: number) => computePoints(roundStart, guess.ts, timerSeconds, max);
  const titlePoints = titleCorrect ? scale(GUESS_POINTS.title) : 0;
  const artistPoints = artistCorrect ? scale(GUESS_POINTS.artist) : 0;
  const bonusPoints = titleCorrect && artistCorrect ? scale(GUESS_POINTS.bonus) : 0;
  return { titleCorrect, artistCorrect, titlePoints, artistPoints, bonusPoints, points: titlePoints + artistPoints + bonusPoints };
}

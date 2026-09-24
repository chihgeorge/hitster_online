// Lyrics Mode answer matching: exact, variant, and optional fuzzy (Levenshtein).
// fuzzyEnabled is OFF by default — host opt-in only (寬鬆模式).

import { distance as levenshtein } from "fastest-levenshtein";
import { decodeEntities } from "./utils";

export function normCJK(s: string): string {
  return s.trim().replace(/[\s　]/g, "").replace(/[，。！？、…～「」『』【】〔〕]/g, "");
}

export function normLatin(s: string): string {
  return s.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

export function isCJKText(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

/**
 * Checks a player's free-text answer against a target string (+ acceptable variants),
 * with optional fuzzy (Levenshtein) matching. Generic over what's being matched — the
 * caller supplies the target/variants directly rather than a mode-specific round shape,
 * so this same function grades Lyrics mode's blankSentence and Guess mode's title/artist
 * guesses alike (docs/designs/guess-mode-song-artist.md, D-eng-2).
 */
export function isCorrect(
  playerAnswer: string,
  target: string,
  variants: string[],
  fuzzyEnabled: boolean
): boolean {
  const isCJK = isCJKText(target);
  // Answers are stored through sanitizeText (' → &#39;), targets usually aren't: decode both, or
  // normLatin turns "don&#39;t" into "don39t" and an exact apostrophe answer grades wrong.
  const norm = (s: string) => (isCJK ? normCJK : normLatin)(decodeEntities(s));

  const normTarget = norm(target);
  const answer = norm(playerAnswer);
  const normVariants = variants.map(norm);

  if (answer === normTarget || normVariants.includes(answer)) return true;
  if (!fuzzyEnabled) return false;

  const threshold = isCJK ? 1 : 2;
  // D5 fix: check fuzzy distance against target AND all variants
  return [normTarget, ...normVariants].some((v) => levenshtein(answer, v) <= threshold);
}

/**
 * Computes points for a correct answer.
 * Max ~`maxPoints` regardless of timer length (default 500, Lyrics mode's original ceiling).
 * Returns 0 if answer arrived after the deadline. `maxPoints` lets Guess mode's compound
 * scorer scale title/artist/bonus points independently (docs/designs/guess-mode-song-artist.md,
 * D-eng-2) while every existing caller keeps its exact prior behavior via the default.
 */
export function computePoints(
  roundStart: number,
  answerTs: number,
  timerSeconds: number,
  maxPoints = 500
): number {
  const secondsElapsed = Math.max(0, (answerTs - roundStart) / 1000);
  if (secondsElapsed > timerSeconds) return 0;
  const scalingFactor = Math.floor(maxPoints / timerSeconds);
  return Math.max(0, Math.round((timerSeconds - secondsElapsed) * scalingFactor));
}

// Lyrics Mode answer matching: exact, variant, and optional fuzzy (Levenshtein).
// fuzzyEnabled is OFF by default — host opt-in only (寬鬆模式).

import { levenshtein } from "fastest-levenshtein";
import type { LyricsRound, LyricsGameConfig } from "./game";

export function normCJK(s: string): string {
  return s.trim().replace(/[\s　]/g, "").replace(/[，。！？、…～「」『』【】〔〕]/g, "");
}

export function normLatin(s: string): string {
  return s.toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

export function isCJKText(s: string): boolean {
  return /[一-鿿぀-ヿ가-힯]/.test(s);
}

export function isCorrect(
  playerAnswer: string,
  round: LyricsRound,
  config: LyricsGameConfig
): boolean {
  const isCJK = isCJKText(round.blankSentence);
  const norm = isCJK ? normCJK : normLatin;

  const target = norm(round.blankSentence);
  const answer = norm(playerAnswer);
  const variants = round.acceptableVariants.map(norm);

  if (answer === target || variants.includes(answer)) return true;
  if (!config.fuzzyEnabled) return false;

  const threshold = isCJK ? 1 : 2;
  // D5 fix: check fuzzy distance against target AND all variants
  return [target, ...variants].some((v) => levenshtein(answer, v) <= threshold);
}

/**
 * Computes points for a correct answer.
 * Max ~500 points regardless of timer length.
 * Returns 0 if answer arrived after the deadline.
 */
export function computePoints(
  roundStart: number,
  answerTs: number,
  timerSeconds: number
): number {
  const secondsElapsed = Math.max(0, (answerTs - roundStart) / 1000);
  if (secondsElapsed > timerSeconds) return 0;
  const scalingFactor = Math.floor(500 / timerSeconds);
  return Math.max(0, Math.round((timerSeconds - secondsElapsed) * scalingFactor));
}

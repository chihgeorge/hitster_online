// Shared simultaneous-timed-round lifecycle (docs/designs/guess-mode-song-artist.md, Approach B):
// playing → guessing → results → playing … → ended. Lyrics mode is the first consumer; Guess mode
// plugs in the same way. The engine owns phase transitions, the answer deadline and score totals;
// it never looks inside a round or an answer — each mode supplies those through its type params
// and callbacks. Auth, error messages and broadcasting stay in the room (party/index.ts).

export type TimedRoundPhase = "lobby" | "loading" | "preview" | "playing" | "guessing" | "results" | "ended";

export interface TimedRoundState<R, A extends { ts: number }> {
  phase: TimedRoundPhase;
  players: Record<string, { name: string; score: number; connected: boolean }>;
  rounds: R[];
  currentRound: R | null;
  roundStart: number | null;
  timerSeconds: number;
  answers: Record<string, A>;
  totalRounds: number;
  currentRoundIndex: number;
  consecutiveSkips: number;
}

type State<R, A extends { ts: number }> = TimedRoundState<R, A>;

/** preview → playing on the deck's first round. False if not in preview. */
export function confirmPreview<R, A extends { ts: number }>(s: State<R, A>, deck: R[]): boolean {
  if (s.phase !== "preview") return false;
  s.phase = "playing";
  s.currentRound = deck[0] ?? null;
  s.answers = {};
  return true;
}

/** playing → guessing; starts the answer clock. False if not in playing. */
export function startRound<R, A extends { ts: number }>(s: State<R, A>, now: number): boolean {
  if (s.phase !== "playing") return false;
  s.phase = "guessing";
  s.roundStart = now;
  s.answers = {};
  return true;
}

/**
 * Records one player's answer, stamped with the server's `now`. "ignored" covers every silent
 * drop (wrong phase, unknown player, already answered); "too_late" is past timer + graceMs.
 */
export function acceptAnswer<R, A extends { ts: number }>(
  s: State<R, A>,
  playerId: string,
  now: number,
  graceMs: number,
  build: (ts: number) => A
): "ok" | "too_late" | "ignored" {
  if (s.phase !== "guessing" || !s.currentRound || s.roundStart === null) return "ignored";
  if (!s.players[playerId]) return "ignored";
  if (s.answers[playerId]) return "ignored";
  if (now > s.roundStart + s.timerSeconds * 1000 + graceMs) return "too_late";
  s.answers[playerId] = build(now);
  return "ok";
}

/**
 * guessing → results. `score` grades one answer against the round and returns the graded answer
 * (stored back, revealed to clients at results) plus the points added to that player's total.
 */
export function showResults<R, A extends { ts: number }>(
  s: State<R, A>,
  score: (round: R, answer: A, roundStart: number) => { answer: A; points: number }
): boolean {
  if (s.phase !== "guessing" || !s.currentRound || s.roundStart === null) return false;
  for (const [pid, ans] of Object.entries(s.answers)) {
    const { answer, points } = score(s.currentRound, ans, s.roundStart);
    s.answers[pid] = answer;
    if (points > 0 && s.players[pid]) s.players[pid].score += points;
  }
  s.phase = "results";
  s.consecutiveSkips = 0;
  return true;
}

/** results → next round's playing, or ended after the last round. False if not in results. */
export function nextRound<R, A extends { ts: number }>(s: State<R, A>, deck: R[]): boolean {
  if (s.phase !== "results") return false;
  s.currentRoundIndex += 1;
  if (s.currentRoundIndex >= deck.length) {
    s.phase = "ended";
    s.currentRound = null;
  } else {
    s.phase = "playing";
    s.currentRound = deck[s.currentRoundIndex];
    s.roundStart = null;
    s.answers = {};
  }
  return true;
}

/**
 * Answers as clients may see them. During guessing every answer goes through `redact` — a player
 * answering last must not read earlier answers off the wire. Keys stay, so "N / M answered" and a
 * client's own hasAnswered check still work. Every other phase returns answers unchanged.
 */
export function publicAnswers<R, A extends { ts: number }>(s: State<R, A>, redact: (a: A) => A): Record<string, A> {
  if (s.phase !== "guessing") return s.answers;
  return Object.fromEntries(Object.entries(s.answers).map(([pid, a]) => [pid, redact(a)]));
}

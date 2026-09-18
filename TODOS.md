# TODOS

## P1 — Pre-launch blockers

- [x] **P1** `WRONG_PHASE` vs `too_late` error key mismatch  
  Fixed: server now sends `{ type: "TOO_LATE" }` (matching client expectation). Test updated.

- [x] **P1** YouTube overlay blocks blurred thumbnail (potential ToS issue)  
  Fixed: overlay opacity reduced to `/90` (10% of blurred video shows through). ToS compliant.

## Pre-launch security

- [x] **CRITICAL** Rotate leaked API credentials  
  YouTube API key + Spotify client ID/secret were committed to git history. Credentials have been rotated.

- [x] **P2** Strip future song years from broadcast state (security/fairness)  
  Fixed: `sanitizedState()` zeros `year` on all `songs[]` cards and on `currentSong` during guessing phase. Applied to `broadcastState()`, `onConnect()`, and `handleRejoin()`.

- [x] **P2** hostId first-write-wins is vulnerable to takeover  
  Fixed: `hostConnId` records the first WebSocket connection via `onConnect`. The first host claim is rejected if it comes from a different connection.

- [x] **P2** Validate `playerId` format to prevent prototype-pollution-adjacent keys  
  Fixed: UUID regex guard on `handleJoin`, `handleRejoin`, `handlePlace`. Non-UUID playerIds are silently dropped.

- [x] **P2** Concurrent `LOAD_PLAYLIST` causes non-deterministic `pendingPlaylist` state  
  Fixed: `loadSeq` counter; each load captures its generation, and async checkpoints discard superseded loads silently.

## Pre-launch security (continued)

- [ ] **P2** Rewrite git history to remove leaked credentials  
  YouTube API key (`AIzaSy…`) and Spotify client secret (`9d84c3…`) are still visible in the public GitHub commit history even though they have been rotated. A bad actor can find them via `git log -p`. Fix: `git filter-repo --replace-text` to redact the strings from all commits, then force-push. Coordinate timing so no one has the old repo cloned mid-operation.  
  _Surfaced by /cso on 2026-09-16_

## P2 — Ship before public launch

- [x] **P2** Full-round E2E test (host + player completing a game round)  
  Completed: `e2e/two-player-game.spec.ts` covers 3-round turn-based game with Alice + Bob, testing guessing, spectating, reveal, and win condition.

- [ ] **P2** Concurrent-placement integration test  
  The party server's `handlePlace` doesn't race, but a test with two `PLACE` messages arriving within the same tick would confirm `placements[playerId]` is set correctly and `PLACEMENT_ACK` is sent to both.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P2** Cross-session playlist dedup by source URL  
  Within-session: Save button replaced by "Saved ✓" after first save. Cross-session (page reload + same URL): no dedup by source URL — the same YouTube playlist can be saved multiple times across sessions. Fix: store source URL in playlist metadata and skip save if already present.  
  _Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

- [ ] **P2** E2E: full round-trip save → reload → select saved playlist → start game  
  API and save-panel UI tests exist, but no browser test completes the full flow of: reload page → select saved playlist from panel → verify game starts with those songs.  
  _Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

- [ ] **P2** E2E: edit year on one song → verify updated year used in placement evaluation  
  The override path exists (`party/index.ts` applies song overrides from playlist party), but no automated test verifies the year change propagates to correct/incorrect placement scoring.  
  _Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

- [ ] **P2** E2E: two-player game using saved playlist (not hitster://test seed)  
  `e2e/two-player-game.spec.ts` still uses the `hitster://test` seed. Add a variant that loads a saved playlist and runs a full 2-player round to confirm the full pipeline end-to-end.  
  _Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

- [ ] **P2** E2E selector hardening — add `data-testid` to key interactive elements  
  Several e2e selectors match on translated button text (e.g., `getByRole("button", { name: /Load/i })` matches "載入 Load" today but would silently break if text becomes Chinese-only). Add `data-testid="load-playlist-btn"`, `data-testid="start-game-btn"`, `data-testid="reveal-btn"`, `data-testid="place-btn"` etc. to interactive elements in host/play pages, and update e2e tests to use them.  
  _Surfaced by /review on 2026-09-16_

- [x] **P2** Invalid room code silently creates orphaned waiting room  
  Fixed by /qa on feat/initial-scaffold, 2026-08-28 — commit ed7449a. Shows yellow warning banner after 90s: "Still waiting after 90 seconds — double-check your room code."

## Lyrics Mode — lrclib.net integration (feat/lyrics-api, 2026-09-17)

- [x] **P1** Fetch real lyrics from lrclib.net before Claude Q&A generation  
  `lib/lyrics-fetcher.ts`: `fetchLyrics()` + `fetchLyricsBatch()`. Injects `LYRICS:` blocks (truncated at 1500 chars) or `NO_LYRICS` markers per track. Claude is grounded in actual song text rather than generated/hallucinated lyrics.  
  _Landed in v0.4.1_

- [x] **P1** Harden prompt injection: sanitize `---` in lyrics (adversarial review CRITICAL)  
  Replace bare `---` lines with `- - -` before injection to prevent block separator corruption.  
  _Landed in v0.4.1_

- [x] **P2** Require partial title match in `matchScore` (adversarial review HIGH)  
  Without this, zero-title-match tracks score ≥3 via lyrics bonus and get injected as wrong-song ground truth.  
  _Landed in v0.4.1_

- [ ] **P3** E2E: verify lrclib → Claude pipeline with a real player in the room  
  Headless QA could not test this path (requires playerCount ≥ 1). Load `hitster://cpop-test` in Lyrics Mode with a second tab as player, click Start Lyrics, check server logs for `[lyrics-resolver] lrclib hits: N/8`.  
  _Deferred from /qa on feat/lyrics-api 2026-09-17_

- [ ] **P3** Add 429/rate-limit handling for lrclib.net  
  With concurrency=8, rapid deploys can hit rate limits. A 429 silently drops the window (logs no warning). Add backoff or at least log `[lyrics-resolver] rate limited`.  
  _Surfaced by adversarial review on feat/lyrics-api 2026-09-17_

## Lyrics Mode — completed (from /plan-eng-review 2026-09-17)

- [x] **P1** `npm install fastest-levenshtein` before any Lyrics Mode code  
  The design imports `levenshtein` from `'fastest-levenshtein'` but it is not in `package.json`. Install first or the fuzzy module won't compile in Workers.  
  _Surfaced by /plan-eng-review on 2026-09-17_

- [x] **P1** Add `SHOW_LYRICS_RESULTS` to `ClientMessage` in `lib/game.ts`  
  Missing message for the `guessing → results` phase transition. Without it the state machine can never leave `guessing`. Shape: `{ type: 'SHOW_LYRICS_RESULTS', hostId: string }`.  
  _Surfaced by /plan-eng-review on 2026-09-17_

- [x] **P1** Fix `isCorrect()` fuzzy path to check all variants, not just target  
  Design code: `return levenshtein(answer, target) <= threshold`. Bug: if the answer is 1 char off a variant but not off the primary sentence, it wrongly fails. Fix: `return [target, ...variants].some(v => levenshtein(answer, v) <= threshold)`.  
  _Surfaced by /plan-eng-review on 2026-09-17_

- [x] **P2** Extract `resolvePlaylistToCards()` before adding Lyrics Mode handlers  
  `handleLoadPlaylist` and `handleStartGame` share ~100 lines of identical AI pipeline. Lyrics Mode would be a third copy. Extract to `private async resolvePlaylistToCards()` first — zero behavior change, pure refactor.  
  _Surfaced by /plan-eng-review on 2026-09-17_

- [x] **P2** Add `lyricOverrides` to `START_GAME` message for host preview edits  
  Host edits on the lyrics preview screen (blankSentence, lyricContext, skip) must flow as `lyricOverrides: Record<videoId, Partial<LyricsRound>>` in `START_GAME`. Server applies per-round without DO cache write-back (mirrors `songOverrides`).  
  _Surfaced by /plan-eng-review on 2026-09-17_

## P3 — Nice to have

- [ ] **P3** Cross-device playlist library listing  
  Per-playlist DOs keyed by UUID make individual playlists cross-device accessible via URL, but the full library listing comes from localStorage — empty on a new device. Fix: add a host-library DO (keyed by hostId) that stores the playlist index so the full library is visible from any device.  
  _Surfaced by /plan-eng-review on feat/custom-playlist, 2026-08-28_

- [ ] **P3** `docs/wireframes/hitster-v1.png`  
  The initial wireframe sketch was never committed. Low priority — the code is the spec now.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P3** Update DESIGN.md to reflect v0.3.0.0 architecture  
  The original design doc (`/office-hours`, March 2026) describes the v0.1.0.0 design: Spotify year resolver, no custom playlists, English-only UI. As-shipped architecture is: Claude Haiku AI resolver + DO cache, custom playlist library, Chinese-first UI. The doc should be rewritten (or annotated) so new contributors don't get confused by the delta.  
  _Surfaced by /plan-eng-review on 2026-09-16_

- [ ] **P3** Install `gstack-cso` for formal security audit  
  `gstack-cso` launcher not found — formal CSO audit was blocked. Run `cd ~/.claude/skills/gstack && ./setup` to install, then re-run `/cso` for an evidence-backed security report.  
  _Surfaced by /cso on 2026-09-16_

- [ ] **P3** Fix keyboard focus indicators on all text inputs  
  All `<input type="text">` elements use `outline: "none"` as inline style with no `:focus-visible` CSS fallback. JS `onFocus/onBlur` border-color change provides visual feedback but bypasses CSS. Fix: move `outline: none` to CSS class and add `:focus-visible { outline: 2px solid var(--orange); }`. Touches `app/page.tsx` and `app/room/[code]/host/page.tsx`.  
  _Surfaced by /design-review on 2026-09-16_

- [ ] **P3** Extract Vinyl component — duplicated between homepage and play page  
  `app/page.tsx:7–25` (Vinyl) and `app/room/[code]/play/page.tsx:19–33` (SmallVinyl) copy-paste the same `radial-gradient` string verbatim. Extract to `components/Vinyl.tsx` with a `size` prop.  
  _Surfaced by /design-review on 2026-09-16_

- [ ] **P3** Replace hardcoded hex values with CSS variables  
  CSS tokens (`--orange`, `--ink`, `--bg`, `--text2`, etc.) are defined in `globals.css` `:root` but all component files use raw hex strings inline (`#FF6B35`, `#1A1A2E`, etc.). A palette change requires grep-and-replace across 4 files. Migrate to `var(--orange)` etc. at call sites.  
  _Surfaced by /design-review on 2026-09-16_

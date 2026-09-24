# TODOS

## Timed rounds (Lyrics + Guess)

### Players who join mid-game can't answer in Lyrics/Guess mode

**What:** Players who join mid-game can't answer in Lyrics/Guess mode.

**Why:** A friend who arrives late can't play until the next game, and nothing tells them why.

**Context:** `lyricsState.players` / `guessState.players` are snapshots taken at game start; JOIN/REJOIN never add to them and `connected` never updates. A late joiner sees the round, types an answer, and `timedRound.acceptAnswer` drops it silently (`"ignored"`, no error). More likely in Guess mode (no loading phase to wait through). Fix: add late joiners to the active timed-round state with score 0 (and sync `connected` on REJOIN/onClose), or send an explicit spectator signal the client can show. _Found by /review red team on feat/guess-mode-engine, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### Countdowns use the device clock, not server time

**What:** Countdowns use the device clock, not server time.

**Why:** A phone with a wrong clock hides the inputs early or loses answers to TOO_LATE.

**Context:** Phones and the TV compute time left as `roundStart + timerSeconds*1000 - Date.now()`; `roundStart` is server time. A phone clock that's far off shows the wrong time (inputs hidden early, or TOO_LATE after "time left"). Fix: send `serverNow` with GUESS_STATE/LYRICS_STATE and apply the offset. _Deferred from /ship review (red team), 2026-09-24._

Also tracked earlier as "Client countdown uses the device clock against the server's `roundStart`": A device clock ahead by more than the round timer shows "Time's up" immediately. Send a server time offset. Found by /ship adversarial review on 2026-09-21.

**Effort:** M
**Priority:** P3
**Depends on:** None

### "Submitted!" is optimistic in Guess mode

**What:** "Submitted!" is optimistic in Guess mode.

**Why:** A dropped answer still shows ✓, so the player finds out only at the reveal.

**Context:** The phone shows ✓ before the server confirms; a silently-dropped submit (second tab took over the player id, player not in the game) still looks sent. Derive "submitted" from the redacted answer key arriving, show "sending…" until then. _Deferred from /ship review (red team), 2026-09-24._

Also tracked earlier as "Player shows "Submitted!" before the server acknowledges": Server silently drops answers for unknown/late-joining players. Send an ack or derive submitted from `lyricsState.answers[playerId]`. Also tag SUBMIT/TOO_LATE with the round index. Found by /ship adversarial review on 2026-09-21.

**Effort:** S
**Priority:** P3
**Depends on:** None

### TV results list can overflow with 9+ players

**What:** TV results list can overflow with 9+ players.

**Why:** Bigger groups lose the bottom of the results list on the TV.

**Context:** `GuessScreen` (and Lyrics) results use `overflowY: auto` inside the fixed 960×540 Stage — a TV can't scroll. Verify with ~10 players; then tighten rows, two columns, or top-N + "+N more". _Deferred from /ship design review, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### Share timed-round UI helpers between Lyrics and Guess

**What:** Share timed-round UI helpers between Lyrics and Guess.

**Why:** Three copies of the countdown/leaderboard logic can drift apart.

**Context:** `useCountdown`, `Standings`, `guessAudioProps`, and the TV score row in `components/GuessMode.tsx` duplicate inline Lyrics code in the play/screen pages (~50 lines). Widen them to structural types and use them for Lyrics too (touches live Lyrics UI — do it with tests). _Advisory from /ship review, 2026-09-24._

**Effort:** M
**Priority:** P3
**Depends on:** None

### Ties crown a single winner in Lyrics/Guess

**What:** Ties crown a single winner in Lyrics/Guess.

**Why:** A tie shows one player as winner and the other as #2 at random.

**Context:** Players tied on top get "WINNER!" vs "#2" by object-key order; TV/host show one name. Decide tie semantics (co-winners?). _From /ship adversarial #5, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### Timeline START_GAME isn't blocked by an *ended* Guess/Lyrics game

**What:** Timeline START_GAME isn't blocked by an *ended* Guess/Lyrics game.

**Why:** A stale host tab could leave every phone stuck on old standings.

**Context:** `timedRoundInPlay()` treats "ended" as safe, so a stale host tab could start Timeline while `guessState` (ended) still exists — phones then stay on the Guess standings (play page renders GuessPlay whenever guessState is set). Clear ended timed states (+ ABORTED broadcast) in handleStartGame. _From /ship adversarial #6, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### Unauthorized TV retries GET_*_AUDIO on every state broadcast

**What:** Unauthorized TV retries GET_*_AUDIO on every state broadcast.

**Why:** A TV that lost the screen claim stays silent with no explanation.

**Context:** If another connection claimed the screen id, each GUESS_STATE/LYRICS_STATE makes the TV resend GET_GUESS_AUDIO and get ERROR unauthorized, with no backoff and no visible reason. Stop retrying after unauthorized and show a message. _From /ship adversarial #7, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### `consecutiveSkips` is a dead field in the timed-round state

**What:** `consecutiveSkips` is a dead field in the timed-round state.

**Why:** Dead state on the wire confuses anyone reading the protocol.

**Context:** Carried in `TimedRoundState` (lib/game.ts) and reset in `timedRound.showResults`, but nothing increments or reads it. Delete it (wire-visible on LYRICS_STATE, no client reads it) unless a skip-round feature is planned. _Found by /review on feat/guess-mode-engine, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

## Guess Mode

### Guess mode answers fall back to raw YouTube titles when AI cleanup is missing

**What:** Guess mode answers fall back to raw YouTube titles when AI cleanup is missing.

**Why:** Without AI cleanup, whole Guess rounds can be unwinnable.

**Context:** Without AI metadata (no Anthropic key, or a failed call) `lib/playlist-resolver.ts` uses the raw video title ("Artist - Song (Official MV)") and channel name ("…VEVO", "… - Topic") as the Guess answer, so players typing the real name are marked wrong and nobody is told. Mid-load starts are already refused (`playlistLoading`). Decide in the host UI (T5/T6): warn the host which songs lack cleaned metadata, strip common YouTube title noise, or exclude those songs from the Guess deck. _Found by /review adversarial pass on feat/guess-mode-engine, 2026-09-24._

**Effort:** M
**Priority:** P2
**Depends on:** None

### Guess mode: whoever claims the screen holds the answer key

**What:** Guess mode: whoever claims the screen holds the answer key.

**Why:** In Guess mode the screen credential is the answer key.

**Context:** `GET_GUESS_AUDIO` hands the current videoId (which reveals title/artist) to the first `screenId` claimant — the accepted first-claim gap above, but in Guess mode the videoId *is* the answer. Revisit with the minted-token fix before Guess ships to wider play. _Found by /review adversarial pass, 2026-09-24._

**Effort:** M
**Priority:** P2
**Depends on:** None

### Guess grading tuning after playtest

**What:** Guess grading tuning after playtest.

**Why:** Grading leniency and point values need real-game data.

**Context:** Fuzzy distance 2 on 5-char Latin targets is lenient ("hello"~"help"). Answers accepted in the 500ms grace window always score 0 (inherited from Lyrics). Tune with real games. _From /review adversarial pass, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### A phone offline across a Guess reset can stay "too late" in the new game

**What:** A phone's TOO_LATE flag can carry into a new Guess game if the phone missed `GUESS_ABORTED`.

**Why:** That player is locked out of one round with no way to answer.

**Context:** `app/room/[code]/play/page.tsx` clears `guessTooLateRound` only on `GUESS_ABORTED`. A phone disconnected while the host resets and starts a new game never gets it: on reconnect `sendSnapshot` sends `GUESS_ABORTED` only when no game exists, so it gets just the new `GUESS_STATE`. If that game is on the same round index, the stale flag matches. Fix: also clear it on `GUESS_STATE` when `phase` is `"playing"`, or key it on round start time instead of index. _Found by /land-and-deploy inline review, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

## Lyrics Mode

### E2E: verify lrclib → Claude pipeline with a real player in the room

**What:** E2E: verify lrclib → Claude pipeline with a real player in the room.

**Why:** The lrclib → Claude path has never been exercised end-to-end with a player.

**Context:** Headless QA could not test this path (requires playerCount ≥ 1). Load `hitster://cpop-test` in Lyrics Mode with a second tab as player, click Start Lyrics, check server logs for `[lyrics-resolver] lrclib hits: N/8`.
_Deferred from /qa on feat/lyrics-api 2026-09-17_

**Effort:** S
**Priority:** P3
**Depends on:** None

### Add 429/rate-limit handling for lrclib.net

**What:** Add 429/rate-limit handling for lrclib.net.

**Why:** Rate limits silently drop lyric lookups.

**Context:** With concurrency=8, rapid deploys can hit rate limits. A 429 silently drops the window (logs no warning). Add backoff or at least log `[lyrics-resolver] rate limited`.
_Surfaced by adversarial review on feat/lyrics-api 2026-09-17_

**Effort:** S
**Priority:** P3
**Depends on:** None

### Play a video that can't be embedded: skip to the next song automatically

**What:** Play a video that can't be embedded: skip to the next song automatically.

**Why:** A round with an unembeddable video runs with no audio.

**Context:** LyricsPlayer now warns the host, but the round still runs without audio. A skip message would need adding (the unused `LYRICS_ROUND_FAILED` type was removed in v0.5.1.0). Found by /ship adversarial review on 2026-09-21.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Host & Screen

### Host setup says "N 首歌曲有確認年份" in Guess/Lyrics mode

**What:** Host setup says "N 首歌曲有確認年份" in Guess/Lyrics mode.

**Why:** Guess/Lyrics hosts see Timeline-only copy about release years.

**Context:** The load-success line (`app/room/[code]/host/page.tsx`, ready state) talks about confirmed release years, which only matter in Timeline. Make it mode-aware ("N 首歌曲已載入"). _Found by /qa ISSUE-002, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### Host keeps the lobby vinyl background during Lyrics/Guess play (DESIGN.md)

**What:** Host keeps the lobby vinyl background during Lyrics/Guess play (DESIGN.md).

**Why:** DESIGN.md keeps the lobby pattern out of gameplay.

**Context:** `.bg-vinyl-pattern` is keyed on `state.phase === "lobby"`, which stays "lobby" through Lyrics/Guess games; DESIGN.md keeps the pattern out of active gameplay. Key it on "no timed game in play" too. _Found by /qa ISSUE-003, 2026-09-24._

**Effort:** S
**Priority:** P3
**Depends on:** None

### The screen and host credentials trust whoever asks first, not that they're actually the TV/host

**What:** The screen and host credentials trust whoever asks first, not that they're actually the TV/host.

**Why:** Anyone who asks first can squat the host or TV slot.

**Context:** `claimOrValidateFirstClaim` (party/index.ts, shared by `claimOrValidateHost` and `claimOrValidateScreen`) accepts any non-empty client-supplied string and grants it on first use — there's nothing that distinguishes the real `/screen` tab (or the real host) from a player's own game tab. A player would have to deliberately reach `/host` and take a host action to squat the slot; this is a house game for friends, not an adversarial environment, so the realistic risk is low — but it's a real gap, not a hardened one. Once claimed there's also no re-claim path, so a deliberate (or accidental duplicate) claim locks the real screen/host out for the rest of the game. Host's exposure grew slightly on 2026-09-22 (cross-device handoff): `/host` is now reachable from the homepage's join form on any device that knows the room code (not just the creator's own browser), gated by a `confirm()` guard rather than being unreachable outside devtools. The room code itself was already public (shown on `/screen`, in the join QR), so this doesn't leak a new secret — it makes an already-possible path (typing the code into the URL by hand) discoverable. Real fix, if ever needed: a host-minted token for both. Originally found by `/ship`'s adversarial review on 2026-09-22 (screenId only); broadened to hostId by `/plan-eng-review` on 2026-09-22 when the connection-order host gate was removed; discoverability extended by `/plan-eng-review` again the same day for cross-device handoff, with outside voice adding the confirm guard specifically to keep the accidental-claim risk at its prior low-probability level. User reviewed and chose to ship as-is each time.

**Effort:** L
**Priority:** P3
**Depends on:** None

## Playlists & Library

### Reject malformed video ids when a playlist is saved or loaded

**What:** Reject malformed video ids when a playlist is saved or loaded.

**Why:** A malformed video id can reach the player.

**Context:** `LOAD_SAVED_PLAYLIST` and the playlist party only check that `videoId` is a non-empty string. A server-side `/^[\w-]{11}$/` check would stop a bad id reaching the player at all. Found by /ship adversarial review on 2026-09-21.

**Effort:** S
**Priority:** P3
**Depends on:** None

### Library index drifts on playlist rename or song add/remove via PUT

**What:** Library index drifts on playlist rename or song add/remove via PUT.

**Why:** Renamed or edited playlists show stale names/counts in the library.

**Context:** `party/library.ts`'s entry ({id, name, songCount}) is only synced from `party/playlist.ts` on create (POST) and delete (DELETE) — decision D2a in `docs/designs/decouple-quiz-bank.md` scoped it to those two, not every PUT sub-action (rename, UPDATE_SONG, DELETE_SONG). A renamed playlist or one with songs added/removed keeps showing its old name/count in the library list until... never, there's no other sync trigger. Low-severity (stale display only, the playlist itself is correct) but worth fixing by calling `syncLibrary("UPSERT", ...)` from the same PUT branches that change `name` or `songs.length`. Found during T4 implementation (docs/designs/decouple-quiz-bank.md), 2026-09-22.

**Effort:** S
**Priority:** P3
**Depends on:** None

## Infrastructure

### Room state is in memory only: a PartyKit reload or eviction wipes the game and leaves host/player pages stale

**What:** Room state is in memory only: a PartyKit reload or eviction wipes the game and leaves host/player pages stale.

**Why:** A PartyKit restart silently wipes the running game.

**Context:** Persist minimal game state to `room.storage` or detect a fresh server and reset clients. Found by /qa on 2026-09-21.

**Effort:** L
**Priority:** P3
**Depends on:** None

### `npm audit` reports 17 remaining advisories (2 critical, 5 high, 9 moderate, 1 low), all dev/build-tooling only

**What:** `npm audit` reports 17 remaining advisories (2 critical, 5 high, 9 moderate, 1 low), all dev/build-tooling only.

**Why:** Keep the advisory count honest; dev-only today.

**Context:** Confirmed via `npm ls` per package — none trace to a production dependency: `eslint-config-next`'s tooling (brace-expansion, browserslist, baseline-browser-mapping), `eslint` itself (js-yaml), `vitest` (vite, fflate), and `partykit`'s own bundler/local-dev simulator (esbuild, undici via miniflare). `ws` was fixed via a package.json `overrides` pin to `8.21.0`. The rest aren't safely fixable without a major-version bump from an upstream package (`partykit`→miniflare, or `next build`/`eslint-config-next`'s own dep tree) — revisit in a batch when those ship updates.
_Surfaced by ad-hoc audit, 2026-09-23_

**Effort:** S
**Priority:** P3
**Depends on:** None

### Install `gstack-cso` for formal security audit

**What:** Install `gstack-cso` for formal security audit.

**Why:** The formal /cso security audit was blocked.

**Context:** `gstack-cso` launcher not found — formal CSO audit was blocked. Run `cd ~/.claude/skills/gstack && ./setup` to install, then re-run `/cso` for an evidence-backed security report.
_Surfaced by /cso on 2026-09-16_

**Effort:** S
**Priority:** P3
**Depends on:** None

## Testing

### e2e coverage for the host/screen split (3-role flows)

**What:** e2e coverage for the host/screen split (3-role flows).

**Why:** Nothing automated exercises /screen-specific behavior beyond Guess mode.

**Context:** The existing e2e suite still passes (the Timeline-mode host contract — reveal-btn/next-round-btn — was kept intact) but nothing automated exercises `/screen` itself: video-only-on-screen, the preview-leak fix, screen reconnect. Manually verified in a real browser by `/qa` on 2026-09-22 instead. Found by `/plan-eng-review` on 2026-09-21 (T8), still open.

**Effort:** M
**Priority:** P3
**Depends on:** None

## Design & Docs

### Fix keyboard focus indicators on all text inputs

**What:** Fix keyboard focus indicators on all text inputs.

**Why:** Keyboard users get no focus ring on the host and home pages.

**Context:** All `<input type="text">` elements use `outline: "none"` as inline style with no `:focus-visible` CSS fallback. JS `onFocus/onBlur` border-color change provides visual feedback but bypasses CSS. Fix: move `outline: none` to CSS class and add `:focus-visible { outline: 2px solid var(--orange); }`. Touches `app/page.tsx` and `app/room/[code]/host/page.tsx`.
_Surfaced by /design-review on 2026-09-16_

**Effort:** S
**Priority:** P3
**Depends on:** None

### Update DESIGN.md to reflect v0.3.0.0 architecture

**What:** Update DESIGN.md to reflect v0.3.0.0 architecture.

**Why:** The design doc describes an architecture that no longer exists.

**Context:** The original design doc (`/office-hours`, March 2026) describes the v0.1.0.0 design: Spotify year resolver, no custom playlists, English-only UI. As-shipped architecture is: Claude Haiku AI resolver + DO cache, custom playlist library, Chinese-first UI. The doc should be rewritten (or annotated) so new contributors don't get confused by the delta.
_Surfaced by /plan-eng-review on 2026-09-16_

**Effort:** M
**Priority:** P3
**Depends on:** None

### `docs/wireframes/hitster-v1.png`

**What:** `docs/wireframes/hitster-v1.png`.

**Why:** The original wireframe was never committed.

**Context:** The initial wireframe sketch was never committed. Low priority — the code is the spec now.
_Deferred from plan: foamy-crafting-bonbon.md_

**Effort:** S
**Priority:** P3
**Depends on:** None

## Completed

### `WRONG_PHASE` vs `too_late` error key mismatch

**Priority:** P1 · _originally under "P1 — Pre-launch blockers"_

Fixed: server now sends `{ type: "TOO_LATE" }` (matching client expectation). Test updated.

### YouTube overlay blocks blurred thumbnail (potential ToS issue)

**Priority:** P1 · _originally under "P1 — Pre-launch blockers"_

Fixed: overlay opacity reduced to `/90` (10% of blurred video shows through). ToS compliant.

### Rotate leaked API credentials

**Priority:** CRITICAL · _originally under "Pre-launch security"_

YouTube API key + Spotify client ID/secret were committed to git history. Credentials have been rotated.

### Strip future song years from broadcast state (security/fairness)

**Priority:** P2 · _originally under "Pre-launch security"_

Fixed: `sanitizedState()` zeros `year` on all `songs[]` cards and on `currentSong` during guessing phase. Applied to `broadcastState()`, `onConnect()`, and `handleRejoin()`.

### hostId first-write-wins is vulnerable to takeover

**Priority:** P2 · _originally under "Pre-launch security"_

Fixed: `hostConnId` records the first WebSocket connection via `onConnect`. The first host claim is rejected if it comes from a different connection.

### Validate `playerId` format to prevent prototype-pollution-adjacent keys

**Priority:** P2 · _originally under "Pre-launch security"_

Fixed: UUID regex guard on `handleJoin`, `handleRejoin`, `handlePlace`. Non-UUID playerIds are silently dropped.

### Concurrent `LOAD_PLAYLIST` causes non-deterministic `pendingPlaylist` state

**Priority:** P2 · _originally under "Pre-launch security"_

Fixed: `loadSeq` counter; each load captures its generation, and async checkpoints discard superseded loads silently.

### Rewrite git history to remove leaked credentials

**Priority:** P2 · _originally under "Pre-launch security (continued)"_

**Completed 2026-09-22:** `git filter-repo --replace-text` run against a fresh mirror clone, redacting the YouTube API key and Spotify client secret from all 99 commits across all 7 live branches (main + 6 in-progress branches; PRs already merged had their head branches auto-deleted, so nothing to rewrite there). Force-pushed all 7, verified `git log --all -p | grep` returns zero matches for either secret post-rewrite, then reset this local working copy to the new history. All commit hashes changed — any other existing clone of this repo is now stale and should be re-cloned, not pulled.
_Surfaced by /cso on 2026-09-16_

### Lyrics mode leaks every player's raw answer to all clients during guessing

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

What: `party/index.ts`'s `broadcastLyricsState()` sends the full `LyricsGameState` — including `answers` with every player's raw submitted text — to ALL clients (not just privileged ones) on every `SUBMIT_LYRICS_ANSWER`, because `sanitizedLyricsState()` spreads `...ls` and never redacts `answers`. Why: a player who submits last (or just watches the websocket) can read everyone else's guesses before answering, undermining the "answer independently, then reveal" mechanic the whole timed-round format depends on. Context: `party/index.ts:939-982` (`sanitizedLyricsState`/`broadcastLyricsState`), `party/index.ts:1256-1278` (`handleSubmitLyricsAnswer`). Found by `/plan-eng-review` on `docs/designs/guess-mode-song-artist.md`, 2026-09-23.
**Completed:** `sanitizedLyricsState()` now replaces every answer's `text` with `""` while `phase === "guessing"` — keys (for the host's "N/M answered" count) and the `correct`/`points` placeholders stay, since the client never reads answer text before results (verified: host page only reads `Object.keys(answers).length`; play page's own-answer display is gated on `phase === "results"`; screen page's `.answers[id]` read only fires post-reveal). Zero client changes needed. Regression test in `party/index.test.ts` ("never broadcasts any player's raw answer text during guessing...") sends two real answers and asserts every `guessing`-phase broadcast redacts both, then confirms results-phase reveal still shows the real text.

### Full-round E2E test (host + player completing a game round)

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

Completed: `e2e/two-player-game.spec.ts` covers 3-round turn-based game with Alice + Bob, testing guessing, spectating, reveal, and win condition.

### Concurrent-placement integration test

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

**Completed:** `party/index.test.ts`'s "PLACE handler" describe block covers this — one test confirms `placements[playerId]` and exactly 2 `PLACEMENT_ACK`s for two concurrent same-position PLACEs (strengthened from an earlier shallow version that only checked "at least one" ACK), a second new test confirms last-write-wins for two concurrent PLACEs at *different* positions, documenting that `handlePlace`'s fully-synchronous body means the Durable Object's single-threaded model makes this deterministic, not a real race. Matches what the client's `pendingPlace` guard (v0.12.8.0) already assumes.
_Deferred from plan: foamy-crafting-bonbon.md_

### Cross-session playlist dedup by source URL

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

Within-session: Save button replaced by "Saved ✓" after first save. Cross-session (page reload + same URL): no dedup by source URL — the same YouTube playlist can be saved multiple times across sessions. Fix: store source URL in playlist metadata and skip save if already present.
**Completed:** `SavedPlaylist`/`LibraryEntry` gained an optional `sourceUrl`; `party/playlist.ts`'s POST stores and propagates it to the library index; `handleSavePlaylist` (host page) checks `savedPlaylists` for a matching `sourceUrl` right after a fresh `handleLoadPlaylist` and skips the POST entirely, reusing the existing entry's id. Only fires right after loading a fresh URL (not after loading a previously-saved playlist), matching this TODO's stated scope. Regression test in `app/__tests__/host-page.test.tsx`.
_Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

### E2E: full round-trip save → reload → select saved playlist → start game

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

API and save-panel UI tests exist, but no browser test completes the full flow of: reload page → select saved playlist from panel → verify game starts with those songs.
**Completed:** `e2e/playlist.spec.ts`'s round-trip test now joins a real player and clicks Start Game after loading the saved playlist, asserting `reveal-btn` appears — proves the reload → load-saved path produces an actually-playable deck, not just an enabled button.
_Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

### E2E: edit year on one song → verify updated year used in placement evaluation

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

The override path exists (`party/index.ts` applies song overrides from playlist party), but no automated test verifies the year change propagates to correct/incorrect placement scoring.
**Completed:** as a fast integration test, not a browser E2E — `party/index.test.ts`'s "START_GAME song year override reaches placement evaluation" sends a host-edited year via `START_GAME`'s `songs` param and verifies it lands in the dealt deck AND flips the placement's correct/incorrect outcome vs. the originally-fetched year. A real browser round trip couldn't test this at all: the `hitster://test`/`hitster://cpop-test` seeds `handleStartGame` uses in every existing e2e spec ignore `songOverrides` entirely (only the LOAD_PLAYLIST-cached real-playlist path applies them), and a real playlist's deck is shuffled server-side, so a browser test would have no deterministic round to assert on.
_Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

### E2E: two-player game using saved playlist (not hitster://test seed)

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

`e2e/two-player-game.spec.ts` still uses the `hitster://test` seed. Add a variant that loads a saved playlist and runs a full 2-player round to confirm the full pipeline end-to-end.
**Completed:** already existed and fully passes — `e2e/two-player-game.spec.ts`'s "Two-player game using saved playlist" describe block creates a real saved playlist via the HTTP API, loads it by ID on the host page, and runs a full 4-round 2-player game confirming placements, spectating, and non-forced win-target behavior all work against a real saved playlist. Just a stale checkbox; no new work needed beyond fixing its selectors (see the selector-hardening item below).
_Deferred from plan: georgechih-feat-custom-playlist-eng-review-test-plan-20260828-221211.md_

### E2E selector hardening — add `data-testid` to key interactive elements

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

Several e2e selectors match on translated button text (e.g., `getByRole("button", { name: /Load/i })` matches "載入 Load" today but would silently break if text becomes Chinese-only). Add `data-testid="load-playlist-btn"`, `data-testid="start-game-btn"`, `data-testid="reveal-btn"`, `data-testid="place-btn"` etc. to interactive elements in host/play pages, and update e2e tests to use them.
**Completed:** added `join-name-input`/`join-code-input`/`join-room-btn` (homepage), `save-playlist-toggle-btn`/`save-playlist-name-input`/`save-playlist-submit-btn`/`edit-songs-toggle-btn`/`load-by-id-input`/`load-by-id-btn`/`load-saved-playlist-btn`/`delete-saved-playlist-btn` (host page). All 4 e2e spec files updated to use testids instead of CJK button text/placeholder matches wherever one now exists.
_Surfaced by /review on 2026-09-16_

### Invalid room code silently creates orphaned waiting room

**Priority:** P2 · _originally under "P2 — Ship before public launch"_

Fixed by /qa on feat/initial-scaffold, 2026-08-28 — commit ed7449a. Shows yellow warning banner after 90s: "Still waiting after 90 seconds — double-check your room code."

### Fetch real lyrics from lrclib.net before Claude Q&A generation

**Priority:** P1 · _originally under "Lyrics Mode — lrclib.net integration (feat/lyrics-api, 2026-09-17)"_

`lib/lyrics-fetcher.ts`: `fetchLyrics()` + `fetchLyricsBatch()`. Injects `LYRICS:` blocks (truncated at 1500 chars) or `NO_LYRICS` markers per track. Claude is grounded in actual song text rather than generated/hallucinated lyrics.
_Landed in v0.4.1_

### Harden prompt injection: sanitize `---` in lyrics (adversarial review CRITICAL)

**Priority:** P1 · _originally under "Lyrics Mode — lrclib.net integration (feat/lyrics-api, 2026-09-17)"_

Replace bare `---` lines with `- - -` before injection to prevent block separator corruption.
_Landed in v0.4.1_

### Require partial title match in `matchScore` (adversarial review HIGH)

**Priority:** P2 · _originally under "Lyrics Mode — lrclib.net integration (feat/lyrics-api, 2026-09-17)"_

Without this, zero-title-match tracks score ≥3 via lyrics bonus and get injected as wrong-song ground truth.
_Landed in v0.4.1_

### `npm install fastest-levenshtein` before any Lyrics Mode code

**Priority:** P1 · _originally under "Lyrics Mode — completed (from /plan-eng-review 2026-09-17)"_

The design imports `levenshtein` from `'fastest-levenshtein'` but it is not in `package.json`. Install first or the fuzzy module won't compile in Workers.
_Surfaced by /plan-eng-review on 2026-09-17_

### Add `SHOW_LYRICS_RESULTS` to `ClientMessage` in `lib/game.ts`

**Priority:** P1 · _originally under "Lyrics Mode — completed (from /plan-eng-review 2026-09-17)"_

Missing message for the `guessing → results` phase transition. Without it the state machine can never leave `guessing`. Shape: `{ type: 'SHOW_LYRICS_RESULTS', hostId: string }`.
_Surfaced by /plan-eng-review on 2026-09-17_

### Fix `isCorrect()` fuzzy path to check all variants, not just target

**Priority:** P1 · _originally under "Lyrics Mode — completed (from /plan-eng-review 2026-09-17)"_

Design code: `return levenshtein(answer, target) <= threshold`. Bug: if the answer is 1 char off a variant but not off the primary sentence, it wrongly fails. Fix: `return [target, ...variants].some(v => levenshtein(answer, v) <= threshold)`.
_Surfaced by /plan-eng-review on 2026-09-17_

### Extract `resolvePlaylistToCards()` before adding Lyrics Mode handlers

**Priority:** P2 · _originally under "Lyrics Mode — completed (from /plan-eng-review 2026-09-17)"_

`handleLoadPlaylist` and `handleStartGame` share ~100 lines of identical AI pipeline. Lyrics Mode would be a third copy. Extract to `private async resolvePlaylistToCards()` first — zero behavior change, pure refactor.
_Surfaced by /plan-eng-review on 2026-09-17_

### Add `lyricOverrides` to `START_GAME` message for host preview edits

**Priority:** P2 · _originally under "Lyrics Mode — completed (from /plan-eng-review 2026-09-17)"_

Host edits on the lyrics preview screen (blankSentence, lyricContext, skip) must flow as `lyricOverrides: Record<videoId, Partial<LyricsRound>>` in `START_GAME`. Server applies per-round without DO cache write-back (mirrors `songOverrides`).
_Surfaced by /plan-eng-review on 2026-09-17_

### Host UI needs a "quit game" control for Lyrics/Guess

**Priority:** P3 · _originally under "P3 — Nice to have"_

Server now accepts `RESET_LYRICS_GAME` / `RESET_GUESS_GAME` in any phase (the lobby guard would otherwise lock an abandoned room), but the host page only shows reset at `ended`. Add a confirm-first quit button during play (T5/T6). _From /review D6, 2026-09-24._

**Completed:** v0.14.0.0 (2026-09-24) — confirm-first quit button on every Lyrics/Guess host panel

### Cross-device playlist library listing

**Priority:** P3 · _originally under "P3 — Nice to have"_

Per-playlist DOs keyed by UUID make individual playlists cross-device accessible via URL, but the full library listing comes from localStorage — empty on a new device. Fix: add a host-library DO (keyed by hostId) that stores the playlist index so the full library is visible from any device.
_Surfaced by /plan-eng-review on feat/custom-playlist, 2026-08-28_. **Completed:** v0.12.1.0 (2026-09-22), `party/library.ts` + one-time localStorage migration, part of docs/designs/decouple-quiz-bank.md.

### `next@16.2.4` had 7 CVEs incl. critical DoS + XSS + cache poisoning — actual production exposure

**Priority:** P1 · _originally under "P3 — Nice to have"_

First `npm audit` pass used `--omit=dev`, which hid this (it only showed transitive dev-tooling findings). Full `npm audit` (no flag) surfaced `next` itself as vulnerable — real user-facing risk, not dev-only. **Fixed:** upgraded to `16.3.6` (same major, out of the vulnerable range). Also discovered and fixed: `16.3.6`'s build-time typecheck is stricter than `16.2.4`'s and started failing on 2 pre-existing type errors in `party/index.test.ts` that `16.2.4` silently ignored — fixed those too, so the upgrade doesn't newly break `next build` / Vercel deploys.
_Surfaced by ad-hoc audit, 2026-09-23_

### Extract Vinyl component — duplicated between homepage and play page

**Priority:** P3 · _originally under "P3 — Nice to have"_

`app/page.tsx:7–25` (Vinyl) and `app/room/[code]/play/page.tsx:19–33` (SmallVinyl) copy-paste the same `radial-gradient` string verbatim. Extract to `components/Vinyl.tsx` with a `size` prop.
_Surfaced by /design-review on 2026-09-16_
**Completed:** extracted to `components/Vinyl.tsx`, used by both call sites plus the new winner screen.

### Replace hardcoded hex values with CSS variables

**Priority:** P3 · _originally under "P3 — Nice to have"_

CSS tokens (`--orange`, `--ink`, `--bg`, `--text2`, etc.) are defined in `globals.css` `:root` but all component files use raw hex strings inline (`#FF6B35`, `#1A1A2E`, etc.). A palette change requires grep-and-replace across 4 files. Migrate to `var(--orange)` etc. at call sites.
_Surfaced by /design-review on 2026-09-16_
**Completed:** v0.6.2.0 — 312 occurrences across 13 files migrated to `var(--token)`. Left as literal hex (with a comment): `app/layout.tsx`'s `themeColor` (a `<meta>` tag, can't resolve custom properties) and `components/Qr.tsx`'s `QRCode.toDataURL()` color option (a canvas-drawing library option, not a DOM style).

### Joining a nonexistent room code shows "waiting for host" forever

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

PartyKit creates rooms on demand, so any code "exists" — a real room registry or host-presence check is out of scope for the current in-memory room model (see the still-open "Room state is in memory only" item below).
**Completed 2026-09-22:** the existing 90s warning (present since v0.1.0.0) was dead-end text with no way to act on it. Added a "返回首頁重新輸入 → Back to homepage" link next to it — an honest nudge with a real way out, not a hard error the server can't actually detect.

### Decide whether Lyrics Mode should play audio

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

Host round screen has a "Cut" button but only Timeline mode mounts `MusicPlayer`. Found by /qa on 2026-09-21.
**Completed:** v0.5.0.0 (2026-09-21) — host-side LyricsPlayer.

### Unit test for the Lyrics "Time's up" state on the play page (needs a mocked partysocket harness)

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

Regression for ISSUE-001, deferred by /qa on 2026-09-21. **Completed:** v0.4.2.1 (2026-09-21), `app/__tests__/play-page.test.tsx`.

### Server should stamp answer time itself instead of trusting the client `ts`

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

`party/index.ts` handleSubmitLyricsAnswer compares a client-supplied `ts` to the deadline and `computePoints` uses it, so a player can answer late or claim max points by spoofing it. Found by /ship adversarial review on 2026-09-21. **Completed:** v0.10.1.0 (2026-09-22), server now calls `Date.now()` itself; the client no longer sends `ts` at all.

### Bind Lyrics answers to the sending connection

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

Any player can answer as another player (ids are visible in broadcast state). Needs a conn.id to playerId map that survives REJOIN. Found by /ship adversarial review on 2026-09-21. **Completed:** v0.10.1.0 (2026-09-22), `playerConnId` map set on JOIN/REJOIN, checked in `handleSubmitLyricsAnswer`.

### `handleStartLyricsGame` has no re-entrancy guard

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

A second START_LYRICS_GAME (double click) can let a stale loader abort or overwrite the newer game. Reject START while a game is active and bail after each await if a sequence token changed. Found by /ship adversarial review on 2026-09-21.
**Completed:** added `if (this.lyricsState !== null) return error` right after the existing phase/host checks in `handleStartLyricsGame` — `this.lyricsState` is set synchronously before any `await`, so this single guard is atomic against a concurrent second call (no sequence token needed; JS run-to-completion means the second call can't observe a stale `null` once the first has started). Regression test in `party/index.test.ts` fires two START_LYRICS_GAME calls without awaiting the first, confirmed it fails without the guard and passes with it.

### The review step broadcasts the whole deck (video ids and answers) to every client

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

`sanitizedLyricsState` sends `rounds` with answers revealed to all connections during `preview` so the host can review them. Players can read it from the WebSocket. Needs per-connection state (host gets the deck, players get an empty list). Found by /ship review on 2026-09-21.
**Completed:** v0.6.0.0 (2026-09-22) — the host/screen split's `privilegedConns`/`allConns` model routes the full deck only to the host and the big screen (`broadcastLyricsState`, and separately `onConnect` for a client that joins mid-review).

### Timeline mode: tell the host when a song's video can't start

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

MusicPlayer now survives a malformed video id (v0.5.1.0) but the round runs silently with no music and no notice; Lyrics Mode shows one. Reuse the LyricsPlayer "can't play" banner. Found by /ship adversarial review on 2026-09-21.
**Completed:** as part of a bigger MusicPlayer rewrite (see below, "Timeline mode audio silently breaks when /screen opens after the round starts") — MusicPlayer now has the same `onError` → "can't play" banner as LyricsPlayer.

### Timeline mode exposes the real video id to all players at all times

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

`sanitizedState()` (party/index.ts:150-163) strips `year` from `currentSong` but never `videoId`. A player can open the real YouTube link and see the true title/upload date, defeating the year-guess — same bug class as the Lyrics Mode leak fixed in v0.5.0.0/v0.5.1.0. Depends on the host/screen split landing first: `screenId` gives a clean place to route Timeline's video the way Lyrics audio already routes to the host. Found by `/plan-eng-review` on 2026-09-21.
**Completed:** `sanitizedState(forPrivileged)` now strips `currentSong.videoId` for everyone except `privilegedConns` (host, screen); `broadcastState()` excludes privileged connection ids from the normal `room.broadcast` and sends them the real id directly. Added a `JOIN_SCREEN` message so `/screen` claims its `screenId` on mount, independent of game mode — Timeline mode never sends `GET_LYRICS_AUDIO`, so it had no other way to prove itself. `/review`'s adversarial pass caught that `songs[]` (the whole remaining deck) had the same leak — real videoIds for every *future* round, not just the current one, unredacted in every broadcast even though nothing renders it — fixed the same way in the same pass.

### Player names and reveal-phase song info were invisible on `/screen`

**Priority:** High · _originally under "QA findings 2026-09-21 (deferred)"_

`PlayerList` and `MusicPlayer`'s reveal panel used white text and near-transparent-white row backgrounds meant for a dark container; `/screen`'s light Stage background made it unreadable. Found and fixed by `/qa` on 2026-09-22 (ISSUE-001).

### Check the host header's new QR panel at phone width

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

Added in the host/screen split; not checked at narrow mobile viewports (the rest of `/host` is unchanged and already phone-first). Found by `/qa` on 2026-09-22.

**Completed:** v0.14.0.0 (2026-09-24) — host header rows now wrap on phones (/qa ISSUE-001)

### Tokenize the DESIGN.md color palette as CSS custom properties or a shared constants module

**Priority:** P3 · _originally under "QA findings 2026-09-21 (deferred)"_

`app/room/[code]/screen/page.tsx` and `app/room/[code]/host/page.tsx` both hardcode the same 8 hex literals (`#1A1A2E`, `#7B7B9A`, etc.) that DESIGN.md now names as tokens (colors.ink, colors.text-muted, ...); a future palette tweak needs a manual find-and-replace across files. Pre-existing pattern across the app (LyricsPlayer, MusicPlayer, PlaylistEditor all do this too), not unique to this branch, but DESIGN.md existing now makes it worth fixing properly rather than per-file. Found by `/ship` maintainability specialist review on 2026-09-22.
**Completed:** v0.6.2.0 — same fix as the "Replace hardcoded hex values with CSS variables" item above (these were the same gap, found twice).

### Timeline mode audio silently breaks when `/screen` opens after the round starts

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

`MusicPlayer` recreated `new YT.Player(...)` on every `currentSong.videoId` change. YT.Player replaces its DOM target with an iframe as a constructor side effect, so a late-opening `/screen` — whose connection briefly sees a redacted `""` videoId before `JOIN_SCREEN` privileges it (v0.6.1.0) — hit two constructions against the same target: the first (empty id) consumed/detached the target, the second (real id) silently produced a player with no video loaded. No error, no video, no audio; the guessing-phase overlay covers the player regardless, so nothing looked wrong. Found by user report on 2026-09-22.
**Completed:** rewritten to match `LyricsPlayer.tsx`'s already-correct pattern — one player for the component's lifetime, songs switch via `loadVideoById`. Also added the `onAutoplayBlocked`/"tap to play" fallback (surfaced a second, independent cause of the same symptom: genuine browser autoplay policy, since nobody taps `/screen`). Regression tests in `components/MusicPlayer.test.tsx`.

### T8: AI chat-to-diff editing on the standalone `/playlists` page

**Priority:** P2 · _originally under "QA findings 2026-09-21 (deferred)"_

`docs/designs/decouple-quiz-bank.md`'s decision D4. **Completed:** T3 of `docs/designs/full-page-focus-editor.md` (v0.12.4.0) added the stateless `PROPOSE_EDITS` HTTP action on `party/playlist.ts` (mirrors `RESOLVE_FROM_URL`'s shape, not `handleProposeEdits`'s WebSocket shape — corrected during that design's eng review); T4 (v0.12.5.0) wired it into `SongItemEditor.tsx`'s Ask-AI box on `/playlists`. Built once the chat-to-diff UI redesign (the Focus editor) locked its interaction model, per the original hold.

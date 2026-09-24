# Changelog

## [0.13.2.0] — 2026-09-23

### Added
- **Cross-session playlist dedup by source URL** (TODOS.md P2): saving the same YouTube playlist twice across sessions used to always create a new library entry. `SavedPlaylist`/`LibraryEntry` now carry an optional `sourceUrl`, set by `party/playlist.ts`'s POST handler and mirrored into the library index; the host page's save button checks the already-loaded library list for a matching `sourceUrl` right after a fresh playlist load and reuses that entry instead of saving again. Only applies right after loading a fresh URL — reloading a previously-saved playlist and re-saving still creates a new entry, matching the TODO's stated scope

## [0.13.1.2] — 2026-09-23

### Changed
- **Closed the "concurrent-placement integration test" TODO** (P2, open since `foamy-crafting-bonbon.md`): strengthened the existing two-concurrent-PLACE test to check exactly 2 `PLACEMENT_ACK`s (was checking "at least one"), and added a new test for two concurrent PLACEs at *different* positions confirming last-write-wins — `handlePlace` does no async work internally, so this is deterministic under the Durable Object's single-threaded model, not a genuine race, matching what the client's `pendingPlace` guard (v0.12.8.0) already assumes

## [0.13.1.1] — 2026-09-23

### Changed
- **ponytail-audit cleanup, round 2** (no behavior change): extracted `mapWithConcurrency` (`lib/utils.ts`) — the "window of `Promise.allSettled`" concurrency limiter was hand-rolled independently in `ai-metadata.ts`, `lyrics-resolver.ts`, and `lyrics-popularity.ts`; all three now call the one shared helper. Extracted `components/focus-editor-styles.ts` — the `navBtn`/field-box style objects were byte-identical between `SongItemEditor.tsx` and `LyricRoundItemEditor.tsx`; both now import the shared constants (the two components themselves stay separate — different data models and data flow, only the CSS was actually duplicated)
- **Marked T8 complete in TODOS.md** — it was still listed as open P2, but T3+T4 of `docs/designs/full-page-focus-editor.md` (v0.12.4.0/v0.12.5.0) already shipped exactly what it described

## [0.13.1.0] — 2026-09-23

### Fixed
- **Songs the AI couldn't auto-generate a Lyrics-mode question for were a dead end.** Real host feedback: the table and Focus editor both showed a plain "—" instead of an editable field for a song with no AI data (no lrclib.net hit, no confident memory), and asking AI to fill it in — "give me the full chorus" — silently did nothing, because `handleProposeLyricEdits` excluded exactly those songs from the request before it ever reached the AI. Both fixed: the table (`LyricsTable.tsx`) and Focus editor (`LyricRoundItemEditor.tsx`) now always show editable Question/Answer fields, so a host who already knows the song can type it in directly; Ask AI now includes every song in its request, with `PROPOSE_LYRIC_EDITS_SYSTEM_PROMPT` carrying the same "never invent lyrics you're not confident about" discipline the bulk generator already has, so this doesn't trade accuracy for coverage

## [0.13.0.1] — 2026-09-23

### Fixed
- **Lyrics mode's loading screen no longer says "查找發行年份中…" (searching for release year)** — that's Timeline-mode language; a Lyrics-mode host doesn't care about years. Now shows "解析歌曲資料中…" (resolving song info) / "仍在解析歌曲中…" for Lyrics mode, Timeline mode's copy unchanged

## [0.13.0.0] — 2026-09-23

### Added
- **Lyrics Mode's blank-selection is now grounded in a real popularity signal** (docs/designs/lyrics-question-search-grounding.md): before picking which line to blank, a dedicated single-purpose Anthropic call (`lib/lyrics-popularity.ts`) searches the web for which line of the song's chorus is actually most-cited by fans, and the result is injected as plain grounding text into the existing generation prompt — the generation call itself never gets search-tool access, so there's no ambiguity about whether a pick was actually grounded (Approach C from the design doc, chosen over letting the model decide mid-generation whether to search). Cached per-song in Durable Object storage (`lyrics-popularity:${videoId}`), same convention as `lyrics:`/`lyrics-sonnet:`, so repeat loads don't re-spend the search cost. Applies to the Sonnet re-resolve step for the actual game deck (not the cheaper Haiku bulk preview, to bound cost). Any fetch failure for a song falls back to today's ungrounded pick for that song only — never blocks the load. Validated by two spikes against the real `CPOP_SEED` catalog before implementation: both the model-directed and the deterministic-pre-fetch mechanisms changed 8/8 picks vs. today's baseline, and recovered 3 songs the baseline currently drops entirely on low AI confidence

## [0.12.10.0] — 2026-09-23

### Fixed
- **`next` upgraded 16.2.4 → 16.3.6, closing 7 CVEs including a critical DoS and 2 XSS advisories** — real production exposure, not dev-tooling. The prior vulnerability scan used `npm audit --omit=dev`, which hid this; a full `npm audit` surfaced it. Also fixed 2 pre-existing type errors in `party/index.test.ts` that `16.2.4`'s build typecheck silently ignored but `16.3.6`'s doesn't — without this, the upgrade would have started failing `next build` (and Vercel deploys) on unrelated test-file type errors
- **`ws` pinned to 8.21.0 via a package.json `overrides` entry**, closing 2 more advisories (uninitialized memory disclosure, memory-exhaustion DoS) in the `happy-dom`/`partykit` dependency tree
- Remaining 17 advisories confirmed dev/build-tooling only (`eslint-config-next`, `eslint`, `vitest`, `partykit`'s bundler) via `npm ls` per package — tracked in TODOS.md, not safely fixable without an upstream major-version bump

## [0.12.9.0] — 2026-09-23

### Changed
- **ponytail-audit cleanup** (no behavior change): extracted a shared `shuffle<T>()` (Fisher-Yates, `lib/utils.ts`) replacing 4 duplicated `.sort(() => Math.random() - 0.5)` inline shuffles in `party/index.ts`; `handleStartLyricsGame`'s inline `lyricOverrides` param type now imports `LyricOverride` from `lib/game.ts` instead of duplicating its shape; dropped `export` on 5 types never imported outside their own file (`ResolvedPlaylist`, `TrackMeta`, `UseItemDraft`, `YearSource`, `YouTubeTrack`)
- **Tracked 10 npm advisories in TODOS.md** (1 critical, 5 high, 4 moderate) — all in transitive `ws`/`undici` deps via `happy-dom` (test-only) and `partykit`'s bundled `miniflare` (local-dev simulator only), not the deployed Worker. Not force-fixed — `npm audit fix --force` wants to downgrade `partykit` to `0.0.0`, a bad resolver pick, not a real fix

## [0.12.8.0] — 2026-09-23

### Fixed
- **Closed a double-submit race on timeline card placement** (found by ad-hoc audit, same class of bug as T2's Lyrics-mode fix): `handlePlace()` had no local pending flag — `hasPlaced` only flipped true on the server's `PLACEMENT_ACK`, so a fast double-click/re-tap before that round trip completed could send a second `PLACE` at a different position, silently overwriting the first with no error shown. Added a `pendingPlace` flag set synchronously on click, reset on `PLACEMENT_ACK`, `ERROR`, `TOO_LATE`, or a fresh "guessing" phase — also adds the play page's first `ERROR` message handler, which didn't exist before

## [0.12.7.0] — 2026-09-23

### Added
- **`LyricRoundItemEditor.tsx` — the Focus editor's Lyrics-mode view** (T6 of docs/designs/full-page-focus-editor.md, the actual reason Approach B/full parity was chosen over timeline-only): a full-page, one-round-at-a-time view for an in-progress room's Lyrics setup, reached via a new "🎯 Focus mode" button next to the existing table. Reads the same `lyricsPreview` + `lyricOverrides` merge the table (T5) already uses, so both views always agree; manual edits go through `lib/use-item-draft.ts` (T1) as a reviewable draft, committed into the shared `lyricOverrides` on "Apply" — AI-proposed edits keep using the existing shared pipeline unchanged. Gated by `lyricsState === null` AND `!pendingLyricsStart` (T2's race-window flag) — not reachable once "Start Lyrics" has been clicked, matching the table going read-only at the same point. This completes the Focus editor's full parity across both game modes

## [0.12.6.0] — 2026-09-23

### Changed
- **Extracted `components/LyricsTable.tsx` from `host/page.tsx`** (T5 of docs/designs/full-page-focus-editor.md): pure extraction, byte-identical JSX, zero behavior change — `host/page.tsx` drops from 1109 to 1021 lines. Surfaced by the plan-eng-review's outside-voice pass (Lyrics mode had no componentization step going into an already-1000+-line file). Verified by the existing `host-page.test.tsx` suite (T2), which exercises this exact table's rendering path unchanged. This is the component the upcoming Lyrics Focus editor (T6) will sit alongside

## [0.12.5.0] — 2026-09-23

### Added
- **`SongItemEditor.tsx` — the Focus editor's timeline-mode view, on `/playlists`** (T4 of docs/designs/full-page-focus-editor.md, the headline feature): a full-page, one-song-at-a-time view — title/artist/year centered, a "✨ Ask AI" box wired to the new `PROPOSE_EDITS` HTTP action (T3), prev/next navigation with no wraparound at the boundaries. Entered via a new "🎯 Focus mode" button next to the existing table (only rendered when the playlist has songs, per D2); AI edits land as reviewable drafts via `lib/use-item-draft.ts` (T1), saved through the same `UPDATE_SONG` path `PlaylistEditor.tsx` already uses. Purely additive — the existing table is untouched and still the default view. Live-QA'd against a local PartyKit dev instance

## [0.12.4.0] — 2026-09-23

### Added
- **`PROPOSE_EDITS` HTTP action on `party/playlist.ts`** (T3 of docs/designs/full-page-focus-editor.md, closes T8): AI chat-to-diff editing for the standalone `/playlists` page, which has no WebSocket to route through. HTTP-shaped like the existing `RESOLVE_FROM_URL` action (blocking request/response), not WebSocket-shaped like `party/index.ts`'s room-based `handleProposeEdits` — both call the same `lib/ai-metadata.proposeEdits`. Returns a diff for the client to review; never mutates the stored playlist itself

## [0.12.3.0] — 2026-09-23

### Fixed
- **Closed the Lyrics-mode Start-Game race window** (T2 of docs/designs/full-page-focus-editor.md, found by the plan-eng-review's outside-voice pass): clicking "Start Lyrics" sent `START_LYRICS_GAME` with no local flag, unlike the timeline path's `setStarting(true)` — leaving a real window (the network round trip) where `lyricsState` was still `null` and the Ask-AI box and lyric fields incorrectly stayed live/editable. Added a `pendingLyricsStart` flag, set synchronously before the send and cleared on `LYRICS_STATE`/`ERROR`/`LYRICS_ABORTED`, gating the Ask-AI box's visibility and making the lyric fields read-only while a start is in flight. First direct unit tests for `host/page.tsx` (`app/__tests__/host-page.test.tsx`), covering this exact race

## [0.12.2.0] — 2026-09-23

### Changed
- **Extracted shared draft-tracking logic into `lib/use-item-draft.ts`** (T1 of docs/designs/full-page-focus-editor.md), generic over any item shape keyed by `videoId`. `PlaylistEditor.tsx` refactored onto it — confirmed zero behavior change via its existing 12-test suite. First step toward the Focus Mode editor redesign; also adds `docs/designs/full-page-focus-editor.md`, the approved and eng-reviewed design doc for that redesign

### Changed
- **Saved Playlists are now cross-device** (T6/T7 of docs/designs/decouple-quiz-bank.md, closing the P3 TODO from 2026-08-28): the room-setup page's "Saved Playlists" panel now reads from the same server-side library (`party/library.ts`) the new `/playlists` page uses, instead of that browser's own localStorage. A playlist created on one device — or on the standalone page — now shows up everywhere, immediately. Existing localStorage-only playlists migrate in automatically on first load after this update, silently and idempotently — nothing to click, nothing lost

### Added
- **Standalone quiz-bank page at `/playlists`** (T5 of docs/designs/decouple-quiz-bank.md): create and edit playlists ahead of time, with no room required — the headline feature the T1-T4 backend work was building toward. Paste a YouTube URL + name to create (using the room-less `RESOLVE_FROM_URL` action), see your library list from any device (via `party/library.ts`), edit songs manually (reuses the existing `PlaylistEditor` table), delete. AI chat-to-diff editing isn't wired up here yet (deferred to its own follow-up, T8) — manual editing only for now, matching what the room's editor already supported before v0.9.0.0

## [0.11.3.0] — 2026-09-22

### Added
- **Backend plumbing for the decoupled quiz bank** (T2-T4 of docs/designs/decouple-quiz-bank.md, no UI yet — that's the next PR): `party/playlist.ts` gained a `RESOLVE_FROM_URL` action so a playlist can be created from a YouTube URL without a room existing (calls the shared `lib/playlist-resolver.ts` pipeline from T1, blocking request/response since this party has no WebSocket to stream progress over). New `party/library.ts` — one Durable Object per host, indexing which playlists they own ({id, name, songCount}), so a host's playlist library will be visible from any device once the UI lands, not just the browser that created it. `party/playlist.ts` now keeps that index in sync server-side on playlist create/delete (best-effort — a sync failure never rolls back or fails the playlist write itself)

## [0.11.2.0] — 2026-09-22

### Fixed
- **`START_GAME`'s no-prior-`LOAD_PLAYLIST` fallback path now filters non-embeddable videos**, matching `LOAD_PLAYLIST`'s existing behavior — previously a non-embeddable video reaching this path would show a broken player mid-game with no diagnostic. Found during the T1 refactor below (docs/designs/decouple-quiz-bank.md, decision D3).

### Changed
- **Extracted the YouTube-fetch + AI-metadata-resolution pipeline into `lib/playlist-resolver.ts`**, shared by all 3 places that load a playlist (`LOAD_PLAYLIST`, `START_GAME`'s fallback, `START_LYRICS_GAME`) instead of 3 duplicated copies. Pure refactor otherwise — first step of decoupling quiz/playlist creation from room setup so a host can build a quiz library ahead of time (docs/designs/decouple-quiz-bank.md)

### Fixed
- **Lyrics preview no longer generates when the host is loading a playlist for timeline mode.** `LOAD_PLAYLIST` used to kick off lyrics question/answer generation unconditionally regardless of which mode the host had selected, spending real Anthropic calls on a mode the host might never play. The client now sends its current mode, and the server only generates a lyrics preview when it's `"lyrics"`

## [0.11.0.0] — 2026-09-22

### Added
- **AI chat-to-diff editing for Lyrics mode's question table.** Same pattern as the timeline mode's song editor (v0.9.0.0): the host can type a fix in plain language — "the 1st round's answer has a typo, it's 大雨滂沱" — and Claude proposes the change as a reviewable dirty row on the existing preview table, before it's ever applied. Covers `lyricContext` (the blanked-out lyric snippet) and `blankSentence` (the answer)

## [0.10.1.0] — 2026-09-22

### Fixed
- **Lyrics-mode answers are now server-authoritative.** Two spoofable trust gaps closed: the server now stamps each answer's submit time itself instead of trusting the client's `ts` (previously a player could claim max speed-bonus points or answer past the deadline for free by editing the outgoing message), and an answer is now only accepted from the WebSocket connection that actually JOINed/REJOINed as that `playerId` (previously any connection could submit an answer as any player, since player ids are visible in broadcast state)

## [0.10.0.0] — 2026-09-22

### Added
- **Cross-device host handoff.** After creating a room, the host can now continue setup from a second device — type the room code on the homepage (or scan the same join QR everyone else scans) and tap "或者：管理此房間 · Or: manage this room" to reach the setup screen. Guarded by a confirm dialog, since the claim is permanent for the room

### Fixed
- **The host's stale "manage as host" link no longer sits there after host is claimed elsewhere.** Once anyone claims host — including from a different device — the original creator tab's private link disappears instead of leading to a confusing "already has a host" error later

## [0.9.0.0] — 2026-09-22

### Added
- **AI chat-to-diff editing for the host's song table.** Instead of clicking into table cells, a host can now type a fix in plain language — "the 2nd song's year is wrong, it's 1970" — and Claude proposes the change as a reviewable dirty row, exactly like a manual edit, before it's ever applied. Matches the workaround hosts were already doing by hand (pasting the table into a separate chat model)

## [0.8.2.0] — 2026-09-22

### Fixed
- **Joining with a wrong room code led to a dead end.** The "waiting over 90 seconds? check your room code" warning has been there since the very first release, but it was just text — nothing to do about it. Now has a "返回首頁重新輸入 · Back to homepage" link right next to it

## [0.8.1.0] — 2026-09-22

### Fixed
- **Room creation could happen just by loading a page.** v0.8.0.0 made `/screen` generate a room the instant it loaded — fine for an offline/local-only game, wrong for a public site anyone can reach. The homepage now has an explicit "建立房間 · Create a Room" button (alongside the existing join form) and `/screen` is only ever reached by pressing it; the bare `/screen` landing route is gone

### Added
- **A joined-player list on `/screen`'s lobby.** Whoever's watching the TV now sees a chip (name + avatar-initial glyph) appear for each player as they join, instead of just a QR code and no other feedback

## [0.8.0.0] — 2026-09-22

### Changed
- **The big screen is now the front door.** Opening `/screen` on the TV or projector generates the room and shows a join QR code plus the room code right away — no more starting from the homepage. Players scan the code (or type it on the homepage) and only need to enter their name, no room name required
- **Host access is a private, same-device link.** Whoever loaded `/screen` on their device gets a "manage as host" link, shown only to them, only in the lobby — no secret code to type or broadcast. The homepage's old "Create a Room" button is gone; it's replaced by a small "Setting up the TV?" link to `/screen`

### Fixed
- The party server used to trust whichever connection claimed host *first* (`hostConnId`), which would have broken host access the moment `/screen` always connects before the host does. Host and screen claims now share one first-come, first-served rule, unaffected by connection order

## [0.7.0.0] — 2026-09-22

### Added
- **A guess-position marker.** After placing a card, everyone — including you — sees a "?" block right where you put it, on your own timeline and on the big screen, before the reveal confirms whether you were right
- **A winner celebration.** The big screen now shows confetti, a trophy, and victory music once the game ends

### Fixed
- A player joining mid-game and placing their very first card wouldn't get the new guess marker

## [0.6.3.0] — 2026-09-22

### Fixed
- **The big screen could silently lose Timeline mode's audio.** If `/screen` was opened after a round had already started, the song's video player could end up broken — no sound, no error, nothing visibly wrong. Fixed by loading songs into one persistent player instead of rebuilding it every round. Also added a one-tap "enable sound" prompt for the (common) case where the browser itself blocks autoplaying audio on a screen nobody has touched yet — Lyrics Mode already had this, Timeline mode didn't

## [0.6.2.0] — 2026-09-22

### Changed
- Internal cleanup: every hardcoded color across the app now references the shared design tokens instead of repeating the hex value — no visible change, but a future palette tweak is now a one-line edit instead of a grep-and-replace across 13 files

## [0.6.1.0] — 2026-09-22

### Fixed
- **Timeline mode no longer reveals the song's real video before the guess.** The full remaining deck and the current round both used to include the real YouTube video id in every update sent to players — a leftover from before the big screen split, and the same class of leak as the Lyrics Mode fix in the previous release. Only the host and the big screen (which plays it) get the real id now; players get nothing to look ahead with

## [0.6.0.0] — 2026-09-22

### Added
- **A big screen for TVs and projectors.** Opening `/room/<code>/screen` shows a read-only, room-distance-legible view of the game — the song, the timeline, the current lyric round with a giant countdown, scores, and results — separate from the host's phone. The host's own screen (`/room/<code>/host`) is now controls-only: buttons, the setup form, and a QR code that opens the big screen
- **DESIGN.md**, documenting the app's existing visual system for the first time and the new screen's design decisions

### Fixed
- **The review step no longer leaks the answer deck.** Before confirming a Lyrics game, the full deck (with answers) used to go to every connected client, including players — both on the initial broadcast and, separately, to anyone who joined or reconnected mid-review. Now only the host and the big screen ever receive it
- Player names and song info were unreadable on the new big screen (white text left over from an older dark background) — fixed to match the rest of the app
- A lost connection could silently stop the big screen (and the host, for Lyrics answers) from getting updates; one dead connection no longer blocks delivery to everyone else

### Changed
- Lyrics Mode's audio now plays from the big screen instead of the host's own phone

## [0.5.1.0] — 2026-09-21

### Fixed
- **A bad video id can no longer crash the host page.** YouTube's player throws for a malformed video id (for example in a hand-made saved playlist). In Timeline mode that used to take down the whole host screen in round 2 ("This page couldn't load"). Now the round simply runs without audio, and Lyrics Mode shows its "can't play" notice
- The song data table now labels songs with a hand-entered year as "manual" instead of leaving the source blank

### Removed
- The retired Spotify, iTunes, Google Knowledge Graph and YT Music year-lookup code (about 950 lines with tests). The AI metadata resolver replaced it in v0.2.0 and nothing used it
- The host page's Spotify and Knowledge Graph warnings, which could never appear, and the unused `/room/:code/lobby` page (players join at `/play`)
- Leftover starter images, an unused helper, unused message types and constants, and two unused dev dependencies

### Changed
- A misleading error hint no longer claims a missing Anthropic key causes "API key not configured"

## [0.5.0.0] — 2026-09-21

### Added
- **Lyrics Mode now plays the song.** The host's screen plays each round's song automatically, the ✂️ Cut button pauses it so players can fill in the next line, and the song resumes on the results screen. The video stays hidden so lyric videos can't reveal the answer on a shared screen
- If a song can't be played (embedding blocked, video removed), the host sees a notice instead of a silent round
- If the browser blocks autoplay, a clear "Click to play" banner appears at the bottom of the host's screen

### Changed
- During a round, players' phones no longer receive the current song's video id, so a curious player can't open the video and read the lyrics. The host asks the server for it separately. (The pre-game review step still sends the whole deck to everyone; tracked in TODOS.md)
- The Timeline and Lyrics players now share one YouTube loader, which fixes the two overwriting each other's setup

### Fixed
- A repeated song (for example after Play Again) restarts instead of resuming mid-song

## [0.4.2.1] — 2026-09-21

### Fixed
- **Lyrics Mode: late answers no longer look accepted.** After the countdown hits 0 the answer box is replaced by "⏰ 時間到 · Time's up!" instead of letting a player submit an answer that scores nothing while showing "Submitted!"
- **Lyrics Mode: Play Again works for everyone.** When the host starts over, players go back to the waiting lobby instead of staying on the WINNER screen, including players whose connection dropped and came back
- **Lyrics Mode: a malformed answer can no longer break scoring.** Answers with a missing or non-numeric timestamp, or non-text content, are ignored instead of turning a player's score into NaN

- **Production build works again.** `next build` was failing a type check on the test-seed playlists (`hitster://test`, `hitster://cpop-test`), which would block any deploy from `main`

### Added
- Component tests for the player screen (late answers, "Time's up", Play Again) and a test setup for `app/` components

## [0.4.2] — 2026-09-21

### Fixed
- **Lyrics Mode start no longer hangs or silently fails**
  - Sonnet 5 hidden thinking could use the whole `max_tokens` budget and return no text, yielding zero questions. Thinking is now disabled and `max_tokens` raised to 4000 (about 3x faster)
  - `hitster://cpop-test` loaded 20 fake songs in `LOAD_PLAYLIST`; it now loads the real 8-song C-pop seed (shared `CPOP_SEED`)
  - A failed Start Lyrics left the "preparing lyrics" spinner up forever. New `LYRICS_ABORTED` message clears it on host and players; host shows the error banner
- **Playable questions**
  - `lyricContext` must contain a blank (repaired from the answer, or the song is dropped) so the answer is never shown to players
  - Blank length now matches the answer (one `_` per letter/character, punctuation ignored)
  - Simplified Chinese is rejected for zh-TW output; Claude is told to convert Simplified lrclib lyrics to Traditional
  - CJK blanks must be 2-6 characters
- **Host layout** — lobby setup is hidden during the lyrics game so each screen stands alone; question card is centered and larger

## [0.4.1] — 2026-09-17

### Added
- **Real lyrics grounding for Lyrics Mode** — `lib/lyrics-fetcher.ts` fetches plain-text lyrics from [lrclib.net](https://lrclib.net) (free, no API key) before sending tracks to Claude
  - Tries `/api/get` (exact match) first; falls back to `/api/search` with scored ranking
  - Scored matching: title exact +4, partial +2; artist exact +3, partial +1; lyrics present +2; requires ≥3 and at least a partial title match
  - Batch-fetches up to 8 tracks in parallel with `fetchLyricsBatch()`
  - `resolveLyricsForTracks` injects `LYRICS:` blocks for hits (truncated to 1500 chars), `NO_LYRICS` marker for misses
  - Claude is instructed to use ONLY the supplied lyrics for hits; falls back to memory for misses

### Fixed
- Sanitize `---` lines in injected lyrics to prevent prompt block separator corruption
- Require partial title match in `matchScore` to prevent wrong-song lyrics from being injected as ground truth
- Add null guard in `norm()` for missing `trackName`/`artistName` fields from unvalidated lrclib JSON
- Change unknown language fallback from `zh-TW` to `en`

## [0.4.0.0] — 2026-09-17

### Added
- **Lyrics Mode** — new game mode where players fill in a blanked-out chorus phrase for the currently playing song
  - Two-phase AI generation: Claude Haiku (bulk preview of all songs) then Claude Sonnet (re-resolves the final game deck for quality)
  - Progressive preview screen lets the host review and edit every Question/Answer before starting
  - `CONFIRM_LYRICS_PREVIEW` message lets host lock in the deck with optional per-song overrides (`lyricContext`, `blankSentence`)
  - Fuzzy matching mode (Levenshtein distance) allows tolerant answers when enabled by host
  - DO storage caches Haiku results under `lyrics:<videoId>` and Sonnet results under `lyrics-sonnet:<videoId>` — repeat loads skip the API
  - Host UI: mode picker (Timeline / Lyrics), editable preview table, timer/round config sliders, live countdown, per-player scores, round results table
  - Player UI: text input with auto-submit, countdown ring, correct/incorrect result reveal
  - Game phases: `lobby → loading → preview → playing → guessing → results → ended`
  - 86 Vitest tests covering the full state machine, cache paths, fuzzy matching, and edge cases
- **`EditableSong.year` now nullable** — songs without a confirmed year can be loaded and edited; `isValidYear` and the PlaylistEditor year input handle `null` gracefully

### Changed
- `resolveLyricsForTracks` accepts optional `model` parameter; defaults to `claude-haiku-4-5-20251001` (bulk) but callers can pass `claude-sonnet-5` for the game deck
- `max_tokens` increased from 1200 → 2000 for the Anthropic lyrics call (couplet format requires more tokens)
- Lyrics system prompt rewritten for couplet format: two-line context with a phrase blanked, not a full line
- Host page header player-count label visible on all screen sizes (removed `.hide-xs`)
- Skip-embedding warning copy updated to clarify it is a YouTube rights restriction, not an API key issue

### Fixed
- PlaylistEditor year field renders blank (not `0`) when year is null; color goes grey for absent years

## [0.3.0.0] — 2026-09-16

### Changed
- **Complete UI redesign** — warm cream palette (`#FFF9F5` background, `#FF6B35` orange accent) replaces the dark theme across all pages
- **Chinese-first interface** — join form, error messages, and in-game prompts are now in Traditional Chinese (繁體中文); Create a Room button and key labels keep English fallback for international hosts
- **Landing page** — vinyl record hero with sparkle animation; join and create controls merged into one card layout; mobile-optimised at 390px+
- **Host page** — new room-code chip with orange mono font; playlist load/status panel redesigned with progress bar and mint-green ready state
- **Player timeline** — horizontal scrollable layout with orange drop-zones (pulse animation); "Now Playing" card redesigned; spectator notice shows active player name
- **Winner and game-over screens** — dedicated WINNER! heading and full-page celebration state
- **PlayerList** — score badges, active-player highlight chip, and turn-order indicators
- **e2e test suite updated** — all 30 Playwright tests (Chromium + Mobile Safari) updated to match the new Chinese-language selectors; dev server port standardised to 3456

### Fixed
- Room-code input no longer overflows its card container on narrow viewports (`minWidth: 0` on flex child)
- Join button and input row alignment fixed on mobile (flex `alignSelf: stretch`)
- Host page header chip uses cream background to match the light theme
- Drop-zone button `transition` now targets only `border-color, background` instead of `all`
- Host page header: player count label hidden below 480 px via `.hide-xs` utility class — no more cramped header on 375 px phones
- 404 page now uses the app's warm palette (`app/not-found.tsx`): vinyl-record graphic, 找不到這個頁面 heading, orange "回首頁 · Home" button — replaces the default Next.js white 404

## [0.2.0.0] — 2026-09-02

### Added
- **AI metadata resolver** (`lib/ai-metadata.ts`) — replaces the 5-layer YTM/Spotify/iTunes/KG pipeline with a single Claude Haiku call per batch of 10 tracks; returns clean title, primary artist, and release year with CJK support; fails open (no year returned rather than blocking load)
- **Durable Object metadata cache** — resolved AI results are stored under `aiMeta:<videoId>` keys in DO storage; repeat playlist loads skip the Anthropic API for already-seen videos, making re-loads near-instant and cutting AI spend proportionally
- **Custom playlist library** — hosts can save any YouTube playlist to a per-device library, load it again in future sessions without re-fetching from YouTube/Spotify, and share it to a new device by pasting the playlist ID
- **Inline song editor** — after loading a playlist, hosts can correct song titles, artists, and years directly in the UI; edits are persisted in the playlist party and survive page reloads
- **Saved playlist management** — hosts can delete playlists from the library; deletes are confirmed with the server before the local index is updated

### Changed
- **Spotify pre-pass is now sequential** with longer Retry-After back-off to avoid rate limiting on large playlists
- **Year resolution pipeline** now applies host-edited overrides from the playlist party when starting a game from a saved playlist

### Fixed
- Non-embeddable YouTube videos are now filtered out at playlist upload time, so they never reach the AI resolver or appear as dead tracks in the game
- Abort checkpoint (`ABORT_LOAD`) now builds its song list directly from `aiResults + metas` instead of reading `pendingPlaylist`, which could be `null` when abort arrives before the first batch callback fires — tracks with description/title years or cache hits are no longer silently dropped on abort
- "AI" yearSource badge now appears in the host diagnostic table (previously the column was blank for AI-resolved tracks)
- Concurrent `LOAD_PLAYLIST` calls no longer race — a generation counter (`loadSeq`) ensures only the latest request writes state; superseded loads exit silently
- Host identity is now bound to the first WebSocket connection (`hostConnId`); a second connection cannot steal the host role by racing a `LOAD_PLAYLIST` or `START_GAME` message
- Song years are now stripped from the broadcast state during the guessing phase (`sanitizedState`), preventing players from inspecting WebSocket frames to learn answers
- `playerId` values are validated as UUIDs on `JOIN`, `REJOIN`, and `PLACE` handlers; non-UUID keys are silently rejected
- `DELETE_SONG` in the playlist party now enforces a minimum of 2 songs; deleting the second-to-last song returns a 400 error instead of leaving the playlist in an unloadable state
- Loading a saved playlist by ID now validates the ID is a UUID before making the fetch, preventing path traversal to other PartyKit routes
- Deleting a saved playlist no longer removes it from the local library index when the server-side DELETE fails
- `WRONG_PHASE` error key renamed to `TOO_LATE` to match client expectations for late placements
- YouTube overlay opacity reduced to 10% visible to comply with YouTube Terms of Service

### Changed
- Lobby now shows a yellow warning banner after 90 seconds with no host, prompting players to double-check their room code (ISSUE-001)

## [0.1.0.0] — 2026-08-28

### Added
- Initial scaffold for HITSTER! Online — fan-made web version of the HITSTER! board game
- **PartyKit game server** (`party/index.ts`): full state machine (`lobby → guessing → reveal → ended`), host validation via UUID stored in localStorage, placement evaluation with same-year edge case, 90-second round auto-timeout, player reconnection via `REJOIN`, `RESET_GAME` flow
- **5-layer year resolution pipeline**: YouTube Music description → title extract → YouTube Music InnerTube search (`lib/ytmusic.ts`, no API key) → Spotify Web API → iTunes Search API → Google Knowledge Graph
- **YouTube Music InnerTube client** (`lib/ytmusic.ts`): unofficial YTM API, batched parallel lookups (5 tracks/batch), album year extraction from browse endpoint
- **Spotify Web API client** (`lib/spotify.ts`): client-credentials token flow, release year lookup, returns clean `{ year, title, artist }` — replaces raw YouTube video titles with proper track names
- **iTunes Search API client** (`lib/itunes.ts`): free, no API key, CJK-aware (Taiwan store first for Mandarin/Cantonese pop), artist ratio guard to avoid false matches, returns clean `{ year, title, artist }`
- **YouTube Data API v3 client** (`lib/youtube.ts`): fetches playlist items with pagination (up to 200), C-pop title format support (`【Track】`, `《Track》`, mixed CJK/Latin artist names)
- **Shared game types and logic** (`lib/game.ts`): `isCorrectPlacement`, `evaluateRound`, `checkWinner`, `generateRoomCode`, `extractPlaylistId`
- **Host screen** (`app/room/[code]/host/page.tsx`, `components/MusicPlayer.tsx`, `components/PlayerList.tsx`): YouTube IFrame player with CSS waveform overlay during guessing, song reveal on button click, live diagnostic progress during loading, Spotify/KG error banners, Abort Load control
- **Player controller** (`app/room/[code]/play/page.tsx`, `components/Timeline.tsx`): vertical scrollable timeline with drop-zone buttons, phase-aware state reset on new rounds
- **Landing page** (`app/page.tsx`): create room (host) / join by 4-letter code (player)
- **Lobby page** (`app/room/[code]/lobby/page.tsx`): waiting room with live player list, auto-redirects when host starts
- **Test suite** (125 tests): `lib/game.test.ts`, `lib/youtube.test.ts`, `lib/spotify.test.ts`, `lib/itunes.test.ts`, `lib/ytmusic.test.ts`, `party/index.test.ts`
- **Playwright E2E**: two-player full-round game test (`e2e/two-player-game.spec.ts`), C-pop multiplayer test (`e2e/cpop-multiplayer.spec.ts`), landing/lobby smoke tests
- **PWA manifest** (`public/manifest.json`): icons, theme colour, no service worker (v1)

### Performance
- Live diagnostic progress: host sees song list with years filling in as each API pass completes
- Abort Load: host can stop mid-load and use partial results (≥2 songs) to start immediately
- Spotify rate-limit aware: short-circuits when rate-limited, caps Retry-After at 3s
- iTunes calls parallelized within each batch; Taiwan store tried first for CJK content

### Security
- `hostId` stripped from broadcast state — players can no longer read the host secret from WebSocket frames
- `ABORT_LOAD` now validates host identity before setting the abort flag
- Float position input rejected (`Number.isInteger` guard prevents placement cheat via crafted WebSocket message)
- Year bounds enforced (1900–now+1) in all year-resolution sources to prevent timeline corruption
- Player names sanitized server-side (max 20 chars, HTML special chars stripped)
- `env.example` uses placeholder values — never commit real credentials
- Playlist ID validated against allowlist pattern before YouTube API call
- Previously leaked API credentials rotated

### Known limitations (TODOS.md)
- YouTube overlay is fully opaque; blurred thumbnail under overlay (YouTube ToS) is deferred
- Late-placement error key is `WRONG_PHASE` rather than `too_late` as originally planned
- `currentSong.year` is included in guessing-phase broadcast (cheatable via devtools)
- `hostId` first-write-wins; `playerId` from client body — deferred for private party use

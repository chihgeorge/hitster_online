# Changelog

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

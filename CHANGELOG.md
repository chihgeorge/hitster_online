# Changelog

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

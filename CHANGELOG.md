# Changelog

## [0.1.0] — 2026-08-28

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

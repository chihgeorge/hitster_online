# Changelog

## [0.1.0] — 2026-05-22

### Added
- Initial scaffold for HITSTER! Online — fan-made web version of the HITSTER! board game
- **PartyKit game server** (`party/index.ts`): full state machine (`lobby → guessing → reveal → ended`), host validation via UUID stored in localStorage, placement evaluation with same-year edge case, 90-second round auto-timeout, player reconnection via `REJOIN`
- **YouTube Data API v3 client** (`lib/youtube.ts`): fetches playlist items with pagination (up to 200), 4-layer year resolution (YouTube Music description → title extract → Spotify API → null skip), `parseArtistAndTrack`, `parseYouTubeMusicDescription`, `channelToArtist`, `extractYearFromTitle`
- **Spotify Web API client** (`lib/spotify.ts`): client-credentials token flow, release year lookup with `artist+track` → track-only fallback, prefers singles/albums over compilations, parallel resolution via `Promise.allSettled`
- **Shared game types and logic** (`lib/game.ts`): `isCorrectPlacement`, `evaluateRound`, `checkWinner`, `generateRoomCode`, `extractPlaylistId`
- **Host screen** (`app/room/[code]/host/page.tsx`, `components/MusicPlayer.tsx`, `components/PlayerList.tsx`): YouTube IFrame player with CSS waveform overlay during guessing, song reveal on button click, live player status with card counts
- **Player controller** (`app/room/[code]/play/page.tsx`, `components/Timeline.tsx`): vertical scrollable timeline with drop-zone buttons, `Place here →` CTA, phase-aware state reset on new rounds
- **Landing page** (`app/page.tsx`): create room (host) / join by 4-letter code (player)
- **Lobby page** (`app/room/[code]/lobby/page.tsx`): waiting room with live player list, auto-redirects when host starts
- **Test suite** (89 tests, 88% coverage): `lib/game.test.ts`, `lib/youtube.test.ts`, `lib/spotify.test.ts`, `party/index.test.ts`
- **Playwright E2E**: landing, lobby, and mobile Safari (iPhone 12) viewport smoke tests
- **PWA manifest** (`public/manifest.json`): icons, theme colour, no service worker (v1)

### Security
- Player names sanitized server-side (max 20 chars, HTML special chars stripped)
- Host identity stored as `crypto.randomUUID()` in localStorage — sufficient for party-game use
- `env.example` uses placeholder values — never commit real credentials

### Known limitations (TODOS.md)
- YouTube overlay is fully opaque; blurred thumbnail under overlay (YouTube ToS) is deferred
- No full-round E2E test (host + player completing a round)
- Late-placement error key is `WRONG_PHASE` rather than `too_late` as originally planned

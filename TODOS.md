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

## P2 — Ship before public launch

- [x] **P2** Full-round E2E test (host + player completing a game round)  
  Completed: `e2e/two-player-game.spec.ts` covers 3-round turn-based game with Alice + Bob, testing guessing, spectating, reveal, and win condition.

- [ ] **P2** Concurrent-placement integration test  
  The party server's `handlePlace` doesn't race, but a test with two `PLACE` messages arriving within the same tick would confirm `placements[playerId]` is set correctly and `PLACEMENT_ACK` is sent to both.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [x] **P2** Invalid room code silently creates orphaned waiting room  
  Fixed by /qa on feat/initial-scaffold, 2026-08-28 — commit ed7449a. Shows yellow warning banner after 90s: "Still waiting after 90 seconds — double-check your room code."

## P3 — Nice to have

- [ ] **P3** Cross-device playlist library listing  
  Per-playlist DOs keyed by UUID make individual playlists cross-device accessible via URL, but the full library listing comes from localStorage — empty on a new device. Fix: add a host-library DO (keyed by hostId) that stores the playlist index so the full library is visible from any device.  
  _Surfaced by /plan-eng-review on feat/custom-playlist, 2026-08-28_

- [ ] **P3** `docs/wireframes/hitster-v1.png`  
  The initial wireframe sketch was never committed. Low priority — the code is the spec now.  
  _Deferred from plan: foamy-crafting-bonbon.md_

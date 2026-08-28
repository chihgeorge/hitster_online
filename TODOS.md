# TODOS

## P1 — Pre-launch blockers

- [ ] **P1** `WRONG_PHASE` vs `too_late` error key mismatch  
  The plan specified `{ error: 'too_late' }` for late placements after REVEAL, but `party/index.ts` returns `{ type: 'WRONG_PHASE' }`. If client code inspects the error key, this will fail silently. Either rename to `{ type: 'ERROR', error: 'too_late' }` or update all client references.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P1** YouTube overlay blocks blurred thumbnail (potential ToS issue)  
  The guessing-phase overlay uses `bg-[#1a1a2e]/95 backdrop-blur-sm` — fully opaque. The plan specified a blurred thumbnail visible at ~10% opacity under the overlay to satisfy YouTube ToS. Verify whether ToS requires any visible portion of the video, and if so, add `<img src={thumbnail} className="absolute inset-0 opacity-10 object-cover" />` behind the overlay.  
  _Deferred from plan: foamy-crafting-bonbon.md_

## Pre-launch security

- [x] **CRITICAL** Rotate leaked API credentials  
  YouTube API key + Spotify client ID/secret were committed to git history. Credentials have been rotated.

## P2 — Ship before public launch

- [ ] **P2** Strip future song years from broadcast state (security/fairness)  
  `broadcastState()` sends the full `songs: Card[]` array including `year` for every remaining card. Players reading WebSocket messages can see all future songs. Fix: strip `year` from `songs` in the broadcast payload (keep year on `currentSong` for reveal).

- [ ] **P2** hostId first-write-wins is vulnerable to takeover  
  Any client sending `START_GAME` before the real host claims permanent host role. Fine for party game in private settings; needs a shared-secret mechanism or invite flow before public launch.

- [ ] **P2** playerId comes from client message body, not server-side connection identity  
  `handlePlace` trusts `msg.playerId`. A malicious client can send any playerId. Low impact with turn-based rules (only the active player's placement matters), but should bind playerId to connection on JOIN.



- [x] **P2** Full-round E2E test (host + player completing a game round)  
  Completed: `e2e/two-player-game.spec.ts` covers 3-round turn-based game with Alice + Bob, testing guessing, spectating, reveal, and win condition.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P2** Concurrent-placement integration test  
  The party server's `handlePlace` doesn't race, but a test with two `PLACE` messages arriving within the same tick would confirm `placements[playerId]` is set correctly and `PLACEMENT_ACK` is sent to both.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P2** Strip `year` from `currentSong` during guessing phase in broadcast  
  `broadcastState()` sends the full `Card` for `currentSong`, including `year`. Players watching WebSocket traffic can read the answer before placing. Fix: omit `year` from `currentSong` in the STATE broadcast during `"guessing"` phase; restore it on `"reveal"`.

- [ ] **P2** Concurrent `LOAD_PLAYLIST` causes non-deterministic `pendingPlaylist` state  
  Two rapid `LOAD_PLAYLIST` requests from the same host run concurrently; whichever resolves last wins and may produce a mixed result. Fix: assign a sequence number per load; at every write to `pendingPlaylist`, guard with a sequence check, or cancel the previous in-flight load.

- [ ] **P2** Validate `playerId` format to prevent prototype-pollution-adjacent keys  
  `handleJoin` stores `playerId` directly as an object key with no format check. Restrict to UUID format (`/^[0-9a-f]{8}-[0-9a-f]{4}-...-[0-9a-f]{12}$/i`) and reject on mismatch.

## P3 — Nice to have

- [ ] **P3** `docs/wireframes/hitster-v1.png`  
  The initial wireframe sketch was never committed. Low priority — the code is the spec now.  
  _Deferred from plan: foamy-crafting-bonbon.md_

# TODOS

## P1 — Pre-launch blockers

- [ ] **P1** `WRONG_PHASE` vs `too_late` error key mismatch  
  The plan specified `{ error: 'too_late' }` for late placements after REVEAL, but `party/index.ts` returns `{ type: 'WRONG_PHASE' }`. If client code inspects the error key, this will fail silently. Either rename to `{ type: 'ERROR', error: 'too_late' }` or update all client references.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P1** YouTube overlay blocks blurred thumbnail (potential ToS issue)  
  The guessing-phase overlay uses `bg-[#1a1a2e]/95 backdrop-blur-sm` — fully opaque. The plan specified a blurred thumbnail visible at ~10% opacity under the overlay to satisfy YouTube ToS. Verify whether ToS requires any visible portion of the video, and if so, add `<img src={thumbnail} className="absolute inset-0 opacity-10 object-cover" />` behind the overlay.  
  _Deferred from plan: foamy-crafting-bonbon.md_

## P2 — Ship before public launch

- [ ] **P2** Full-round E2E test (host + player completing a game round)  
  `e2e/game.spec.ts` covers landing and lobby. Still needed: multi-context test that opens host view in one browser context and player view in another, plays through a full guessing→reveal→next-round cycle, and asserts the correct score update.  
  _Deferred from plan: foamy-crafting-bonbon.md_

- [ ] **P2** Concurrent-placement integration test  
  The party server's `handlePlace` doesn't race, but a test with two `PLACE` messages arriving within the same tick would confirm `placements[playerId]` is set correctly and `PLACEMENT_ACK` is sent to both.  
  _Deferred from plan: foamy-crafting-bonbon.md_

## P3 — Nice to have

- [ ] **P3** `docs/wireframes/hitster-v1.png`  
  The initial wireframe sketch was never committed. Low priority — the code is the spec now.  
  _Deferred from plan: foamy-crafting-bonbon.md_

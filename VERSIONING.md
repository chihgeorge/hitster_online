# Versioning

HITSTER! Online uses a four-part version: **MAJOR.MINOR.PATCH.BUILD**

Current version: see [VERSION](VERSION)

---

## What each segment means

| Segment | Bumps when… | Examples |
|---------|-------------|---------|
| **MAJOR** | A breaking protocol change — existing clients can no longer connect without a reload/update | Renaming WebSocket message types, restructuring `GameState`, removing a supported game phase |
| **MINOR** | A new user-visible feature lands | New game mode, new API source (e.g. MusicBrainz), new screen (scoreboard, replay), multiplayer chat |
| **PATCH** | A bug fix or small UX improvement with no new feature | Fix a wrong error message, fix a layout glitch, fix a race condition |
| **BUILD** | Internal-only change — nothing the player can see or feel | Dependency update, test added, CI config, refactor, docs |

Rules:
- When MAJOR bumps → reset MINOR, PATCH, BUILD to 0
- When MINOR bumps → reset PATCH, BUILD to 0
- When PATCH bumps → reset BUILD to 0
- BUILD never resets on its own; it just increments

---

## How to bump

`/ship` does all of this on the feature branch; by hand it is:

1. **Edit `VERSION`** — single line, e.g. `0.2.0.0`
2. **Sync `package.json` and `package-lock.json`** — npm takes the first three parts, so `0.14.15.1` becomes `0.14.15`
3. **Add a section to `CHANGELOG.md`** — `## [X.Y.Z.B] — YYYY-MM-DD`, version matches VERSION exactly
4. **Commit and open the PR** — the PR title starts with the version, e.g. `v0.14.15.1 fix: …`; the squash merge keeps that as the commit on `main`

No git tags: the version-prefixed squash commit on `main` is the release marker.

---

## Examples

| Change | Before | After |
|--------|--------|-------|
| Add a spectator mode | 0.1.0.0 | 0.2.0.0 |
| Fix the 90s lobby warning not clearing on rejoin | 0.1.0.0 | 0.1.1.0 |
| Add a unit test for `isCorrectPlacement` edge case | 0.1.0.0 | 0.1.0.1 |
| Rename `WRONG_PHASE` → `TOO_LATE` in the WebSocket protocol | 0.1.0.0 | 1.0.0.0 |

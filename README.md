# HITSTER! Online

A web-based music trivia game inspired by HITSTER!. Players listen to song snippets and race to arrange them in a chronological timeline to see who truly knows their music history.

Live: [hitsteronline.vercel.app](https://hitsteronline.vercel.app)

## Features

- **Host** loads a YouTube playlist; the app resolves song titles, artists, and release years via Claude Haiku (AI metadata) with a Durable Object cache — repeat loads are near-instant
- **Players** join by room code and drag songs into a chronological timeline on their phones
- **Chinese-first UI** — join form, error messages, and in-game prompts in Traditional Chinese (繁體中文) with English fallback
- **Saved playlists** — hosts can save and reload playlists without re-fetching; inline song editor lets them correct titles, artists, and years
- **Big screen** — `/room/<code>/screen` is a read-only, room-distance-legible view for a TV or projector: the song, timeline, lyric round with countdown, scores, and results. The host's own page (`/room/<code>/host`) is controls-only, with a QR code that opens the big screen
- **Lyrics Mode** — the big screen plays each song (hidden YouTube video, so lyric videos can't spoil answers); players fill in the missing line. Autoplay starts each round, ✂️ Cut pauses it, and the song resumes on the results screen. Players never receive the current round's video id
- **Guess-position marker** — after placing a card, a "?" block shows exactly where it landed on your own timeline and on the big screen's player list, for everyone to see before the reveal confirms it
- **Winner celebration** — the big screen breaks into confetti, a trophy, and victory music once the game ends
- **Real-time** via PartyKit WebSocket: all players see live state, scores, and turn order

## Tech stack

- Next.js 16 (App Router, TypeScript)
- PartyKit (WebSocket game server)
- Cloudflare Workers + Durable Objects (playlist cache, AI metadata cache)
- Claude Haiku (year/title/artist resolution)
- Playwright (e2e, Chromium + Mobile Safari)
- Vitest (unit tests)

## Development

```bash
# Install dependencies
npm install

# Start Next.js dev server (always use port 3456)
PORT=3456 npm run dev:next

# Start PartyKit server (separate terminal)
npm run dev:party
```

`.env.local` is required for the Next.js server. Copy `env.example` and fill in real values (never commit `.env.local`).

`.dev.vars` is required for the PartyKit server. Never commit it.

## Testing

```bash
# Unit + component tests (Vitest: lib/, party/, app/**/*.test.tsx, and components/**/*.test.tsx)
npm test

# e2e tests (Playwright — auto-starts dev server if not already running)
npm run test:e2e
```

## Deployment

Deployed to Vercel (Next.js) + PartyKit cloud. See `.partykit/` and `vercel.json` for config.

---

# Legal Disclaimer
This project is a non-commercial, fan-made web application inspired by the board game HITSTER!, published by Jumbo / Helvetiq. All rights to the original game mechanics, branding, and name belong to their respective owners. This application is not affiliated with, endorsed by, or sponsored by the official creators of HITSTER!.

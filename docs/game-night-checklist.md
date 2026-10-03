# Game-night checklist

The checks only a real TV, real phones and real players can do. The automated suites (`npm test`, `npm run test:e2e`) cover the rest. Each check below closes or updates one item in [TODOS.md](../TODOS.md); write what you saw there.

Needs: a TV with a browser (or a laptop on HDMI), 2+ phones with LINE installed, a Lyrics playlist, about 30 minutes before guests arrive.

## Before guests arrive (about 20 min)

1. **LINE in-app browser (throwaway room).** Send yourself https://hitsteronline.vercel.app in LINE and open it *inside* LINE (not "open in Safari/Chrome"). Tap Create a Room, then "Manage as host", then the "📺 在電視掃描，或點此開啟大螢幕" card. Repeat in Instagram/Facebook if you have them.
   Pass: a screen tab opens, and a second tap reuses it. Fail: the tap does nothing. Note the app and OS. → TODOS "Check the screen link inside LINE / Instagram / Facebook in-app browsers"
2. **Real room on the TV.** On the TV's browser, open the site and tap Create a Room: that browser is now the room's TV. On your phone, type the room code on the home page and tap "或者：管理此房間 · Or: manage this room".
   Pass: the TV shows the QR code, and your phone shows the host setup.
3. **Play one Guess round, judging from the couch.** Load any playlist in 🎧 Guess mode, start, play a round, Show Results.
   Pass: the reveal video is sharp from the couch and its corners are rounded. Fail: blurry (240p-360p look) or square corners. Note the TV model and browser. → TODOS "Check the Guess reveal video's sharpness on a real TV"
4. **Run a Lyrics game with a second phone joined.** Load a Chinese pop playlist (or `hitster://cpop-test`) in Lyrics mode, join from a second phone, tap Start Lyrics, check the lyric preview, then tap "▶ 開始遊戲 · Start Game".
   Pass: rounds load with real lyric lines, and the TV plays the song. Fail: "AI 正在準備歌詞…" hangs, or the blanks look wrong. Then run `npx partykit tail` and look for `[lyrics-resolver] lrclib hits: N/8`. → TODOS "E2E: verify lrclib → Claude pipeline with a real player in the room"

## During the game

5. **Note every Guess answer that felt wrongly graded.** Write the answer typed, the real title or artist, and whether it was marked right or wrong. Two or three examples are enough. → TODOS "Guess grading tuning after playtest"
6. **If the game freezes or everyone drops,** reload the host page first. If the room is gone, that's the known in-memory room-state limit. Note the time so it can be matched against PartyKit logs. → TODOS "Room state is in memory only"

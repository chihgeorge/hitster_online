# 公開 repo 的檢查清單

`chihgeorge/hitster_online` 早就是 public。2026-10-29 照 `critical-answer` 公開前的步驟（它的 `docs/going-public.md`）補查一次，缺的設定同一天補上。

狀態：✅ 已完成　🙋 要你決定　⚙️ 要你在 Google Cloud／Vercel 設定裡做

## 密鑰

- ⚙️ **舊的 YouTube API key 還在公開的歷史裡。** 2026-05 有一把真的 key 曾被寫進 `env.example`，之後已經拿掉，但 GitHub 永遠保留舊 PR 的 ref，所以那個 commit 還拿得到。要到 Google Cloud Console 把那把 key 刪掉或換掉。想連 commit 一起清掉，只能請 GitHub Support 刪那個 PR 的 ref。
- ✅ **現在用的密鑰不在歷史裡。** 拿 `.env.local` 的實際值（YouTube、Anthropic）和 Cloudflare 帳號 ID 去比對所有分支和全部 `refs/pull/*`：0 筆。
- ✅ **Spotify client ID** 在舊版 `env.example` 裡。client ID 本來就會送到瀏覽器，不是密鑰；client secret 從來沒進過歷史。
- ✅ **沒有 `.env*` 檔案曾經被 commit 過**（刪掉的檔案也查了）。`.gitignore` 擋住 `.env*`、`.dev.vars`、`.wrangler/`。
- ✅ 正式環境的 `YOUTUBE_API_KEY`、`ANTHROPIC_API_KEY`、`PAID_DAILY_CAP` 是 Cloudflare secret，不在 repo 裡。
- ✅ GitHub repo 沒有 Actions secret 或 variable、沒有 webhook、沒有 deploy key、沒有 CI artifact。
- ✅ **Secret scanning** 和 **Push protection** 本來就開著。

## CI 和 GitHub 設定

- ✅ **GitHub Actions**：`ci.yml` 只聽 `pull_request` 和 `push` 到 `main`，沒有 `pull_request_target`，權限是 `contents: read`，repo 預設 workflow 權限也是 read。
- ✅ **`main` 的 branch ruleset**（2026-10-29 新增，名稱 `main`）：要求走 PR（0 個 approval，因為只有你一個人）、要求 CI 的 `check` 通過、擋 force push、擋刪除。原本的「Rule」沒有指定任何分支，等於沒作用，所以 `main` 之前其實沒有保護。
- ✅ **Dependabot alerts 和 security updates** 已打開（2026-10-29）。
- ✅ **Dependabot PR 自動合併**（這個 PR，第一個 Dependabot PR 進來前還沒實際跑過）：minor 和 patch 升級在 `check` 通過後自動 squash 合併（`.github/workflows/dependabot-auto-merge.yml`），major 升級留給你；維護者換人、或動到 `partyserver`（0.x 版，minor 升級也可能壞掉遊戲伺服器）的 PR 也留給你。新版本發布滿 5 天才升（`cooldown`），漏洞修補不等。合併會觸發 Vercel 部署；worker 還是要手動 `npx wrangler deploy`。
- ✅ **fork 的 PR 一律要你按同意才跑 CI**（`approval_policy: all_external_contributors`，2026-10-29）。原本只擋第一次來的人。
- ✅ **Actions 只允許 GitHub 官方和 verified 的 action**（2026-10-29）。`dependabot/fetch-metadata` 是 verified 的，並用 commit SHA 釘住。
- ✅ **只允許 squash merge**，開了「Allow auto-merge」和「合併後刪分支」（2026-10-29）。
- ✅ **私下回報漏洞**（Private vulnerability reporting）已打開，回報方式寫在 `SECURITY.md`（這個 PR）。
- ✅ 只有你一個 collaborator。`npm audit` 0 個漏洞（這個 PR 用 `npm audit fix` 修了 `source-map-js`，順便升了幾個套件的 patch／minor 版本）。

## 內容

- ✅ **LICENSE**：MIT。這個 PR 在 `package.json` 加了 `"license": "MIT"`。
- ✅ 歷史裡沒有本機家目錄路徑。
- 🙋 **舊 commit 的作者 email 含本機主機名**：歷史裡有幾百個 commit（最近一個是 2026-10-26）用的是本機使用者名稱加主機名的 email。現在的 git 設定已經改用 noreply email。建議跟 critical-answer 一樣不改寫歷史：`refs/pull/*` 會永遠保留舊 commit，改了也清不乾淨。
- ✅ **本來就公開的東西**：`hitsteronline.vercel.app` 和 worker 的網址。瀏覽器本來就拿得到，不是密鑰。

## 要你做

1. ⚙️ **Google Cloud Console**：刪掉或換掉上面那把舊的 YouTube API key。
2. ⚙️ **Vercel**：確認 fork 的 PR 要你同意才會建 preview、拿到環境變數（Vercel 預設是這樣，這次沒查）。

## 這次沒涵蓋到

- 沒跑 `/cso --code`（程式碼本身的安全）。
- 沒跑 gitleaks；密鑰結果是用實際值比對和金鑰前綴掃描得到的。
- worker 是手動 `npx wrangler deploy`。沒查 Cloudflare 那邊有沒有接上 Workers Builds；有的話要確認「Builds for Preview branches」是關的。

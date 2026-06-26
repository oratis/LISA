# Lisa website

Static, bilingual (EN + zh-CN) marketing + docs site for Lisa.

Built with [Astro 6](https://astro.build). No client-side JS by default. Pixel-art aesthetic matches the chat UI in `src/web/server.ts`.

## Local dev

```sh
cd website
npm install
npm run dev
```

`predev` and `prebuild` hooks run [`scripts/prebuild.mjs`](scripts/prebuild.mjs) which:
1. Snapshots `scripts/lisa-moods.ts` (in repo root) → `src/data/moods.json` so Astro pages can import it without a TS resolution dance.
2. Symlinks `src/web/assets/` (in repo root) → `public/assets` so the existing 114 mood portraits + UI assets are served as static files at `/assets/*` without duplicating them.

`src/data/moods.json` and `public/assets` are git-ignored (they're derived).

## Pages

| Path | Contents |
|---|---|
| `/` | Landing — hero, "what makes her different", evolution, sovereignty, multi-platform |
| `/install` | macOS / Linux install + provider config + heartbeat + IM channels + diagnostics |
| `/moods` | Mood gallery — all 114 portraits grouped by category, with their generation prompts |
| `/zh-CN/...` | Same set, translated |

## Deployment

**Live at [meetlisa.ai](https://meetlisa.ai).** Hosting + routing:

- **Origin**: GCP **Cloud Run** service `lisa-web` (`<your-gcp-project>` / `us-central1`),
  built from this `website/` via [`Dockerfile`](Dockerfile) — nginx serving the
  pre-built static Astro `dist/`.
- **Edge**: `meetlisa.ai` is on **Cloudflare (Free)**. The Free plan can't
  rewrite origin Host/SNI (Origin Rules' Host Header + SNI overrides are
  Enterprise-only), which Cloud Run requires — so a tiny **Cloudflare Worker**
  (`meetlisa-proxy`, routes `meetlisa.ai/*` + `www/*`) reverse-proxies to the
  `run.app` origin, where `fetch()` makes Host + SNI correct automatically.

### Deploy

Two paths, both supported:

- **Cloud Run** (origin) — build locally, then ship the nginx image:
  ```sh
  PROJECT=<your-gcp-project> website/deploy/deploy.sh --canary   # --no-traffic 'canary' to verify
  PROJECT=<your-gcp-project> website/deploy/deploy.sh            # build + promote to 100%
  ```
  `deploy.sh` runs `npm run build` locally (`prebuild` needs the repo-root
  `scripts/lisa-moods.ts` + `src/web/assets/`, reachable here — not inside a
  website-only Docker context), then `gcloud run deploy --source website` builds
  [`Dockerfile`](Dockerfile) (nginx serving `dist/`); [`.gcloudignore`](.gcloudignore)
  trims the upload to `dist/` + the Dockerfile + `nginx.conf`. Env: `PROJECT`
  (required), `REGION`, `SERVICE`.
- **Cloudflare Pages** (CI) — `.github/workflows/website-deploy.yml` builds on
  every push to `main` and, when `CF_API_TOKEN` + `CF_ACCOUNT_ID` secrets are
  set, deploys `dist/` to Cloudflare Pages.

## Editing

- Bilingual symmetry: every page in `src/pages/*.astro` has a sibling in `src/pages/zh-CN/*.astro`. Keep them in sync.
- Layout: `src/layouts/Base.astro`. Header/footer + global pixel-art styles.
- Mood data: edit `scripts/lisa-moods.ts` (in repo root), re-run `npm run prebuild`.

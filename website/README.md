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
  built from this `website/` via [`deploy/Dockerfile`](deploy/Dockerfile)
  (static build → `serve` on `$PORT`).
- **Edge**: `meetlisa.ai` is on **Cloudflare (Free)**. The Free plan can't
  rewrite origin Host/SNI (Origin Rules' Host Header + SNI overrides are
  Enterprise-only), which Cloud Run requires — so a tiny **Cloudflare Worker**
  (`meetlisa-proxy`, routes `meetlisa.ai/*` + `www/*`) reverse-proxies to the
  `run.app` origin, where `fetch()` makes Host + SNI correct automatically.

### Deploy

```sh
website/deploy/deploy.sh --canary   # build a no-traffic 'canary' revision to verify
website/deploy/deploy.sh            # build + promote to 100% traffic
```

The script stages a self-contained build context (this `website/` + the
repo-root `scripts/lisa-moods.ts` and `src/web/assets/` that `prebuild` needs)
so the asset symlink resolves inside the image. Env overrides: `PROJECT`,
`REGION`, `SERVICE`.

## Editing

- Bilingual symmetry: every page in `src/pages/*.astro` has a sibling in `src/pages/zh-CN/*.astro`. Keep them in sync.
- Layout: `src/layouts/Base.astro`. Header/footer + global pixel-art styles.
- Mood data: edit `scripts/lisa-moods.ts` (in repo root), re-run `npm run prebuild`.

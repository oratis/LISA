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

**Local-only for now** (per `docs/PRODUCTIZATION_PLAN.md`). When ready to go public:

1. Buy a domain (`meetlisa.ai` decided in PRODUCTIZATION_PLAN.md).
2. Point Cloudflare Pages at this `website/` directory with build command `npm run build` and output `dist/`.
3. Set DNS: `CNAME @ <project>.pages.dev`.
4. Update `astro.config.mjs` `site` if changed.

## Editing

- Bilingual symmetry: every page in `src/pages/*.astro` has a sibling in `src/pages/zh-CN/*.astro`. Keep them in sync.
- Layout: `src/layouts/Base.astro`. Header/footer + global pixel-art styles.
- Mood data: edit `scripts/lisa-moods.ts` (in repo root), re-run `npm run prebuild`.

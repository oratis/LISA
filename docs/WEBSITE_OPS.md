# Website operations — meetlisa.ai

Runbook for the marketing site (`website/`). Records the bits of infrastructure
state that live **outside** the repo (Cloudflare dashboard, Cloud Run) so they're
traceable. Last updated **2026-07-14**.

## Architecture

```
browser ──▶ Cloudflare edge (orange cloud) ──▶ Cloud Run "lisa-web" (nginx + static dist/)
            zone: meetlisa.ai                    project: oratis-491316, region: us-central1
```

- **Origin**: an Astro static build served by nginx (`website/Dockerfile`, `website/nginx.conf`)
  on Cloud Run. The build is done **locally** by `website/deploy/deploy.sh` (it needs
  repo-root `scripts/` + `src/web/assets/`, unreachable from a website-only Docker context),
  then a tiny nginx image is deployed with `gcloud run deploy --source website`.
- **Edge**: Cloudflare proxies `meetlisa.ai` (and `www`). Already the "orange cloud" —
  `server: cloudflare`, HTTP/3, static assets edge-cached.

### Deploy

```bash
PROJECT=oratis-491316 website/deploy/deploy.sh            # build + promote to 100%
PROJECT=oratis-491316 website/deploy/deploy.sh --canary   # --no-traffic tag to verify first
```

Assets are content-hashed (`/_astro/*`), so a deploy publishes new URLs — no cache purge
needed for CSS/JS. Stable-named assets (`/assets/*`, `/fonts/*`, `/og-cover.png`) change
rarely; if you replace one in place, purge that URL from Cloudflare.

## Cloudflare zone configuration

Zone: **meetlisa.ai** · id `ab280f23b19d14b706469ef3b450bfbd` · plan **Free**.

Changes are applied over the API (`api.cloudflare.com/client/v4/zones/{id}/settings/{name}`)
with a token that has **Zone → Zone Settings → Edit**. (The token used on 2026-07-14 could
edit settings but **not** purge cache — grant **Cache Purge** too if you want purges.)
**Never commit an API token.**

### Current speed-relevant settings

| Setting | Value | Notes |
|---|---|---|
| `brotli` | on | text compression to browser |
| `http3` | on | QUIC / HTTP/3 (`alt-svc: h3`) |
| `http2` | on | not editable |
| `tls_1_3` | on | |
| `early_hints` | **on** | 103 Early Hints — hints our `<link rel=preload>` fonts early |
| `0rtt` | **on** | TLS 1.3 0-RTT resumption for repeat visits |
| `always_use_https` | **on** | http→https 301 at the edge (was origin-side) |
| `automatic_https_rewrites` | on | |
| Tiered Cache | **on** | `/zones/{id}/argo/tiered_caching` — fewer origin round-trips |
| `browser_cache_ttl` | **0** | "Respect Existing Headers" — CF passes our origin `Cache-Control` through unchanged (was a fixed 4h) |
| `ssl` | full | CF↔origin over HTTPS (origin = Cloud Run, valid cert) |

Bolded rows were changed on 2026-07-14; the rest were already on.

### Deliberately NOT enabled

- **Rocket Loader** — defers/async-loads JS; can reorder/break scripts. The site is
  near-static, so the risk outweighs the tiny gain. Leave **off**.
- **Auto Minify** (`minify`) — deprecated/removed by Cloudflare; Astro already minifies.
- **`ssl` → Full (strict)** — would validate the origin cert (Cloud Run has one, so it's
  safe to tighten later), but it's a security change, out of scope for the speed pass.

### Not available on Free

- **Polish** (auto WebP/AVIF for images) — `editable=false` on Free. Would shrink the
  app icon + 114 mood PNGs; needs **Pro**.
- **Mirage**, **Cache Reserve**, **Argo Smart Routing** — paid.

### DNS note

From some local networks `dig meetlisa.ai` returns `198.18.x` (RFC2544 benchmarking range) —
that's local DNS interception (VPN/WARP/proxy), not the real record. The public record points
at Cloudflare; confirm with response headers (`server: cloudflare`, `cf-ray`).

## Origin cache headers (`website/nginx.conf`)

With `browser_cache_ttl = 0` at the edge, these origin headers reach the browser verbatim:

| Path | `Cache-Control` | Why |
|---|---|---|
| HTML (`location /`) | `public, max-age=0, must-revalidate` | deploy shows up immediately; cheap ETag 304s. Fixes the heuristic-caching "stale page after deploy" problem. |
| `/_astro/` | `public, max-age=31536000, immutable` | content-hashed filenames — safe forever |
| `/fonts/` | `public, max-age=31536000, immutable` | stable names, rarely change |
| `/assets/` | `public, max-age=2592000, immutable` | images; 30d (names are stable, not hashed) |

`gzip` is on for text types (origin→edge hop; CF re-compresses to the browser).

## Fonts (self-hosted)

`website/public/fonts/{space-grotesk-latin,jetbrains-mono-latin}.woff2` — the two families
are **variable** fonts, so one file each (latin subset, ~53 KB total) covers all weights.
`@font-face` (weight range `400 700`, `font-display: swap`) + `<link rel=preload>` live in
`website/src/layouts/Base.astro`. No Google Fonts request (removes a render-blocking
third-party call; fits the no-telemetry stance).

To refresh (e.g. new Google Fonts version): fetch the CSS with a modern-browser User-Agent
from `https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap`,
download the `latin` block's `.woff2` for each family, replace the files (keep the names).

## OG share image

`website/public/og-cover.png` — 1200×630 brand card (app icon + headline). Open Graph +
Twitter Card meta are emitted per page in `Base.astro` (`og:*`, `twitter:*`, `canonical`).
Regenerate with `sharp` (a `website/` dependency) from an SVG that embeds
`src/web/assets/lisa-app-icon.png` as a base64 `<image>` and draws the text; run the script
from inside `website/` so Node resolves `sharp`. Text uses a system font stack (Helvetica/
DejaVu) since the web fonts aren't installed for the rasterizer — good enough for a share card.

## History

| Date | PR | What |
|---|---|---|
| 2026-07-13 | [#216](https://github.com/oratis/LISA/pull/216) | Rebuild the site in the Hakko design language |
| 2026-07-13 | [#217](https://github.com/oratis/LISA/pull/217) | Use the macOS app icon as the site logo |
| 2026-07-13 | [#219](https://github.com/oratis/LISA/pull/219) | Redesign the Install page |
| 2026-07-13 | [#220](https://github.com/oratis/LISA/pull/220) | Restyle Changelog / Moods / Privacy |
| 2026-07-14 | [#223](https://github.com/oratis/LISA/pull/223) | Unified footer, OG image, self-hosted fonts, origin cache headers |
| 2026-07-14 | — (dashboard/API) | Cloudflare: Early Hints, 0-RTT, Always Use HTTPS, Tiered Cache, Respect Existing Headers |

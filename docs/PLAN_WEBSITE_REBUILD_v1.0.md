# PLAN — LISA website rebuild in the Hakko design language (v1.0)

> Goal: refactor LISA's marketing site (`website/`, Astro) to adopt the visual
> style, functionality, and layout of the Hakko reference sites
> ([lite.hakko.ai](https://lite.hakko.ai) — product landing; [pitch.hakko.ai](https://pitch.hakko.ai)
> — deck), while keeping LISA's own content, bilingual structure, and identity.
> Flow: **this plan (+ debate) → implement → PR → merge → deploy live.**

## 0. TL;DR decision
Adopt Hakko's **modern flat-dark system** (near-black ground, lime-green primary +
electric-blue secondary, bold grotesque display + monospace labels/console, stat
rows, 3-up feature cards, clean console panels) — but **keep LISA's soul**: the
pixel mascot as a warm accent, the terminal/console motif (rendered clean, not CRT),
and the sovereignty/journal messaging. Result: *LISA, modernised into the Hakko
family look* — not a Hakko clone, not the current CRT museum piece. Retire the heavy
CRT scanlines + all-caps Press-Start-2P body type.

## 1. Reference analysis — the Hakko design language
From lite.hakko.ai + pitch.hakko.ai (observed in-browser):

**Palette.** Deep near-black ground (`~#0a0b0d`); **lime-green** primary accent
(`~#a3e635`/`#b4f13d`, used on the main CTA + headline emphasis); **electric-blue**
secondary (`~#4da3ff`, eyebrow highlight, active-nav underline); soft neutral greys
for body/muted; status dots (● green / ■ red) in console blocks.

**Typography.** Large **bold grotesque** display (tight, confident, 2-line hero with
the 2nd line in green); **monospace** for uppercase eyebrow labels
(`AI GAMING COMPANION · WINDOWS`), console/live-session blocks, and data; clean sans
body. No pixel type, no scanlines — flat and crisp.

**Layout / components.**
- Sticky top nav: logo + product badge, section links with active underline, a
  `[中文]` toggle, a filled green **Download** button top-right.
- Hero: mono eyebrow → huge 2-line headline (2nd line accent) → lede with bold
  keywords → two CTAs (filled + outline) → check-marked feature tags.
- A **console panel** beside/under the hero (`host@desktop — live session`, `▸ cmd`,
  status lines, mascot idle line) — the product's "voice" shown live.
- A **stat row**: big number + tiny mono label (VISION 1fps · BUFFER 60s · …).
- Problem framing ("THE GAP"), then **3-up feature cards** (label · title · desc),
  teaser links, a closing CTA band, footer.

**Mood.** Sleek, high-contrast, engineering-cool, product-confident.

## 2. Current state — LISA site
- **Stack:** Astro (`website/`), pages `index / install / changelog / moods /
  privacy` each in `en` + `zh-CN`; `src/lib/releases.ts`, `scripts/prebuild.mjs`.
- **Layout:** `src/layouts/Base.astro` — CRT/pixel theme (Press Start 2P + VT323,
  scanline overlay, starfield, cyan `#6cf6e1` / amber `#ffd167` / magenta on deep
  indigo `#07091a`, chunky pixel buttons, `>` command section headers).
- **Content (strong, keep):** soul / desires / heartbeat / dreams; how-she-evolves
  steps; "sovereign by design"; multi-platform (CLI/PWA/iOS Pocket/IM/10+ providers);
  demo video; pixel mascot; moods gallery; changelog from releases.
- **Deploy:** Cloudflare Pages (`.github/workflows/website-deploy.yml` →
  `wrangler pages deploy website/dist --project-name=lisa-website`) + a Cloud Run
  Dockerfile/nginx fallback.

## 3. Proposed design system (new tokens)
```
--bg:#0a0b0d  --bg-elev:#111317  --panel:#14171c  --panel-2:#191d23
--border:#23272e  --border-lit:#333944
--ink:#e9ebee  --muted:#9aa2ac  --faint:#6b7280
--accent:#a8e546   (lime — primary CTA, headline emphasis)   ← LISA takes green
--blue:#4da3ff     (secondary — eyebrow/active/links)
--amber:#ffd06b    (tertiary — mascot glow + "soul" warmth, LISA's keepsake)
--good:#57d38c  --warn:#e0a44a
```
- **Fonts (Google Fonts, already the loading path):** display **Space Grotesk**
  (600/700), mono **JetBrains Mono** (400/500), body system-ui/Inter fallback.
  Retire Press Start 2P + VT323. (Swap display later if we license a closer grotesque.)
- **Components (new Astro partials in `website/src/components/`):** `Nav.astro`,
  `Console.astro` (clean terminal panel), `StatRow.astro`, `FeatureCard.astro`,
  `Eyebrow.astro`, `CtaBand.astro`, `Footer.astro`. Keep a light "sovereign" console
  and a pixel-mascot accent so it still reads as LISA.
- **Motion:** subtle only (fade/slide-in on scroll, mascot float, console typing),
  all gated by `prefers-reduced-motion`. No CRT flicker.

## 4. Information architecture & page rebuild
- **Home (`index`):** eyebrow `SELF-EVOLVING LOCAL AI · macOS/Linux` → hero headline
  "An AI agent with **a real self.**" (2nd part lime) → lede → CTAs (green *Download
  for Mac* + outline *All install options*) → feature tags (Signed · Local-only ·
  MIT) → **live "soul" console** (birth boot + a heartbeat line) → **stat row**
  (Big-Five seed · desires · heartbeat cadence · 10+ providers) → **3-up cards**
  (Soul / Desires / Heartbeat / Dreams) → "how she evolves" (numbered) → "sovereign
  by design" console → multi-platform → closing CTA band.
- **install / changelog / moods / privacy:** reskin to the new system (nav, type,
  cards, console). `changelog` keeps `releases.ts`; `moods` keeps the gallery grid.
- **Bilingual:** preserve `en` + `zh-CN` parity via `Base.astro` nav + per-page copy.

## 5. Tech plan
1. Rewrite `Base.astro`: new tokens/global CSS, fonts, nav (sticky, active underline,
   green CTA, `[中文]`), footer. Remove CRT/pixel globals.
2. Add `website/src/components/*` partials (above).
3. Rebuild `index.astro` (+ `zh-CN/index.astro`) to the new IA.
4. Reskin `install / changelog / moods / privacy` (× 2 langs).
5. Keep build + deploy config unchanged (Astro static → `website/dist`).
6. Verify locally (`npm run build` + preview), check both langs + mobile + dark, then
   deploy.

## 6. Deploy & rollout
- **Branch:** do the rebuild on a focused branch `feat/website-hakko-restyle` off the
  freshly-pulled `main` (keeps the PR website-only and clean; the current research
  branch's commits are a separate concern — see §8).
- **PR → merge → deploy:** open PR; on merge to `main`, `website-deploy.yml`
  auto-builds + pushes to Cloudflare Pages (`lisa-website`) → live. Verify the live
  URL renders (nav, both langs, mobile) post-deploy; roll back via revert if broken.

## 7. 正反方辩论 — should we adopt the Hakko look wholesale?

**FOR (proponent).**
- Brand family: LISA + Hakko share an owner; a common visual system reads as one
  credible studio and lifts LISA's perceived polish.
- The current CRT/pixel look, while charming, is *niche* and can read as a toy;
  the Hakko system is modern, legible, and converts better (clear CTA hierarchy,
  scannable stats/cards).
- Monospace + console panels already fit LISA ("lives in `~/.lisa`", terminal-native)
  — we keep the on-brand part and just modernise the frame.

**AGAINST (skeptic).**
- LISA's CRT/pixel identity is *distinctive* and thematically perfect for a
  "sovereign, local, hacker-soul" product — a slick SaaS skin risks making LISA look
  like a generic gaming app and **a Hakko clone**, erasing its personality.
- Hakko is a gaming companion (green "esports" energy); LISA is a philosophical
  self-evolving agent — copying the gaming aesthetic could mismatch the message.
- Real cost/risk: full reskin across 10 pages × 2 langs invites regressions and
  bilingual drift for a site that already works.

**REBUTTALS.**
- *Clone risk* → mitigated by keeping LISA's **amber "soul" accent**, the pixel
  mascot, and journal/sovereignty voice; we adopt Hakko's *structure and polish*, not
  its exact identity or copy.
- *Message mismatch* → we lean the accent on **green = "alive/growing"** (fits a
  *self-evolving* agent) and keep the console/soul narrative, not esports framing.
- *Cost/regression* → phased: Base + home first (highest value), then inner pages;
  local build/preview gate before deploy; revert-on-merge is one commit.

**SYNTHESIS / DECISION (adopted).**
A **hybrid restyle**: Hakko's modern flat-dark system, green+blue accents, grotesque
+ mono type, stat rows and feature cards and clean console panels — **plus** LISA's
retained identity hooks (pixel mascot accent, amber soul-warmth, terminal/soul
console, sovereignty copy). Drop CRT scanlines and pixel body type. This maximises
polish and brand-family coherence while preserving what makes LISA *LISA*. If, on
review, it reads too Hakko, we dial the amber/mascot up; if too retro, we dial them
down — the token system makes that a one-file change.

## 8. Open decisions (flagged, non-blocking)
- **PR scope:** recommend a **website-only** PR off `main` (clean, deployable). The
  current branch also carries unrelated research commits (Vertex provider, tool
  lever, ablation harness) — those should be a *separate* decision, not bundled into
  the website deploy PR.
- **Display font:** Space Grotesk as the available match; swap if a closer grotesque
  is licensed.
- **`meetlisa.ai` domain / Cloudflare Pages project** assumed unchanged.

## 9. Milestones / checklist
- [ ] M1 — Design system in `Base.astro` (tokens, fonts, nav, footer) + components.
- [ ] M2 — Home rebuilt (en + zh-CN) to the new IA.
- [ ] M3 — install / changelog / moods / privacy reskinned (en + zh-CN).
- [ ] M4 — `npm run build` clean; local preview verified (both langs, mobile, a11y,
      reduced-motion).
- [ ] M5 — PR opened, reviewed, merged to `main`.
- [ ] M6 — Cloudflare Pages deploy verified live; rollback plan ready.

## 10. Risks & mitigations
| risk | mitigation |
|---|---|
| Looks like a Hakko clone | keep mascot + amber + soul copy; adopt structure not identity |
| Bilingual drift | edit `en`/`zh-CN` in lockstep; diff-check parity before PR |
| Build/deploy breakage | local `astro build` + preview gate; single-commit revert |
| Font/CSP load failure | Google Fonts (existing path) + robust system fallbacks |
| Scope creep | phase by milestone; home first, inner pages second |

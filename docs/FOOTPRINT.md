# Footprint

> FOUNDATIONS §5.1. Two costs, two halves of this document. **Runtime**: LISA's
> `serve` backend is long-lived (observers + Sense + island) — its cost model,
> the knobs, and how to measure it on your machine, since real numbers can only
> come from your hardware. **Distribution**: what `npm i -g @oratis/lisa`
> actually downloads, which is dominated by bundled art and music.

## What runs while idle

With nothing granted and no chat, the backend is **event-driven + low-frequency
poll**, not a busy loop:

| source | mechanism | default cadence |
|---|---|---|
| claude-code observer | `fs.watch` on `~/.claude/projects` | event-driven (+400ms debounce) |
| codex observer | `fs.watch` on `~/.codex/sessions` | event-driven (off unless enabled) |
| opencode observer | sqlite poll | 60s (off unless enabled) |
| git observer | `fs.watch` on repo refs | event-driven (off unless `watchRoots` set) |
| ScreenSource (S2) | `osascript` foreground probe | 15s — **but only when `screen` is granted** |
| island web client | poll ping / sessions / consent | 30s / 60s / 30s |
| island re-render | relative-time refresh | 15s |
| screen-advisor | full screenshot → model | off by default; ≥10min when on |

Default-off is the rule: a fresh install observes only claude-code (fs.watch, ~0
CPU at rest) — no screenshots, no audio, no model calls until you ask.

## The cost knobs

The main dials, smallest-cost-first:

- **Sense `screen` grant** — off by default. When on, `ScreenSource` runs one
  `osascript` every **15s** (`DEFAULT_INTERVAL_MS` in `src/sense/screen.ts`). It
  captures app names only (no screenshot), so cost is one cheap subprocess/tick.
- **screen-advisor** — the expensive one (a full screenshot sent to the model).
  Off by default; interval ≥10min when enabled. This is the model-call cost, not
  CPU.
- **opencode `pollMs`** — 60s default; raise it if you don't watch OpenCode.
- **enabled observers** — each enabled agent observer adds an `fs.watch`. Disable
  the ones you don't use in `~/.lisa/agents.json`.

`cwdGitBranch` (codex/opencode O-D1) caches per cwd for 30s, so branch derivation
doesn't spawn git on every record.

## Measuring it

```sh
lisa serve --web &                 # start the backend
npx tsx scripts/footprint.ts       # samples the serve pid for 60s
# or: npx tsx scripts/footprint.ts --pid <pid> --seconds 120 --interval 5
```

For a true **idle baseline**: leave the machine alone during the window with
only presence/git/agent observation on (no chat, granted sense sources off).

## Acceptance (FOUNDATIONS §5.1)

- [ ] Idle CPU is **negligible** (single-digit % peaks at most from the polls/
      fs.watch callbacks; ~0 at true rest).
- [ ] RSS is stable (no growth over a long window — the logs/journals are bounded
      + retention-capped).
- [ ] Granting `screen` adds only a modest, periodic blip (one osascript/15s),
      not a sustained load.

## Measured footprint log

Fill in from `scripts/footprint.ts` on your machine + config.

| date | machine | config | window | CPU avg / peak | RSS avg / peak |
|---|---|---|---|---|---|
| _pending_ | — | idle (claude-code only) | — | — | — |
| _pending_ | — | `screen` granted | — | — | — |

## Distribution footprint

`npm i -g @oratis/lisa` ships `dist/` (which contains `src/web/assets`
verbatim), `contracts/`, the shell completions and the READMEs. Measured with
`npm pack --dry-run` after `rm -rf dist/web/assets && cp -R src/web/assets
dist/web/assets` — the everyday `dist/web/assets` is a symlink, which `npm
pack` follows but does not size the way a publish does, so the copy is what
makes the number real. Restore the symlink afterwards with `npm run
copy-assets`.

| | packed (.tgz) | unpacked | files |
|---|---:|---:|---:|
| v0.24.0 as published | 61.9 MB | 65.9 MB | 1,295 |
| after the lossless PNG pass | 55.1 MB | 58.9 MB | 1,298 |

(+3 files are the derived manifest / touch icons. npm reports decimal MB;
the asset tables below use MiB.)

Of the 58.9 MB unpacked, **54.2 MB is `src/web/assets`** and only ~4.7 MB is
code and contracts. So the package size question is entirely an asset
question:

| bundle | files | on disk | as lossless WebP |
|---|---:|---:|---:|
| `assets/lisa/` — 114 mood portraits, 512² | 114 | 20.47 MiB | 14.23 MiB (−30.5%) |
| `assets/room/music/` — 8 CC0 mp3 | 8 | 19.27 MiB | n/a (already compressed) |
| `assets/room/` — 6 scenes + 11 poses | 17 | 10.12 MiB | 7.91 MiB (−21.8%) |
| `assets/` root — mascot, icons, tile | 12 | 1.80 MiB | 1.53 MiB (−15.2%) |
| **total** | **151** | **51.66 MiB** | **42.95 MiB** |

The review target (UX-7 / T-9) is **< 15 MB unpacked**. The table says format
alone cannot reach it: even converting every PNG to lossless WebP leaves
42.95 MiB, because the music is already compressed and the mood pack is
simply large. Closing the gap needs a bundle to stop shipping inside the
tarball — fetch the mood pack, the room scenes and the music on first use
instead — and that is a reference change in `src/web/*.ts`, not an encoder
change. No duplicate frames exist to remove: no two PNGs in the tree decode
to the same pixels.

### `scripts/optimize-assets.ts`

```sh
npm run optimize-assets                 # optimise in place, print the tables
npm run optimize-assets -- --dry-run    # measure only, write nothing
npm run optimize-assets -- --estimate   # force the WebP / duplicate analysis
npm run optimize-assets -- --icons      # regenerate the manifest / touch icons
npm run optimize-assets -- --filter lisa/ --jobs 8 --top 30
```

Lossless-first PNG re-encoder for `src/web/assets`. These are pixel-art
frames, so "visually lossless" is not good enough — a candidate is accepted
only when decoding it yields **byte-identical RGBA** to the file it replaces
*and* it is strictly smaller, and the bytes on disk are decoded and compared
once more after the write (restoring the original if that ever fails).
Filenames, dimensions, alpha and colour space are preserved, so nothing in
`src/web/*.ts` has to change.

- Candidates, all via sharp/libvips (no new dependency): truecolour zlib-9
  with adaptive row filtering, truecolour zlib-9 without filtering, and — only
  when the image has ≤ 256 distinct RGBA colours — a libimagequant palette at
  quality 100 / effort 10 / no dither.
- Chunk policy: sharp strips ancillary chunks and adds its own `pHYs`, so the
  original's colour-space chunks (`gAMA`, `cHRM`, `sRGB`, `iCCP`) are spliced
  back verbatim with recomputed CRCs — they change how Firefox and Safari
  colour-manage the image. Metadata-only chunks are dropped after asserting no
  EXIF orientation; a file carrying any other ancillary chunk is left alone
  rather than guessed at.
- **Idempotent**: a second run finds no strictly smaller exact candidate and
  writes nothing (verified — 142/142 reported "already optimal", 0 B saved).
- `--icons` derives `icon-192.png`, `icon-512.png` and `apple-touch-icon.png`
  from `lisa-app-icon.png`. The manifest pair is inset to the largest scale
  that puts every non-background pixel inside the maskable safe zone (the
  central 80% circle) — measured from the master, not hard-coded, and
  asserted on the output. `apple-touch-icon` stays full-bleed because iOS
  masks with a much gentler superellipse.

First pass result (v0.24.0 → now): 125 of 139 PNGs got smaller, 39.05 MiB →
32.18 MiB (−17.6%), all 125 verified pixel-identical against the previous
committed blobs. The 14 untouched files — the `room/room*` scene backdrops and
some sofa/idle frames — were already at the zlib floor.

# Resident-service footprint

> FOUNDATIONS §5.1. LISA's `serve` backend is long-lived (observers + Sense +
> island). This documents its cost model + the knobs, and how to measure it on
> your machine — real numbers can only come from your hardware, so this ships a
> harness + a table to fill, not fabricated figures.

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

# Observer fidelity — field availability + live-verification log

> Observer deepening **O-D3**. Companion to [PLAN_OBSERVER_DEEPENING_v1.0.md](./PLAN_OBSERVER_DEEPENING_v1.0.md).

LISA observes several CLI agents by reading their on-disk session formats. Two
very different things must both be true for "LISA can see all your agents" to
hold:

1. **The parse LOGIC is correct** — proven by unit tests over fixtures
   (`src/integrations/*/observer.test.ts`). These run in CI and never touch a
   real agent.
2. **The parse SCHEMA assumptions still match reality** — each CLI's format
   drifts across versions (codex rollout schema, opencode DB schema, aider
   markdown). Fixtures can silently fall out of date. Only running against a
   **real, current** agent proves the assumptions still hold.

This file tracks (2): the live-verification log. Run the harness, eyeball the
parsed fields against what the agent is actually doing, and add a row.

## Running the harness

```sh
# Respect ~/.lisa/agents.json (whatever you actually have enabled):
npx tsx scripts/verify-observers.ts

# Or force-enable specific observers at the "activity" tier for a check:
VERIFY_AGENTS=codex,opencode npx tsx scripts/verify-observers.ts

# Or every known observer:
VERIFY_ALL=1 npx tsx scripts/verify-observers.ts
```

It's read-only and prints structural metadata only (tool names, file paths,
argv[0], counts, branch, tokens) — never prompts, replies, or file content.

## Field availability (by design)

| field | claude-code | codex | opencode | aider | notes |
|---|:-:|:-:|:-:|:-:|---|
| turnCount | ✅ | ✅ | ✅ | ✅ | each counts its own turns |
| lastTools | ✅ | ✅ | ✅ | ➖ | aider has no tool protocol (honestly empty) |
| filesTouched | ✅ | ✅ | ✅ | ✅ | from tool input / part input / SEARCH-block path labels |
| lastCommandName | ✅ | ✅ | ✅ | ➖ | shell argv[0] only |
| lastError | ✅ | ✅ | ✅ | ✅ | short label |
| **gitBranch** | ✅ | ✅¹ | ✅¹ | ➖ | ¹ **O-D1**: derived from session cwd (`git symbolic-ref`), not stored by the agent |
| tokens | ✅ | ✅ | ✅ | ➖ | aider doesn't record |
| pendingPermission | ✅ | ➖ | ➖ | ➖ | only Claude Code records an explicit permission gate |

✅ available · ➖ not available **by design** (format doesn't expose it; inventing
it would be dishonest or violate the privacy contract). Don't "fill in" a ➖.

**Window/caps (O-D2):** codex activity reads the last **128 KB** of the rollout
(was 64 KB); opencode scans the last **40** messages per session (was 20). Both
widen coverage on long sessions without changing what's extracted.

## Verification log

Add a row each time you confirm an observer against a live agent. "Result" is
your eyeball judgement: do the printed fields match what the agent was doing?

| observer | CLI version | date | result | notes |
|---|---|---|---|---|
| claude-code | Claude Code (this machine) | 2026-06-14 | ✅ matches | harness showed 9 live sessions; state/branch/tools/files/tokens all correct |
| codex | _pending_ | — | — | run `VERIFY_AGENTS=codex` against a live Codex session |
| opencode | _pending_ | — | — | run `VERIFY_AGENTS=opencode` against a live OpenCode session |
| aider | _pending_ | — | — | run `VERIFY_AGENTS=aider` (needs `watchRoots` set) against a live aider session |

> The non-Claude observers are implemented and fixture-tested but were authored
> against captured samples, not continuously verified against live tools. Adding
> rows here is how we turn "implemented" into "verified" — and how we catch a
> schema drift early (a column going blank in the harness output is the signal).

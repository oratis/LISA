#!/usr/bin/env tsx
/**
 * Offline session replay (H3 — docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §4).
 *
 * Reconstructs, for every turn of a stored session, the exact `(systemPrompt,
 * messages)` input the model was given. This is the take-out point for drift /
 * coherence analysis: it lets a metric be computed — or recomputed with a
 * different definition — long after the run, without the soul/memory/skill
 * files still being in the state they were in at the time.
 *
 * Usage:
 *   npx tsx scripts/replay-session.ts <session-id>            # human summary
 *   npx tsx scripts/replay-session.ts <session-id> --json     # full JSON to stdout
 *   npx tsx scripts/replay-session.ts <session-id> --turn 3   # one turn, verbatim
 *   npx tsx scripts/replay-session.ts --list                  # ids on disk
 *
 * Sessions written before format version 2 have no recorded prompt; the script
 * says so explicitly rather than printing an empty persona, because "not
 * recorded" and "no persona" must never be confused by a downstream metric.
 *
 * Read-only. It never writes to a session file.
 */
import process from "node:process";
import { replaySession } from "../src/sessions/replay.js";
import { listSessionsOnDisk } from "../src/sessions/list.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--list") || argv.length === 0) {
    const sessions = await listSessionsOnDisk();
    if (sessions.length === 0) {
      console.log("(no sessions on disk)");
      return;
    }
    for (const s of sessions) {
      console.log(
        `${s.id}  ${s.startedAt}  ${String(s.messageCount).padStart(4)} msgs  ${
          s.firstUserMessage ?? ""
        }`,
      );
    }
    if (argv.length === 0) {
      console.log("\nPass a session id to replay it. --json for machine output.");
    }
    return;
  }

  // `--turn` takes a value, so the token right after it is NOT the positional
  // id — otherwise `replay --turn 3 <id>` reads "3" as the id. (#357 review)
  const turnFlag = argv.indexOf("--turn");
  const id = argv.find(
    (a, i) => !a.startsWith("--") && (turnFlag === -1 || i !== turnFlag + 1),
  );
  if (!id) throw new Error("no session id given");
  const replay = await replaySession(id);

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(replay, null, 2) + "\n");
    return;
  }

  if (turnFlag !== -1) {
    const n = Number(argv[turnFlag + 1]);
    const turn = replay.turns.find((t) => t.index === n);
    if (!turn) throw new Error(`session has no turn ${n} (${replay.turns.length} total)`);
    console.log(`── turn ${turn.index} @ ${turn.ts} ──`);
    console.log(
      `system prompt: ${
        turn.systemPrompt === null
          ? replay.header.version >= 2
            ? "(none recorded at or before this turn — v2)"
            : "(NOT RECORDED — session predates format v2)"
          : `${turn.systemPrompt.length} chars, fingerprint ${turn.promptFingerprint} (${turn.promptReason})`
      }`,
    );
    if (turn.systemPrompt !== null) {
      console.log("\n" + turn.systemPrompt + "\n");
    }
    console.log(`messages sent: ${turn.messages.length}`);
    process.stdout.write(JSON.stringify(turn.messages, null, 2) + "\n");
    return;
  }

  console.log(`session ${replay.header.id}  (format v${replay.header.version})`);
  console.log(`started ${replay.header.startedAt}  model ${replay.header.model}`);
  console.log(`cwd     ${replay.header.cwd}`);
  console.log(`turns   ${replay.turns.length}`);
  if (!replay.promptsRecorded) {
    console.log(
      replay.header.version < 2
        ? "\n⚠ no system prompt recorded — this session predates H3 (format v2).\n" +
            "  Every turn's systemPrompt is null because it was never written, not\n" +
            "  because the persona was empty. Exclude it from drift analysis."
        : "\n⚠ format v2 but no system prompt was recorded — persistence likely\n" +
            "  failed (e.g. disk full / EPERM). systemPrompt is null on every turn;\n" +
            "  exclude it from drift analysis.",
    );
    return;
  }
  console.log(`prompts ${replay.promptChanges.length} distinct`);
  console.log("\n── prompt timeline ──");
  for (const change of replay.promptChanges) {
    console.log(
      `  ${change.ts}  ${change.fingerprint}  ${change.reason.padEnd(7)}  ` +
        `first used by turn ${change.firstTurn ?? "(none — run ended first)"}`,
    );
  }
  console.log("\n── turns ──");
  for (const turn of replay.turns) {
    console.log(
      `  ${String(turn.index).padStart(3)}  ${turn.ts}  ` +
        `prompt ${turn.promptFingerprint ?? "(none)"}  ` +
        `${String(turn.messages.length).padStart(4)} msgs in`,
    );
  }
  console.log("\nUse --turn <n> for one turn verbatim, or --json for everything.");
}

main().catch((err: unknown) => {
  console.error(`[replay-session] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

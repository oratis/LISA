/**
 * `lisa consent <list|grant|revoke|revoke-all>` — view and control the unified
 * consent for sensitive ambient signals (FOUNDATIONS §1). Thin CLI over
 * src/consent/store.ts. This is the "always visible + one-tap stop" surface
 * until the island SENSE indicator lands with the first source.
 */
import {
  listGrants,
  grant,
  revoke,
  revokeAll,
  SENSE_SIGNALS,
  SIGNAL_DESCRIPTIONS,
} from "../consent/store.js";

function printList(): void {
  console.log("Consent — sensitive ambient signals (default: all off):\n");
  for (const row of listGrants()) {
    const mark = row.granted ? "● on " : "○ off";
    const desc = SIGNAL_DESCRIPTIONS[row.signal] ?? "";
    const when = row.granted && row.grantedAt ? `  (since ${row.grantedAt.slice(0, 10)})` : "";
    console.log(`  ${mark}  ${row.signal.padEnd(10)} ${desc}${when}`);
  }
  console.log("\n  lisa consent grant <signal> | revoke <signal> | revoke-all");
}

export async function runConsentCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0] ?? "list";

  if (sub === "list" || sub === "status") {
    printList();
    return 0;
  }

  if (sub === "grant") {
    const signal = subargs[1];
    if (!signal) {
      console.error(`grant needs a signal — one of: ${SENSE_SIGNALS.join(", ")}`);
      return 1;
    }
    // The consent "card": say plainly what enabling captures before granting.
    const desc = SIGNAL_DESCRIPTIONS[signal] ?? "(custom signal)";
    console.log(`Granting "${signal}" lets LISA capture: ${desc}.`);
    console.log("Local-first: raw is judged/distilled on-device; only structured summaries are stored.");
    console.log("Revoke any time with `lisa consent revoke " + signal + "` (or `revoke-all`).");
    grant(signal);
    console.log(`\n✓ ${signal} granted.`);
    return 0;
  }

  if (sub === "revoke") {
    const signal = subargs[1];
    if (!signal) {
      console.error("revoke needs a signal (or use `revoke-all`).");
      return 1;
    }
    revoke(signal);
    console.log(`✓ ${signal} revoked.`);
    return 0;
  }

  if (sub === "revoke-all" || sub === "stop") {
    revokeAll();
    console.log("✓ all sensitive capture stopped.");
    return 0;
  }

  console.error(`unknown consent subcommand "${sub}" — use list | grant | revoke | revoke-all.`);
  return 1;
}

/**
 * `lisa billing reconcile` — the operator command over the usage outbox.
 *
 * It lives on the CLI surface, not in src/billing, because everything it does
 * beyond calling reconcileOnce() is printing: a reconciler that writes to
 * stdout from inside library code is a reconciler that cannot be called from a
 * request handler or a timer without polluting the log. src/billing keeps
 * `no-console: error` for exactly that reason.
 */
import { redactId } from "../log.js";
import {
  RECONCILE_MAX_ATTEMPTS,
  defaultReconcileDeps,
  reconcileOnce,
  type ReconcileDeps,
} from "../billing/reconcile.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function usdOf(micros: number): string {
  return `$${(micros / 1e6).toFixed(4)}`;
}

/**
 * `lisa billing reconcile [--dry-run] [--json] [--uid <uid>] [--retry-human]
 *                         [--resolve <event-id>]`
 *
 * Runs against THIS host's ledger, so it is an operator command (a Cloud Run
 * shell or the Mac host), not something a signed-in user can call.
 */
export async function cmdBillingReconcile(
  argv: string[],
  deps: ReconcileDeps = defaultReconcileDeps(),
): Promise<void> {
  const uid = flagValue(argv, "--uid");
  const resolveId = flagValue(argv, "--resolve");

  if (resolveId) {
    if (!uid) {
      console.error("✗ --resolve needs --uid <uid> (events are addressed per tenant)");
      process.exitCode = 1;
      return;
    }
    const event = await deps.store.get(uid, resolveId);
    if (!event || event.status !== "needs_human") {
      console.error(
        `✗ ${resolveId}: no parked event with that id — only needs_human events can be closed by hand`,
      );
      process.exitCode = 1;
      return;
    }
    await deps.store.update({
      ...event,
      status: "committed",
      lastError: `resolved by operator at ${new Date(deps.now()).toISOString()}`,
    });
    console.log(
      `✓ ${resolveId} resolved — closed WITHOUT a debit (${usdOf(event.costMicros)}). ` +
        `If the charge is still owed, correct the balance by hand first.`,
    );
    return;
  }

  const report = await reconcileOnce(
    {
      dryRun: argv.includes("--dry-run"),
      retryHuman: argv.includes("--retry-human"),
      ...(uid ? { uid } : {}),
    },
    deps,
  );

  if (argv.includes("--json")) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(
    `${report.dryRun ? "dry run — nothing was written" : "reconcile"} across ${report.tenants} tenant(s)`,
  );
  console.log(`  scanned:   ${report.scanned}`);
  console.log(`  committed: ${report.committed}`);
  console.log(
    `  failed:    ${report.failed} (will retry, under the ${RECONCILE_MAX_ATTEMPTS}-attempt cap)`,
  );
  console.log(`  escalated: ${report.escalated}`);
  console.log(`  skipped:   ${report.skipped}`);
  for (const p of report.parked ?? []) {
    console.log(
      `  needs_human ${p.id} uid=${redactId(p.uid)} ${usdOf(p.costMicros)} ` +
        `attempts=${p.attempts} ${p.lastError ?? ""}`,
    );
  }
}

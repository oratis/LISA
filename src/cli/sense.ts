/**
 * `lisa sense <list>` — print recent ambient sense events + which signals are
 * granted (FOUNDATIONS §4 observability: "one `lisa <domain>` command per
 * pillar"). Read-only over the bounded sense log; structural summaries only.
 */
import { readSenseEvents } from "../sense/log.js";
import { listGrants } from "../consent/store.js";

function rel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export async function runSenseCommand(subargs: string[]): Promise<number> {
  const sub = subargs[0] ?? "list";

  if (sub === "list" || sub === "recent" || sub === "status") {
    const granted = listGrants().filter((g) => g.granted).map((g) => g.signal);
    console.log(`Sense — granted: ${granted.length ? granted.join(", ") : "(none; all off — `lisa consent grant <signal>`)"}\n`);
    const events = readSenseEvents();
    if (events.length === 0) {
      console.log("  (no recent ambient events)");
      return 0;
    }
    const now = Date.now();
    for (const e of events.slice(-30).reverse()) {
      console.log(`  ${rel(now - e.ts).padStart(8)}  [${e.signal}] ${e.summary}`);
    }
    return 0;
  }

  console.error(`unknown sense subcommand "${sub}" — use list.`);
  return 1;
}

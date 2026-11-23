/**
 * `lisa telemetry` — inspect, summarize, or clear the L1 local telemetry ledger.
 *
 * Subcommands:
 *   lisa telemetry report [--days N] [--json]   Summary of local events (default)
 *   lisa telemetry clear [--json]               Delete the local ledger file
 *   lisa telemetry status [--json]              Show opt-out status and ledger bounds
 *   lisa telemetry events [--json]              List declared events and policy rules
 */

import {
  DEFAULT_MAX_LINES,
  DEFAULT_RETENTION_DAYS,
  clearTelemetryLedger,
  isTelemetryEnabled,
  readTelemetryEvents,
  summarizeTelemetry,
  telemetryFile,
} from "../telemetry/ledger.js";
import { EVENT_POLICY, TELEMETRY_EVENT_NAMES } from "../telemetry/schema.js";
import { displayPath } from "./display-path.js";

export interface TelemetryCommandIo {
  out?: (line: string) => void;
  err?: (line: string) => void;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const USAGE = [
  "usage: lisa telemetry [report] [--days N] [--json]",
  "       lisa telemetry clear [--json]",
  "       lisa telemetry status [--json]",
  "       lisa telemetry events [--json]",
].join("\n");

function parseFlagArgs(args: readonly string[]): {
  days?: number;
  json: boolean;
  help: boolean;
  error?: string;
} {
  let days: number | undefined;
  let json = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--days" || arg.startsWith("--days=")) {
      const raw = arg === "--days" ? args[++i] : arg.slice("--days=".length);
      if (!raw || !/^\d+$/.test(raw)) {
        return { json, help, error: `invalid --days value: ${raw ?? "(missing)"}` };
      }
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 1 || n > 3650) {
        return { json, help, error: `--days must be between 1 and 3650 (got ${raw})` };
      }
      days = n;
    } else {
      return { json, help, error: `unknown argument: ${arg}` };
    }
  }

  return { days, json, help };
}

function formatBreakdown(map: Record<string, number>): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}

export async function runTelemetryCommand(
  subargs: readonly string[],
  io: TelemetryCommandIo = {},
): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  const env = io.env ?? process.env;
  const nowMs = io.now ? io.now() : Date.now();
  const ledgerPath = displayPath(telemetryFile(io.home));
  const enabled = isTelemetryEnabled(env);

  const first = subargs[0];
  if (first === "--help" || first === "-h" || first === "help") {
    out(USAGE);
    return 0;
  }

  const sub = first && !first.startsWith("-") ? first : "report";
  const rest = first && !first.startsWith("-") ? subargs.slice(1) : subargs;
  const parsed = parseFlagArgs(rest);

  if (parsed.help) {
    out(USAGE);
    return 0;
  }
  if (parsed.error) {
    err(parsed.error);
    err(USAGE);
    return 2;
  }

  if (sub === "report") {
    const days = parsed.days ?? DEFAULT_RETENTION_DAYS;
    const events = await readTelemetryEvents({
      home: io.home,
      env,
      now: nowMs,
      days,
    });
    const summary = summarizeTelemetry(events);

    if (parsed.json) {
      out(
        JSON.stringify({
          enabled,
          days,
          retentionDays: DEFAULT_RETENTION_DAYS,
          maxLines: DEFAULT_MAX_LINES,
          ledgerPath,
          remoteUpload: "disabled",
          summary,
        }),
      );
      return 0;
    }

    out(`Telemetry (L1 local-only): ${enabled ? "enabled" : "disabled (LISA_TELEMETRY=off)"}`);
    out(
      `Ledger: ${ledgerPath} (mode 0600, ${DEFAULT_RETENTION_DAYS}d retention, max ${DEFAULT_MAX_LINES} lines)`,
    );
    out(`Remote upload (L3): unimplemented / disabled (zero network egress)`);
    out(`Window: last ${days} day(s) — ${summary.totalEvents} event(s)`);

    if (summary.totalEvents === 0) {
      out("\nNo local telemetry events recorded in this window.");
      return 0;
    }

    out(`Range: ${summary.firstEventAt} .. ${summary.lastEventAt}`);
    out("\nBy event:");
    const sortedEvents = Object.entries(summary.byEvent).sort(
      (a, b) => (b[1] ?? 0) - (a[1] ?? 0) || a[0].localeCompare(b[0]),
    );
    for (const [name, count] of sortedEvents) {
      out(`  ${name.padEnd(28)} ${count}`);
    }

    if (summary.sessions.started > 0 || summary.sessions.ended > 0) {
      out(
        `\nSessions: started=${summary.sessions.started} ended=${summary.sessions.ended}` +
          (Object.keys(summary.sessions.bySurface).length
            ? ` (${formatBreakdown(summary.sessions.bySurface)})`
            : ""),
      );
    }
    if (summary.turns.completed > 0) {
      out(
        `Turns: completed=${summary.turns.completed}` +
          (Object.keys(summary.turns.byProvider).length
            ? ` · providers: ${formatBreakdown(summary.turns.byProvider)}`
            : ""),
      );
    }
    if (summary.tasks.created > 0 || summary.tasks.finished > 0) {
      out(
        `Tasks: created=${summary.tasks.created} finished=${summary.tasks.finished}` +
          (Object.keys(summary.tasks.byOutcome).length
            ? ` (${formatBreakdown(summary.tasks.byOutcome)})`
            : ""),
      );
    }
    if (summary.approvals.decided > 0) {
      out(
        `Approvals: decided=${summary.approvals.decided}` +
          (Object.keys(summary.approvals.byVerdict).length
            ? ` (${formatBreakdown(summary.approvals.byVerdict)})`
            : ""),
      );
    }
    if (summary.connectors.authorized > 0) {
      out(
        `Connectors: authorized=${summary.connectors.authorized} (ok=${summary.connectors.succeeded} fail=${summary.connectors.failed})`,
      );
    }
    if (summary.cli.commandsRun > 0) {
      out(
        `CLI commands: total=${summary.cli.commandsRun} (ok=${summary.cli.succeeded} fail=${summary.cli.failed})`,
      );
    }
    if (summary.autonomy.runs > 0) {
      out(
        `Autonomy runs: total=${summary.autonomy.runs} (${formatBreakdown(summary.autonomy.byOutcome)})`,
      );
    }
    return 0;
  }

  if (sub === "clear") {
    if (parsed.days !== undefined) {
      err("--days is only valid with `report`");
      return 2;
    }
    const cleared = await clearTelemetryLedger({ home: io.home });
    if (parsed.json) {
      out(JSON.stringify({ cleared, ledgerPath }));
      return 0;
    }
    out(
      cleared
        ? `Cleared local telemetry ledger (${ledgerPath}).`
        : `No local telemetry ledger found (${ledgerPath}).`,
    );
    return 0;
  }

  if (sub === "status") {
    if (parsed.days !== undefined) {
      err("--days is only valid with `report`");
      return 2;
    }
    const events = await readTelemetryEvents({ home: io.home, env, now: nowMs });
    if (parsed.json) {
      out(
        JSON.stringify({
          enabled,
          ledgerPath,
          eventCount: events.length,
          retentionDays: DEFAULT_RETENTION_DAYS,
          maxLines: DEFAULT_MAX_LINES,
          remoteUpload: "disabled",
        }),
      );
      return 0;
    }
    out(`Local telemetry (L1): ${enabled ? "enabled" : "disabled (LISA_TELEMETRY=off)"}`);
    out(`Ledger: ${ledgerPath} (${events.length} valid event(s) retained)`);
    out(`Retention: ${DEFAULT_RETENTION_DAYS} days, max ${DEFAULT_MAX_LINES} lines`);
    out(`Remote upload (L3): unimplemented / disabled`);
    return 0;
  }

  if (sub === "events") {
    if (parsed.days !== undefined) {
      err("--days is only valid with `report`");
      return 2;
    }
    if (parsed.json) {
      out(
        JSON.stringify(
          TELEMETRY_EVENT_NAMES.map((name) => ({
            name,
            ...EVENT_POLICY[name],
          })),
        ),
      );
      return 0;
    }
    out(`Declared telemetry events (${TELEMETRY_EVENT_NAMES.length}):\n`);
    for (const name of TELEMETRY_EVENT_NAMES) {
      const p = EVENT_POLICY[name];
      out(
        `  ${name.padEnd(28)} emitter=${p.emitter.padEnd(7)} ingress=${p.ingress.padEnd(8)} upload=${p.upload.padEnd(7)} editions=${p.editions.join(",")}`,
      );
    }
    return 0;
  }

  err(`unknown telemetry subcommand "${sub}"`);
  err(USAGE);
  return 2;
}

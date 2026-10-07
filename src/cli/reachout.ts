/**
 * `lisa reachout` — the user's controls over when Lisa may reach out
 * (docs/POLICY_REACH_OUT.md). Thin CLI over src/reachout/settings.ts; the web
 * Settings panel and `/api/reachout/*` edit the same file.
 *
 *   lisa reachout [show]
 *   lisa reachout set dial <off|low|normal|high>
 *   lisa reachout quiet <HH:MM-HH:MM | on | off> [time zone]
 *   lisa reachout source <name> <on|off>
 *   lisa reachout ledger [days]
 */
import { getAutonomyEnabled } from "../autonomy/state.js";
import { lisaHome } from "../paths.js";
import { inQuietHours, localMoment } from "../reachout/clock.js";
import { aggregateLedger, budgetUsed, readLedger, withReachOutLock } from "../reachout/ledger.js";
import {
  DAILY_BUDGET,
  applyReachOutPatch,
  loadReachOutSettings,
  saveReachOutSettings,
  type ReachOutSettings,
} from "../reachout/settings.js";
import { REACH_OUT_DIALS, REACH_OUT_SOURCES } from "../reachout/types.js";

export interface ReachOutCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  now?: () => Date;
}

const SOURCE_NOTES: Record<(typeof REACH_OUT_SOURCES)[number], string> = {
  task: "results of your own tasks and routines",
  watcher: "your watchers firing",
  approval: "actions waiting for your approval (always on)",
  mail: "mail digest + important-mail alerts",
  brief: "daily knowledge-base brief",
  advisor: "coding-agent advisor digests",
  idle: '"while you were away" notes',
  desire: "Lisa's own desire notes (in-app only unless opted in)",
  system: "security and host events",
};

const USAGE = [
  "Usage:",
  "  lisa reachout [show]",
  `  lisa reachout set dial <${REACH_OUT_DIALS.join("|")}>`,
  "  lisa reachout quiet <HH:MM-HH:MM | on | off> [time zone]",
  "  lisa reachout source <name> <on|off>",
  "  lisa reachout ledger [days]",
].join("\n");

function show(settings: ReachOutSettings, home: string, io: ReachOutCliIo): void {
  const now = (io.now ?? (() => new Date()))();
  const q = settings.quietHours;
  const daily = DAILY_BUDGET[settings.dial];
  const used = budgetUsed(readLedger(home), localMoment(now, q.tz).day);
  io.log("Reach-out — when Lisa may contact you on her own\n");
  io.log(
    `  dial         ${settings.dial}   (off = in-app only · low 1 · normal 3 · high 8 pushes/day)`,
  );
  io.log(`  budget       ${used}/${daily} unsolicited pushes used today`);
  io.log(
    `  quiet hours  ${q.enabled ? `${q.start}–${q.end}` : "off"}  (${q.tz ?? "local time"})` +
      (inQuietHours(now, q) ? "  ← quiet now" : ""),
  );
  io.log(
    `  channels     in-app ${settings.channels.inapp ? "on" : "off"} · push ${settings.channels.push ? "on" : "off"} · IM ${settings.channels.im ? "on" : "off"}`,
  );
  if (!getAutonomyEnabled()) {
    io.log(
      "  proactive    off — Lisa is not acting on her own; idle and desire notes are in-app only",
    );
  }
  io.log("\n  sources");
  for (const s of REACH_OUT_SOURCES) {
    const mark = settings.sources[s] ? "● on " : "○ off";
    io.log(`    ${mark}  ${s.padEnd(9)} ${SOURCE_NOTES[s]}`);
  }
  io.log("\n  Approvals and critical notices always get through.");
  io.log("  lisa reachout set dial <v> | quiet <HH:MM-HH:MM> | source <name> on|off | ledger");
}

async function update(
  patch: unknown,
  home: string,
  io: ReachOutCliIo,
): Promise<ReachOutSettings | null> {
  const result = await withReachOutLock(home, async () => {
    const merged = applyReachOutPatch(loadReachOutSettings(home), patch);
    if (!merged.ok) return merged;
    return { ok: true as const, settings: await saveReachOutSettings(merged.settings, home) };
  });
  if (!result.ok) {
    io.error(result.error);
    return null;
  }
  return result.settings;
}

export async function runReachOutCommand(
  subargs: string[],
  io: ReachOutCliIo = { log: (l) => console.log(l), error: (l) => console.error(l) },
): Promise<number> {
  const home = lisaHome();
  const sub = subargs[0] ?? "show";

  if (sub === "show" || sub === "status") {
    show(loadReachOutSettings(home), home, io);
    return 0;
  }

  if (sub === "set" || sub === "dial") {
    // `set dial <v>` and the shorthand `dial <v>`.
    const rest = sub === "set" ? subargs.slice(1) : subargs;
    if (rest[0] !== "dial" || !rest[1]) {
      io.error(`set needs: dial <${REACH_OUT_DIALS.join("|")}>`);
      return 1;
    }
    const saved = await update({ dial: rest[1] }, home, io);
    if (!saved) return 1;
    const budget = DAILY_BUDGET[saved.dial];
    io.log(
      saved.dial === "off"
        ? "✓ dial off — in-app only. Approvals and critical notices still push."
        : `✓ dial ${saved.dial} — up to ${budget} unsolicited push${budget === 1 ? "" : "es"} a day.`,
    );
    return 0;
  }

  if (sub === "quiet") {
    const arg = subargs[1];
    const tz = subargs[2];
    if (!arg) {
      io.error("quiet needs a window like 22:00-08:00, or on / off");
      return 1;
    }
    let quietHours: Record<string, unknown>;
    if (arg === "on" || arg === "off") {
      quietHours = { enabled: arg === "on" };
    } else {
      const m = /^(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})$/.exec(arg);
      if (!m) {
        io.error("quiet needs a window like 22:00-08:00, or on / off");
        return 1;
      }
      quietHours = { enabled: true, start: m[1], end: m[2] };
    }
    if (tz !== undefined) quietHours.tz = tz === "local" ? null : tz;
    const saved = await update({ quietHours }, home, io);
    if (!saved) return 1;
    const q = saved.quietHours;
    io.log(
      q.enabled
        ? `✓ quiet hours ${q.start}–${q.end} (${q.tz ?? "local time"}) — pushes wait until ${q.end}.`
        : "✓ quiet hours off.",
    );
    return 0;
  }

  if (sub === "source") {
    const name = subargs[1];
    const state = subargs[2];
    if (!name || (state !== "on" && state !== "off")) {
      io.error(`source needs: <${REACH_OUT_SOURCES.join("|")}> <on|off>`);
      return 1;
    }
    const saved = await update({ sources: { [name]: state === "on" } }, home, io);
    if (!saved) return 1;
    io.log(`✓ ${name} ${state}.`);
    return 0;
  }

  if (sub === "ledger") {
    const days = subargs[1] === undefined ? 7 : Number(subargs[1]);
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      io.error("ledger takes a number of days, 1–90");
      return 1;
    }
    const settings = loadReachOutSettings(home);
    const now = (io.now ?? (() => new Date()))();
    const agg = aggregateLedger(readLedger(home), days, now, settings.quietHours.tz);
    io.log(`Reach-out, last ${agg.days} day(s) (since ${agg.since})\n`);
    io.log("  source     delivered  deferred  dropped  pushed  useful  dismissed");
    for (const s of REACH_OUT_SOURCES) {
      const t = agg.bySource[s];
      if (t.delivered + t.deferred + t.dropped === 0) continue;
      io.log(
        `  ${s.padEnd(9)}  ${String(t.delivered).padStart(9)}  ${String(t.deferred).padStart(8)}  ${String(t.dropped).padStart(7)}  ${String(t.interrupted).padStart(6)}  ${String(t.useful).padStart(6)}  ${String(t.dismissed).padStart(9)}`,
      );
    }
    const reached = agg.totals.delivered + agg.totals.deferred;
    io.log(
      `\n  ${reached} reached you · ${agg.totals.dropped} dropped · useful rate ` +
        (agg.usefulRate === null ? "n/a" : `${Math.round(agg.usefulRate * 100)}%`) +
        " (target ≥ 60%)",
    );
    return 0;
  }

  io.error(USAGE);
  return sub === "help" || sub === "--help" ? 0 : 1;
}

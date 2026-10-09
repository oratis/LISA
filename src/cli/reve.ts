/**
 * `lisa reve` — the auditable Dream log (docs/DESIGN_REVE_DREAMS.md). Thin CLI
 * over src/reve; the web `/api/reve/*` routes read and write the same files.
 *
 *   lisa reve dreams [--limit n] [--json]
 *   lisa reve show <id> [--json]
 *   lisa reve revert <id> --parts memory,kb[,skills] [--force]
 *   lisa reve reconsider <id> "<note>"
 *   lisa reve metrics [--days n] [--json]
 */
import { metricsSeries, renderMetricsTable, clampDays } from "../reve/metrics.js";
import { listReconsiderRequests, requestReconsider, ReconsiderError } from "../reve/reconsider.js";
import { RevertConflictError, RevertInputError, revertDream } from "../reve/revert.js";
import {
  CorruptDreamError,
  DreamNotFoundError,
  listDreams,
  readDream,
  readDreamsSince,
} from "../reve/store.js";
import type { DreamRecord } from "../reve/types.js";

export interface ReveCliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  now?: () => Date;
}

const defaultIo: ReveCliIo = {
  log: (l) => console.log(l),
  error: (l) => console.error(l),
};

const USAGE = [
  "usage:",
  "  lisa reve dreams [--limit n] [--json]        recent dreams (newest first)",
  "  lisa reve show <id> [--json]                 one dream: changes, soul commits, diffs",
  "  lisa reve revert <id> --parts memory,kb[,skills] [--force]",
  "                                               undo that dream's changes to YOUR data",
  '  lisa reve reconsider <id> "<note>"           ask Lisa to reconsider her soul changes',
  "  lisa reve metrics [--days n] [--json]        coherence drift time series",
].join("\n");

/** Pull `--flag value` / `--flag=value` / boolean `--flag` out of args. */
function takeFlag(args: string[], name: string, hasValue: boolean): string | boolean | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === `--${name}`) {
      args.splice(i, 1);
      if (!hasValue) return true;
      const v = args[i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      args.splice(i, 1);
      return v;
    }
    if (hasValue && a.startsWith(`--${name}=`)) {
      args.splice(i, 1);
      return a.slice(name.length + 3);
    }
  }
  return undefined;
}

function renderDream(
  rec: DreamRecord,
  reconsider: Awaited<ReturnType<typeof listReconsiderRequests>>,
): string {
  const out = [
    `${rec.id}`,
    rec.summary,
    `  window:  ${rec.windowStart} → ${rec.windowEnd}`,
    `  capture: ${rec.capture}${rec.truncated ? " (diffs trimmed)" : ""}`,
  ];
  if (rec.changes.length) {
    out.push("", "changes:");
    for (const c of rec.changes) {
      const owner = c.part === "soul" ? "Lisa's" : c.revertible ? "revertible" : "not revertible";
      out.push(
        `  [${c.part}] ${c.path}  ${c.status} +${c.linesAdded}/-${c.linesRemoved}  (${owner})`,
      );
      for (const line of c.diff.split("\n").slice(0, 12)) if (line) out.push(`      ${line}`);
    }
  }
  if (rec.soulCommits.length) {
    out.push("", "soul commits:");
    for (const c of rec.soulCommits) out.push(`  ${c.sha.slice(0, 10)}  ${c.subject}`);
  }
  if (rec.reverts.length) {
    out.push("", "reverts:");
    for (const r of rec.reverts) {
      out.push(
        `  ${r.at}  ${r.parts.join(",")}  ${r.files.length} file(s)${r.forced ? " (forced)" : ""}`,
      );
    }
  }
  if (reconsider.length) {
    out.push("", "reconsider requests:");
    for (const r of reconsider) out.push(`  ${r.id}  ${r.status}  «${r.note.slice(0, 120)}»`);
  }
  return out.join("\n");
}

export async function runReveCommand(argv: string[], io: ReveCliIo = defaultIo): Promise<number> {
  const args = [...argv];
  const sub = args.shift() ?? "dreams";
  try {
    if (sub === "help" || sub === "--help" || sub === "-h") {
      io.log(USAGE);
      return 0;
    }
    if (sub === "dreams" || sub === "list") {
      const json = takeFlag(args, "json", false) === true;
      const limitRaw = takeFlag(args, "limit", true);
      const limit = limitRaw === undefined ? 20 : parseInt(String(limitRaw), 10);
      if (!Number.isFinite(limit) || limit < 1)
        throw new Error("--limit must be a positive integer");
      const listing = await listDreams(limit);
      if (json) {
        io.log(JSON.stringify(listing, null, 2));
        return 0;
      }
      if (listing.dreams.length === 0) io.log("No dreams recorded yet.");
      for (const d of listing.dreams) {
        const revert = d.revertibleParts.length
          ? `  [revertible: ${d.revertibleParts.join(",")}]`
          : "";
        io.log(`${d.id}  ${d.summary}${d.reverted ? "  (reverted)" : ""}${revert}`);
      }
      if (listing.corrupt.length) io.error(`(${listing.corrupt.length} corrupt record(s) skipped)`);
      return 0;
    }
    if (sub === "show") {
      const json = takeFlag(args, "json", false) === true;
      const id = args.shift();
      if (!id) throw new Error("show needs a dream id");
      const rec = await readDream(id);
      const reconsider = await listReconsiderRequests(id);
      io.log(
        json ? JSON.stringify({ dream: rec, reconsider }, null, 2) : renderDream(rec, reconsider),
      );
      return 0;
    }
    if (sub === "revert") {
      const force = takeFlag(args, "force", false) === true;
      const parts = takeFlag(args, "parts", true);
      const id = args.shift();
      if (!id) throw new Error("revert needs a dream id");
      if (typeof parts !== "string") throw new Error("revert needs --parts memory,kb,skills");
      const res = await revertDream(id, { parts, force, actor: "cli" });
      io.log(
        `Reverted ${res.reverted.length} file(s) from ${id}` +
          (res.alreadyReverted.length ? `; ${res.alreadyReverted.length} already restored` : "") +
          (res.skipped.length ? `; skipped (no pre-dream copy): ${res.skipped.join(", ")}` : ""),
      );
      for (const p of res.reverted) io.log(`  ${p}`);
      return 0;
    }
    if (sub === "reconsider") {
      const id = args.shift();
      const note = args.join(" ");
      if (!id)
        throw new Error(
          'reconsider needs a dream id and a note: lisa reve reconsider <id> "<note>"',
        );
      const req = await requestReconsider(id, note);
      io.log(
        `Queued ${req.id}. Lisa will see your note in her next reflection and decide for herself — ` +
          `her soul is hers to change.`,
      );
      return 0;
    }
    if (sub === "metrics") {
      const json = takeFlag(args, "json", false) === true;
      const days = clampDays(takeFlag(args, "days", true) ?? 30);
      const now = io.now?.() ?? new Date();
      const records = await readDreamsSince(now.getTime() - days * 24 * 60 * 60_000);
      const series = metricsSeries(records, { days, now });
      io.log(json ? JSON.stringify(series, null, 2) : renderMetricsTable(series));
      return 0;
    }
    io.error(`unknown subcommand: ${sub}\n${USAGE}`);
    return 2;
  } catch (err) {
    if (err instanceof RevertConflictError) {
      io.error(`${err.message}:`);
      for (const c of err.conflicts) io.error(`  ${c.path} — ${c.reason.replace("_", " ")}`);
      io.error("Re-run with --force to overwrite files changed since the dream.");
      return 3;
    }
    if (err instanceof DreamNotFoundError || err instanceof CorruptDreamError) {
      io.error(err.message);
      return 1;
    }
    if (err instanceof RevertInputError || err instanceof ReconsiderError) {
      io.error(err.message);
      return 2;
    }
    io.error((err as Error).message);
    return 2;
  }
}

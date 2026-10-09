/**
 * Memory-sovereignty CLI (W8):
 *
 *   lisa forget "<topic>" [--dry-run] [--yes] [--json]
 *   lisa export [--out <file.tar.gz>] [--include-sessions] [--force]
 *   lisa import <file.tar.gz> [--into <home>] [--replace]
 *
 * All three act on this machine's home (`LISA_HOME`, default ~/.lisa); `--into`
 * lets an operator import into another home (e.g. a cloud tenant's subtree).
 * Forget asks before it writes unless `--yes`; it refuses to run destructively
 * without a TTY or `--yes`.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { lisaGlobalHome, lisaHome } from "../paths.js";
import { forget, ForgetError, FORGET_LAYERS, type ForgetReport } from "../sovereignty/forget.js";
import { exportFileName, exportLisaToFile } from "../sovereignty/export.js";
import { ImportError, importLisa } from "../sovereignty/import.js";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Ask a yes/no question; resolve true for yes. Null when not interactive. */
  confirm: ((question: string) => Promise<boolean>) | null;
}

function defaultIo(): CliIo {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    confirm: process.stdin.isTTY
      ? async (q) => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : null,
  };
}

interface Parsed {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

function parse(args: string[], valued: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (valued.includes(name)) {
      const v = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : args[++i];
      if (!v) throw new Error(`${name} requires a value`);
      out.values.set(name, v);
    } else if (a.startsWith("--")) {
      out.flags.add(a);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function summarize(report: ForgetReport, io: CliIo): void {
  const total = FORGET_LAYERS.reduce((n, l) => n + report.counts[l], 0);
  io.out(report.dryRun ? "Forget — preview (nothing changed yet):" : "Forget — done:");
  if (report.dryRun) io.out(`  ${report.match.note}`);
  for (const layer of FORGET_LAYERS) {
    if (report.counts[layer] > 0) io.out(`  ${layer.padEnd(16)} ${report.counts[layer]}`);
  }
  if (total === 0) io.out("  (no mentions found)");
  if (report.locations.length) {
    io.out(report.dryRun ? "What will change:" : "What changed:");
    for (const l of report.locations) {
      const why = l.why ? ` [${l.why}]` : "";
      io.out(`  ${l.action.padEnd(7)} ${l.location} (${l.matches})${why}`);
      if (l.snippet) io.out(`          “${l.snippet}”`);
    }
  }
  if (report.untouched.length) {
    io.out("Mentioned but not edited (Lisa's own soul files; KB file names):");
    for (const u of report.untouched) {
      io.out(`  ${u.location} (${u.matches})${u.why ? ` [${u.why}]` : ""}`);
    }
  }
  for (const e of report.errors) io.err(`  ! ${e.layer}: ${e.error}`);
  if (report.remaining) {
    const left = FORGET_LAYERS.filter((l) => report.remaining![l] > 0);
    io.out(
      left.length
        ? `Still matching after forget: ${left.join(", ")}`
        : "Verified: no layer still matches.",
    );
  }
  io.out("What forget cannot reach:");
  for (const r of report.residuals) io.out(`  - ${r}`);
}

export async function runForgetCommand(args: string[], io: CliIo = defaultIo()): Promise<number> {
  let p: Parsed;
  try {
    p = parse(args, []);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const query = p.positional.join(" ");
  if (!query || p.flags.has("--help")) {
    io.err('usage: lisa forget "<topic>" [--dry-run] [--yes] [--json]');
    return query ? 0 : 2;
  }
  const json = p.flags.has("--json");
  try {
    const preview = await forget(query, { dryRun: true });
    if (p.flags.has("--dry-run")) {
      if (json) io.out(JSON.stringify(preview, null, 2));
      else summarize(preview, io);
      return 0;
    }
    const total = FORGET_LAYERS.reduce((n, l) => n + preview.counts[l], 0);
    if (total === 0) {
      if (json) io.out(JSON.stringify(preview, null, 2));
      else summarize(preview, io);
      return 0;
    }
    if (!p.flags.has("--yes")) {
      if (!io.confirm) {
        io.err("refusing to forget without confirmation: re-run on a terminal or pass --yes");
        return 2;
      }
      if (!json) summarize(preview, io);
      if (!(await io.confirm(`Forget ${total} mention(s) across ${lisaHome()}?`))) {
        io.out("Cancelled; nothing changed.");
        return 1;
      }
    } else if (!json) {
      summarize(preview, io);
    }
    // Apply exactly what the preview listed; refused if anything changed since.
    const report = await forget(query, { digest: preview.digest });
    if (json) io.out(JSON.stringify(report, null, 2));
    else summarize(report, io);
    return report.errors.length ? 1 : 0;
  } catch (e) {
    if (e instanceof ForgetError) {
      io.err(e.message);
      return e.code === "preview_changed" ? 1 : 2;
    }
    throw e;
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function runExportCommand(args: string[], io: CliIo = defaultIo()): Promise<number> {
  let p: Parsed;
  try {
    p = parse(args, ["--out"]);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  if (p.flags.has("--help")) {
    io.out("usage: lisa export [--out <file.tar.gz>] [--include-sessions] [--force]");
    return 0;
  }
  const out = path.resolve(p.values.get("--out") ?? exportFileName());
  if (fs.existsSync(out) && !p.flags.has("--force")) {
    io.err(`${out} already exists (pass --force to overwrite)`);
    return 2;
  }
  const manifest = await exportLisaToFile(
    { home: lisaHome(), includeSessions: p.flags.has("--include-sessions") },
    out,
  );
  const bytes = manifest.files.reduce((n, f) => n + f.size, 0);
  io.out(`Exported ${manifest.files.length} file(s), ${humanBytes(bytes)} → ${out}`);
  io.out(
    manifest.includesSessions
      ? "Includes session transcripts."
      : "Session transcripts not included (pass --include-sessions).",
  );
  if (manifest.skipped) io.out(`Skipped ${manifest.skipped} link(s)/special file(s).`);
  io.out(
    "Never exported: secrets, keys, accounts, devices, billing, warden/, task leases/locks/outbox.",
  );
  return 0;
}

export async function runImportCommand(args: string[], io: CliIo = defaultIo()): Promise<number> {
  let p: Parsed;
  try {
    p = parse(args, ["--into"]);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const file = p.positional[0];
  if (!file || p.flags.has("--help")) {
    io.err("usage: lisa import <file.tar.gz> [--into <home>] [--replace]");
    return file ? 0 : 2;
  }
  const into = path.resolve(p.values.get("--into") ?? lisaGlobalHome());
  try {
    const r = await importLisa(path.resolve(file), { into, replace: p.flags.has("--replace") });
    io.out(
      `Imported ${r.files} file(s), ${humanBytes(r.bytes)} into ${r.into} (${r.roots.join(", ")}).`,
    );
    if (r.backup) io.out(`Previous data backed up to ${r.backup}`);
    if (r.tasksDisabled)
      io.out(`${r.tasksDisabled} task(s) imported disabled — review and re-enable them.`);
    io.out("Restart Lisa (lisa serve) so she picks up the imported soul.");
    return 0;
  } catch (e) {
    if (e instanceof ImportError) {
      io.err(`import refused (${e.code}): ${e.message}`);
      return 2;
    }
    throw e;
  }
}

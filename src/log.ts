/**
 * Operational logging with real severities.
 *
 * The Mac edition historically logs everything through console.error so the
 * CLI's stdout stays free for the REPL — fine locally, but on Cloud Run every
 * stderr line is ingested as severity=ERROR, which makes "resuming session"
 * indistinguishable from an actual failure and poisons any log-based alerting
 * (the whole service reads as a wall of errors).
 *
 * On Cloud Run (K_SERVICE is set by the platform) — or when LISA_LOG_FORMAT=json
 * is forced — each line is emitted as one-line structured JSON. Cloud Logging
 * lifts the `severity` field, so INFO is INFO and alerts can key on ERROR.
 * Everywhere else the text goes to stderr exactly as before, so local behavior
 * is unchanged. LISA_LOG_FORMAT=text forces the legacy mode even on Cloud Run.
 *
 * LISA_LOG_FILE adds a third mode (T-6). A long-lived backend supervised by
 * launchd writes into StandardOutPath forever: nothing rotates it, and the
 * v0.24 review found multi-hundred-MB serve logs on daily-driver machines.
 * When LISA_LOG_FILE points at a path, log lines go THERE — appended,
 * timestamped, and rotated at 10 MB with 5 generations kept — instead of to
 * the console. Instead, not in addition: the point of the file sink is that
 * the process owns rotation of its main log, which is defeated if every line
 * is also duplicated into an unrotated StandardOutPath. `lisa autostart
 * install` therefore sets LISA_LOG_FILE=~/.lisa/serve.log and aims launchd's
 * own capture at ~/.lisa/serve.launchd.log, which then only collects what
 * escapes this module (crash stacks, node warnings, third-party console
 * output) and stays small. With the variable unset nothing changes.
 */
import fs from "node:fs";
import path from "node:path";

export type LogSeverity = "INFO" | "WARNING" | "ERROR";

function structuredMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LISA_LOG_FORMAT === "json") return true;
  if (env.LISA_LOG_FORMAT === "text") return false;
  return !!env.K_SERVICE;
}

/** One structured log line (exported for tests). */
export function formatStructured(severity: LogSeverity, message: string): string {
  return JSON.stringify({ severity, message });
}

/** Rotate once the live file would pass this size. */
export const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Generations kept beside the live file: `.1` … `.5`. */
export const LOG_FILE_KEEP = 5;

interface FileSink {
  /** The resolved LISA_LOG_FILE value this sink is open on. */
  path: string;
  fd: number;
  /** Bytes in the live file — tracked rather than stat'd on every line. */
  size: number;
}

let sink: FileSink | null = null;
/** Paths we already failed to open; retrying every line would be its own bug. */
const brokenPaths = new Set<string>();

function closeSink(): void {
  if (!sink) return;
  try {
    fs.closeSync(sink.fd);
  } catch {
    // Already closed, or the fd died with the process's stdio. Either way the
    // sink is being dropped — there is nothing left to recover.
  }
  sink = null;
}

/**
 * The sink for the current LISA_LOG_FILE, opening (or re-opening) it as the
 * env var changes. Reading the variable per line is deliberate: it keeps the
 * module free of init order requirements and lets tests point the sink at a
 * temp dir and back without an exported reset hook.
 */
function fileSink(env: NodeJS.ProcessEnv = process.env): FileSink | null {
  const target = env.LISA_LOG_FILE?.trim();
  if (!target) {
    closeSink();
    return null;
  }
  if (sink && sink.path === target) return sink;
  closeSink();
  if (brokenPaths.has(target)) return null;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // "a" is atomic-append on POSIX, so a second process (an overlapping
    // restart, say) interleaves whole lines instead of corrupting them.
    const fd = fs.openSync(target, "a");
    sink = { path: target, fd, size: fs.fstatSync(fd).size };
  } catch (err) {
    brokenPaths.add(target);
    console.error(
      `[log] cannot open LISA_LOG_FILE ${target}: ${(err as Error).message} — logging to stderr`,
    );
    sink = null;
  }
  return sink;
}

/**
 * `serve.log` → `serve.log.1`, `.1` → `.2`, …, and the oldest generation is
 * dropped. Renames are cheap and keep readers that hold the old fd working
 * (they just keep writing to the now-renamed inode until they reopen).
 */
function rotate(s: FileSink): void {
  try {
    fs.closeSync(s.fd);
  } catch {
    // The fd is being replaced regardless; a failed close cannot stop rotation.
  }
  try {
    fs.rmSync(`${s.path}.${LOG_FILE_KEEP}`, { force: true });
  } catch {
    // The oldest generation may not exist yet, and force:true already swallows
    // ENOENT — anything else (a locked file) must not abort the rotation.
  }
  for (let i = LOG_FILE_KEEP - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${s.path}.${i}`, `${s.path}.${i + 1}`);
    } catch {
      // Generation absent — normal before the log has rotated KEEP times.
    }
  }
  try {
    fs.renameSync(s.path, `${s.path}.1`);
  } catch {
    // Someone moved or deleted the live log under us; reopening below restores
    // a working sink, which matters more than preserving this generation.
  }
  const fd = fs.openSync(s.path, "a");
  s.fd = fd;
  s.size = fs.fstatSync(fd).size;
}

/** The line written to LISA_LOG_FILE. Exported for tests. */
export function formatFileLine(
  severity: LogSeverity,
  message: string,
  at: Date = new Date(),
): string {
  // Always timestamped text, whatever LISA_LOG_FORMAT says: that variable
  // describes what the *platform's* log collector wants from stdout/stderr,
  // while this file is read by a human with `tail -f`.
  return `${at.toISOString()} ${severity} ${message}\n`;
}

/** @returns true when the line was written to the file sink. */
function writeToFile(severity: LogSeverity, message: string): boolean {
  const s = fileSink();
  if (!s) return false;
  const buf = Buffer.from(formatFileLine(severity, message), "utf8");
  try {
    // `s.size > 0` so a single line larger than the cap cannot rotate forever.
    if (s.size > 0 && s.size + buf.length > LOG_FILE_MAX_BYTES) rotate(s);
    fs.writeSync(s.fd, buf);
    s.size += buf.length;
    return true;
  } catch (err) {
    // A broken sink must never take the process down or swallow the line.
    brokenPaths.add(s.path);
    closeSink();
    console.error(
      `[log] LISA_LOG_FILE write failed: ${(err as Error).message} — logging to stderr`,
    );
    return false;
  }
}

function emit(severity: LogSeverity, message: string): void {
  if (writeToFile(severity, message)) return;
  if (structuredMode()) {
    const stream = severity === "INFO" ? process.stdout : process.stderr;
    stream.write(formatStructured(severity, message) + "\n");
  } else {
    console.error(message);
  }
}

export function logInfo(message: string): void {
  emit("INFO", message);
}

export function logWarn(message: string): void {
  emit("WARNING", message);
}

export function logError(message: string): void {
  emit("ERROR", message);
}

/**
 * Release the LISA_LOG_FILE descriptor. Not needed at process exit (the OS
 * reclaims it) — it exists so tests, and any future in-process restart, don't
 * leave a temp directory pinned open.
 */
export function closeLogFile(): void {
  closeSink();
}

/**
 * Redaction for log lines. Logs are operational telemetry, not an audit trail —
 * the full identifiers live in the billing ledger / account store. Keeping a
 * short prefix+suffix is enough to correlate a log line with a ledger row
 * without making the log stream itself a directory of uids / transaction ids.
 */
export function redactId(id: string): string {
  if (!id) return "";
  if (id.length <= 8) return id.slice(0, 2) + "…";
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

/**
 * `alice.smith@example.com` → `al***@example.com`. The local part is the
 * identifying half, so it goes; the domain stays whole because that's what you
 * group by when delivery breaks. Anything that isn't an address becomes `***`.
 */
export function redactEmail(addr: string): string {
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return "***";
  return `${addr.slice(0, Math.min(2, at))}***@${addr.slice(at + 1)}`;
}

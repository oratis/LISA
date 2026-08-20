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
 */

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

function emit(severity: LogSeverity, message: string): void {
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

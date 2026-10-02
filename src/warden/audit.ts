/**
 * Warden audit log — append-only JSONL at `<home>/warden/audit.jsonl`.
 *
 * One line per decision and one per resolution. Entries are built from an
 * explicit field list, never by spreading a request: the log holds the
 * redacted preview, the payload digest, category, masked targets, verdict and
 * latency — never a raw tool input, token, OTP or message body
 * (INVARIANTS §权限与工具 5).
 *
 * Rotation: the active file is rolled when it crosses a size cap or a UTC day
 * boundary; rolled files are pruned after ~30 days.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { logWarn } from "../log.js";
import { auditTargets, maskEmails, redactSecrets } from "./preview.js";
import { wardenDir } from "./store.js";
import type { ActionRequest, Decision, GrantScope } from "./types.js";

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIT_RETENTION_DAYS = 30;
const AUDIT_MAX_ROLLED_FILES = 120;
const ACTIVE = "audit.jsonl";
const ROLLED = /^audit-(\d{8})-(\d+)\.jsonl$/;

export type AuditKind = "decision" | "resolution" | "grant_revoked" | "rules_updated";
export type Resolution = "approved" | "denied" | "expired" | "dismissed" | "cancelled";

export interface AuditEntry {
  at: string;
  kind: AuditKind;
  requestId?: string;
  approvalId?: string;
  uid?: string | null;
  surface?: string;
  origin?: string;
  originId?: string;
  taskId?: string;
  tool?: string;
  method?: string;
  connector?: string;
  category?: string;
  targets?: string[];
  dataClasses?: string[];
  digest?: string;
  preview?: string;
  sandboxed?: boolean;
  tainted?: boolean;
  verdict?: string;
  reason?: string;
  ruleId?: string;
  grantId?: string;
  resolution?: Resolution;
  scope?: GrantScope;
  latencyMs?: number;
  note?: string;
}

export function auditFile(home?: string): string {
  return path.join(wardenDir(home), ACTIVE);
}

function clip(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  // The card shows the user the real recipient; the log keeps only a masked one.
  const safe = maskEmails(redactSecrets(text));
  return safe.length <= max ? safe : safe.slice(0, max - 1) + "…";
}

/** The audit-safe projection of a request. Field-by-field on purpose. */
function requestFields(req: ActionRequest): Partial<AuditEntry> {
  return {
    requestId: req.id,
    uid: req.uid,
    surface: req.surface,
    origin: req.origin.kind,
    originId: clip(req.origin.id, 80),
    taskId: clip(req.taskId, 80),
    tool: clip(req.tool, 120),
    method: clip(req.method, 80),
    connector: clip(req.connector, 80),
    category: req.category,
    targets: auditTargets(req.targets),
    dataClasses: [...req.dataClasses],
    digest: req.digest,
    preview: clip(req.preview, 240),
    sandboxed: req.sandboxed,
    tainted: req.tainted,
  };
}

function dayStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

async function rotateIfNeeded(dir: string, now: number): Promise<void> {
  const active = path.join(dir, ACTIVE);
  let stat;
  try {
    stat = await fs.stat(active);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const crossedDay = dayStamp(stat.mtimeMs) !== dayStamp(now);
  if (stat.size < AUDIT_MAX_BYTES && !crossedDay) return;
  await fs.rename(active, path.join(dir, `audit-${dayStamp(stat.mtimeMs)}-${now}.jsonl`));
  await prune(dir, now);
}

async function rolledFiles(dir: string): Promise<Array<{ name: string; day: string; seq: number }>> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const match = ROLLED.exec(name);
      return match ? { name, day: match[1]!, seq: Number(match[2]) } : null;
    })
    .filter((entry): entry is { name: string; day: string; seq: number } => entry !== null)
    .sort((a, b) => b.seq - a.seq);
}

async function prune(dir: string, now: number): Promise<void> {
  const cutoff = dayStamp(now - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const rolled = await rolledFiles(dir);
  for (const [index, file] of rolled.entries()) {
    if (file.day >= cutoff && index < AUDIT_MAX_ROLLED_FILES) continue;
    await fs.rm(path.join(dir, file.name), { force: true });
  }
}

/** Per-directory append chain: keeps lines ordered and rotation race-free in-process. */
const chains = new Map<string, Promise<void>>();

/**
 * Append one entry. REJECTS when the line could not be written — callers that
 * are about to allow a side effect must treat that as "no audit record ⇒ do
 * not act".
 */
export function appendAudit(
  entry: AuditEntry,
  home?: string,
  now: number = Date.now(),
): Promise<void> {
  const dir = wardenDir(home);
  const previous = chains.get(dir) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await rotateIfNeeded(dir, now);
      await fs.appendFile(path.join(dir, ACTIVE), JSON.stringify(entry) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    });
  chains.set(dir, next);
  void next
    .catch(() => undefined)
    .then(() => {
      if (chains.get(dir) === next) chains.delete(dir);
    });
  return next;
}

/** Record a policy decision. */
export function auditDecision(
  req: ActionRequest,
  decision: Decision,
  opts: { home?: string; latencyMs?: number; now?: number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  return appendAudit(
    {
      at: new Date(now).toISOString(),
      kind: "decision",
      ...requestFields(req),
      verdict: decision.verdict,
      reason: clip(decision.reason, 240),
      ruleId: clip(decision.ruleId, 120),
      grantId: decision.grantId,
      latencyMs: opts.latencyMs,
    },
    opts.home,
    now,
  );
}

/** Record how a pending approval ended. */
export function auditResolution(
  req: ActionRequest,
  resolution: Resolution,
  opts: {
    home?: string;
    approvalId?: string;
    scope?: GrantScope;
    grantId?: string;
    latencyMs?: number;
    note?: string;
    now?: number;
  } = {},
): Promise<void> {
  const now = opts.now ?? Date.now();
  return appendAudit(
    {
      at: new Date(now).toISOString(),
      kind: "resolution",
      ...requestFields(req),
      approvalId: opts.approvalId,
      resolution,
      scope: opts.scope,
      grantId: opts.grantId,
      latencyMs: opts.latencyMs,
      // A user-typed deny reason is free text: clip and mask it like anything else.
      note: clip(opts.note, 160),
    },
    opts.home,
    now,
  );
}

/** Best-effort variant for paths that must not throw (expiry timers, shutdown). */
export async function auditQuietly(write: Promise<void>): Promise<void> {
  try {
    await write;
  } catch (err) {
    logWarn(`[warden] audit write failed: ${(err as Error).message}`);
  }
}

function parseLines(raw: string): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as AuditEntry);
      }
    } catch {
      /* a torn line (crash mid-append) is skipped, not fatal */
    }
  }
  return out;
}

/** Most recent entries first. Reads rolled files only as far as `limit` needs. */
export async function readAudit(
  opts: { home?: string; limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 1000));
  const dir = wardenDir(opts.home);
  const files = [ACTIVE, ...(await rolledFiles(dir)).map((file) => file.name)];
  const out: AuditEntry[] = [];
  for (const name of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    const entries = parseLines(raw).reverse();
    out.push(...entries.slice(0, limit - out.length));
    if (out.length >= limit) break;
  }
  return out;
}

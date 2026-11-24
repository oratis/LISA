/**
 * Memory / knowledge / soul write provenance built on Warden's audit trail.
 *
 * Warden already records every tool decision in `<home>/warden/audit.jsonl`
 * with `tainted`, `origin`, `originId`, `taskId`, `tool`, `targets` (masked),
 * `preview` (redacted), `digest`, and `verdict`. This module projects those
 * redacted audit records into a queryable provenance graph so the owner (or
 * Lisa) can inspect which writes to persistent self-state (`memory`,
 * `soul_patch`, `soul_journal`, `kb_write`, `kb_add`, `skill_manage`, etc.)
 * happened during a tainted run and trace them back to the external sources
 * that tainted the same conversation or task run.
 *
 * Security invariants:
 *  - Reads ONLY from the caller's scoped `home` (never crosses tenants).
 *  - Operates strictly on Warden's already-redacted audit records; never reads
 *    raw payloads, secrets, or session transcripts.
 */
import { readAudit, type AuditEntry } from "./audit.js";

/** Builtin tools that persist state read back into future, untainted turns. */
export const PERSISTENT_SELF_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "memory",
  "soul_patch",
  "soul_journal",
  "soul_feel",
  "soul_object",
  "desire_progress_log",
  "desire_revise",
  "desire_close",
  "kb_write",
  "kb_add",
  "skill_manage",
]);

/** Tools whose outputs commonly introduce untrusted external text (taint). */
const TAINT_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  "web_fetch",
  "web_search",
  "kb_add",
  "takoapi",
  "github",
  "npm_info",
]);

export interface ProvenanceSourceRef {
  at: string;
  requestId?: string;
  tool: string;
  targets: string[];
  preview?: string;
}

export interface ProvenanceRecord {
  at: string;
  requestId?: string;
  tool: string;
  category?: string;
  origin?: string;
  originId?: string;
  taskId?: string;
  targets: string[];
  preview?: string;
  digest?: string;
  verdict?: string;
  tainted: boolean;
  /** Earlier external/taint-source reads observed in the same run/conversation. */
  linkedSources: ProvenanceSourceRef[];
}

export interface ProvenanceQuery {
  home?: string;
  /** Return only writes performed while the run was tainted. */
  taintedOnly?: boolean;
  /** Filter by exact tool name (e.g. "memory", "kb_write", "soul_patch"). */
  tool?: string;
  /** Filter by conversation / channel / routine originId. */
  originId?: string;
  /** Filter by taskId. */
  taskId?: string;
  /** Maximum provenance write records to return (1..200, default 50). */
  limit?: number;
  /** Maximum audit entries to scan (1..1000, default 500). */
  scanLimit?: number;
}

export interface ProvenanceReport {
  records: ProvenanceRecord[];
  totalWritesScanned: number;
  taintedWritesScanned: number;
  toolsTouched: string[];
}

function isPersistentWrite(entry: AuditEntry): boolean {
  if (entry.kind !== "decision") return false;
  if (!entry.tool) return false;
  if (entry.verdict && entry.verdict !== "allow") return false;
  if (PERSISTENT_SELF_WRITE_TOOLS.has(entry.tool)) {
    // `memory` and `skill_manage` also have read actions; exclude category === "read".
    return entry.category !== "read";
  }
  return entry.category === "self";
}

function isPotentialTaintSource(entry: AuditEntry): boolean {
  if (entry.kind !== "decision" || !entry.tool) return false;
  if (entry.verdict && entry.verdict !== "allow") return false;
  if (TAINT_SOURCE_TOOLS.has(entry.tool)) return true;
  if (entry.tool.startsWith("mcp__")) return true;
  return entry.category === "network";
}

function scopeKey(entry: AuditEntry): string | null {
  if (entry.taskId) return `task:${entry.taskId}`;
  if (entry.originId) return `origin:${entry.origin ?? ""}:${entry.originId}`;
  return null;
}

/** Pure projection from newest-first audit entries to a ProvenanceReport. */
export function buildProvenanceReport(
  entries: readonly AuditEntry[],
  opts: Pick<ProvenanceQuery, "taintedOnly" | "tool" | "originId" | "taskId" | "limit"> = {},
): ProvenanceReport {
  const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 50), 200));
  // Index potential taint sources by conversation/task scope, oldest-first.
  const sourcesByScope = new Map<string, ProvenanceSourceRef[]>();
  const chronological = [...entries].reverse();
  for (const entry of chronological) {
    if (!isPotentialTaintSource(entry)) continue;
    const key = scopeKey(entry);
    if (!key) continue;
    const list = sourcesByScope.get(key) ?? [];
    if (list.length < 20) {
      list.push({
        at: entry.at,
        requestId: entry.requestId,
        tool: entry.tool!,
        targets: entry.targets ? [...entry.targets] : [],
        preview: entry.preview,
      });
      sourcesByScope.set(key, list);
    }
  }

  let totalWritesScanned = 0;
  let taintedWritesScanned = 0;
  const toolsTouched = new Set<string>();
  const records: ProvenanceRecord[] = [];

  for (const entry of entries) {
    if (!isPersistentWrite(entry)) continue;
    if (opts.tool && entry.tool !== opts.tool) continue;
    if (opts.originId && entry.originId !== opts.originId) continue;
    if (opts.taskId && entry.taskId !== opts.taskId) continue;

    totalWritesScanned++;
    const tainted = entry.tainted === true;
    if (tainted) taintedWritesScanned++;
    if (opts.taintedOnly && !tainted) continue;

    toolsTouched.add(entry.tool!);
    if (records.length >= limit) continue;

    const key = scopeKey(entry);
    const linkedSources =
      tainted && key
        ? (sourcesByScope.get(key) ?? []).filter((src) => src.at <= entry.at).slice(-10)
        : [];

    records.push({
      at: entry.at,
      requestId: entry.requestId,
      tool: entry.tool!,
      category: entry.category,
      origin: entry.origin,
      originId: entry.originId,
      taskId: entry.taskId,
      targets: entry.targets ? [...entry.targets] : [],
      preview: entry.preview,
      digest: entry.digest,
      verdict: entry.verdict,
      tainted,
      linkedSources,
    });
  }

  return {
    records,
    totalWritesScanned,
    taintedWritesScanned,
    toolsTouched: [...toolsTouched].sort(),
  };
}

/** Query provenance records from Warden's audit log for one tenant home. */
export async function queryProvenance(query: ProvenanceQuery = {}): Promise<ProvenanceReport> {
  const scanLimit = Math.max(1, Math.min(Math.floor(query.scanLimit ?? 500), 1000));
  const entries = await readAudit({ home: query.home, limit: scanLimit });
  return buildProvenanceReport(entries, query);
}

/**
 * Memory-sovereignty audit log — append-only JSONL at
 * `<home>/sovereignty/audit.jsonl` (the ACTIVE home, so tenant-scoped).
 *
 * One line per user edit, forget, export or import. Lines carry ids, counts
 * and layer names only — never entry text, the forget query or file content
 * (INVARIANTS §权限与工具 5). The directory is excluded from exports.
 */
import path from "node:path";
import { appendLine } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import { logWarn } from "../log.js";

export type SovereigntyAction =
  | "memory.append"
  | "memory.replace"
  | "memory.delete"
  | "forget.dry_run"
  | "forget.apply"
  | "export"
  | "import";

export interface SovereigntyAuditEvent {
  action: SovereigntyAction;
  store?: string;
  id?: string;
  newId?: string;
  /** Per-layer counts (forget) or file counts (export/import). */
  counts?: Record<string, number>;
  bytes?: number;
  note?: string;
}

export function sovereigntyDir(home: string = lisaHome()): string {
  return path.join(home, "sovereignty");
}

export function sovereigntyAuditFile(home: string = lisaHome()): string {
  return path.join(sovereigntyDir(home), "audit.jsonl");
}

/** Best-effort: an audit write failure is logged, never fails the edit. */
export async function appendSovereigntyAudit(
  event: SovereigntyAuditEvent,
  home: string = lisaHome(),
): Promise<void> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    action: event.action,
    ...(event.store ? { store: event.store } : {}),
    ...(event.id ? { id: event.id } : {}),
    ...(event.newId ? { newId: event.newId } : {}),
    ...(event.counts ? { counts: event.counts } : {}),
    ...(typeof event.bytes === "number" ? { bytes: event.bytes } : {}),
    ...(event.note ? { note: event.note.slice(0, 200) } : {}),
  });
  try {
    await appendLine(sovereigntyAuditFile(home), line);
  } catch (e) {
    logWarn(`[sovereignty] audit write failed: ${(e as Error).message.slice(0, 120)}`);
  }
}

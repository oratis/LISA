/**
 * User revert of USER-owned data from a dream: memory, KB pages, and any
 * skills/<name>/SKILL.md that changed during the dream window (whoever changed
 * it — Lisa in the pass or a concurrent chat). Soul files are never touched
 * here — they are Lisa's (see reconsider.ts for the user's lever over those).
 *
 * Memory is reverted ENTRY BY ENTRY against the current file: the entries the
 * dream added are taken out and the entries it removed are put back; nothing
 * else in the file changes, and a whole pre-dream file is never restored. So
 * a revert keeps everything written since, and can never bring back an entry
 * the dream did not remove (one the user forgot afterwards, say).
 *
 * KB pages and skills are restored file by file, three-way safe: a file is
 * restored to its pre-dream content only when it still holds exactly what
 * the dream left (hash == afterHash). If it changed since, the whole revert
 * is refused (RevertConflictError → HTTP 409) unless `force` is set. A file
 * already back at its pre-dream content is a no-op, so repeating a revert is
 * idempotent. Writes are atomic per file; if a write fails midway, files
 * already written are rolled back to their current content. Every revert is
 * appended to the record and to reve/audit.jsonl.
 *
 * A memory revert never grows MEMORY.md / USER.md past the memory store's
 * byte cap (the store's own rule: the cap blocks growth only), so such a
 * revert is refused (`memory_full`), even under `force`, and nothing is
 * written.
 *
 * Locks, always in this order: reve → kb (when the KB is selected) → memory
 * (when memory is selected, the memory store's own write lock, which the
 * memory tool, the entries API and forget take). Each memory file is read,
 * planned and written inside the memory lock, so a chat's "remember X" that
 * arrives meanwhile waits and then lands on the reverted file: it is never
 * overwritten by a revert planned on the text before it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, atomicWrite } from "../fs-utils.js";
import { memoryMaxBytes, withMemoryLock, type MemoryStore } from "../memory/store.js";
import { lisaHome, memoryFile, userFile } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { reveAuditFile } from "./paths.js";
import { noteHomeWrite } from "./scope.js";
import { memoryEntryKey, sha256 } from "./snapshot.js";
import {
  lockReve,
  readDream,
  readDreamSidecar,
  writeDreamRecord,
  type MemoryEntryDelta,
} from "./store.js";
import { USER_PARTS, type FileChange, type UserPart } from "./types.js";

export class RevertInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevertInputError";
  }
}

export interface RevertConflict {
  path: string;
  /**
   * modified_since: changed after the dream (KB / skills); not_revertible: no
   * pre-dream copy (or one that does not match the record); unsafe_target:
   * the path resolves outside its part's directory (a symlink on the way, or
   * the file itself is one); memory_full: the reverted memory file would be
   * larger than the memory store's cap. `force` overrides modified_since and
   * skips not_revertible / unsafe_target files; memory_full always blocks.
   */
  reason: "modified_since" | "not_revertible" | "unsafe_target" | "memory_full";
}

/** Conflict reasons `force` cannot override: the whole revert is refused. */
const BLOCKS_EVEN_FORCED: ReadonlySet<RevertConflict["reason"]> = new Set(["memory_full"]);

export class RevertConflictError extends Error {
  constructor(readonly conflicts: RevertConflict[]) {
    super(
      `revert refused: ${conflicts.length} file(s) changed since the dream or cannot be restored`,
    );
    this.name = "RevertConflictError";
  }
}

export interface RevertResult {
  dreamId: string;
  parts: UserPart[];
  /** Files restored to their pre-dream content (or removed, if the dream added them). */
  reverted: string[];
  /** Files already at their pre-dream content. */
  alreadyReverted: string[];
  /** Files skipped under `force`: no pre-dream copy, or an unsafe target. */
  skipped: string[];
  /**
   * Memory files among `reverted` that no longer held exactly what the dream
   * left: their entries were reverted against the current text, and an entry
   * the dream removed was put back even if a later edit had replaced it. A
   * warning to look at the file, not a refusal.
   */
  changedSince: string[];
  forced: boolean;
}

/**
 * Test seam: `afterPlan` runs inside the locks, after every file is planned
 * and before any is written. Production code never sets it.
 */
export const revertTestSeams: { afterPlan?: () => Promise<void> } = {};

/** Validate the requested parts. "soul" is refused with a pointer to reconsider. */
export function parseRevertParts(raw: unknown): UserPart[] {
  const list =
    typeof raw === "string"
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : raw;
  if (!Array.isArray(list) || list.length === 0) {
    throw new RevertInputError(`parts must be a non-empty list of: ${USER_PARTS.join(", ")}`);
  }
  const out = new Set<UserPart>();
  for (const p of list) {
    if (p === "soul") {
      throw new RevertInputError(
        "Lisa's soul is hers to change — ask her to reconsider instead of reverting it",
      );
    }
    if (typeof p !== "string" || !USER_PARTS.includes(p as UserPart)) {
      throw new RevertInputError(`unknown part: ${String(p).slice(0, 40)}`);
    }
    out.add(p as UserPart);
  }
  return [...out];
}

const SAFE_PATH: Record<UserPart, RegExp> = {
  memory: /^memory\/[A-Za-z0-9._-]+\.md$/,
  kb: /^kb\/(?:SCHEMA\.md|sources\/[A-Za-z0-9._-]+\.md|wiki\/[A-Za-z0-9._-]+\.md)$/,
  skills: /^skills\/[a-z0-9][a-z0-9-]{0,62}\/SKILL\.md$/,
};

/** Resolve a record path to an absolute target, or null if it is not a safe user file. */
function safeTarget(c: FileChange): string | null {
  if (c.part === "soul") return null;
  const part = c.part;
  if (!USER_PARTS.includes(part) || !SAFE_PATH[part].test(c.path)) return null;
  if (c.path.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  const home = path.resolve(lisaHome());
  const abs = path.resolve(home, ...c.path.split("/"));
  return abs.startsWith(home + path.sep) ? abs : null;
}

/** The memory store a memory path belongs to (MEMORY.md / USER.md), or null for other files. */
function memoryStoreOf(relPath: string): MemoryStore | null {
  const name = relPath.slice("memory/".length);
  if (name === path.basename(memoryFile())) return "memory";
  if (name === path.basename(userFile())) return "user";
  return null;
}

class UnsafeTargetError extends Error {
  constructor(readonly relPath: string) {
    super(`revert target escapes its directory: ${relPath}`);
  }
}

/** macOS volumes are case-insensitive by default: compare paths the same way. */
const samePath = (a: string, b: string) =>
  process.platform === "darwin" || process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

/**
 * The jail, checked against the filesystem (the regex in safeTarget only
 * checks the text): every directory between the home and the target must be
 * a real directory, not a link, and the target must not be a link either.
 * With `create`, missing directories are made one level at a time under a
 * checked parent (never `mkdir -p` through a link). Then the parent's
 * realpath must equal realpath(home)/<the part's directory>.
 */
async function checkJail(relPath: string, abs: string, create: boolean): Promise<boolean> {
  const home = path.resolve(lisaHome());
  const dirs = relPath.split("/").slice(0, -1);
  let cur = home;
  for (const seg of dirs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
      if (!create) return true; // nothing below a missing directory can be a link
      await fs.mkdir(cur);
      st = await fs.lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    const expected = path.join(await fs.realpath(home), ...dirs);
    return samePath(await fs.realpath(path.dirname(abs)), expected);
  } catch {
    return !create; // parent missing: fine for a removal, never for a write
  }
}

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeOrRemove(
  abs: string,
  content: string | null,
  part: UserPart,
  relPath: string,
): Promise<void> {
  // Re-checked right before every write: the plan was made earlier.
  if (!(await checkJail(relPath, abs, content !== null))) throw new UnsafeTargetError(relPath);
  if (content !== null) {
    await atomicWrite(abs, content);
    return;
  }
  noteHomeWrite(abs); // a running dream must not offer to revert this
  await fs.rm(abs, { force: true });
  if (part === "skills") {
    // A skill the dream created: drop its directory too when nothing else is in it.
    await fs.rmdir(path.dirname(abs)).catch(() => undefined);
  }
}

function isDelta(v: unknown): v is MemoryEntryDelta {
  const d = v as MemoryEntryDelta | undefined;
  return (
    !!d &&
    Array.isArray(d.added) &&
    Array.isArray(d.removed) &&
    [...d.added, ...d.removed].every((e) => typeof e === "string")
  );
}

/**
 * Undo one dream's entry delta on the CURRENT memory text: drop one line per
 * entry it added (if still there), append each entry it removed that is not
 * there now. Returns null when the dream created the file and nothing is
 * left in it.
 */
export function revertMemoryEntries(
  current: string | null,
  delta: MemoryEntryDelta,
  createdByDream: boolean,
): string | null {
  const lines = (current ?? "").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const entry of delta.added) {
    const key = memoryEntryKey(entry);
    const at = lines.findIndex((l) => memoryEntryKey(l) === key);
    if (at >= 0) lines.splice(at, 1);
  }
  const present = new Set(lines.map(memoryEntryKey).filter(Boolean));
  for (const entry of delta.removed) {
    const key = memoryEntryKey(entry);
    if (!key || present.has(key)) continue;
    lines.push(entry);
    present.add(key);
  }
  if (createdByDream && lines.every((l) => !l.trim())) return null;
  if (current === null && lines.length === 0) return null;
  return lines.length ? lines.join("\n") + "\n" : "";
}

interface PlannedWrite {
  change: FileChange;
  abs: string;
  restore: string | null;
  current: string | null;
}

export async function revertDream(
  id: string,
  opts: { parts: unknown; force?: boolean; actor?: string },
): Promise<RevertResult> {
  const parts = parseRevertParts(opts.parts);
  const force = opts.force === true;
  const result: RevertResult = {
    dreamId: id,
    parts,
    reverted: [],
    alreadyReverted: [],
    skipped: [],
    changedSince: [],
    forced: force,
  };
  // Existence first (DreamNotFoundError / CorruptDreamError surface to the caller).
  await readDream(id);

  const body = async () => {
    // Re-read inside the lock: the record and the files are compared atomically.
    const rec = await readDream(id);
    const side = await readDreamSidecar(id);
    const selected = rec.changes.filter((c) => parts.includes(c.part as UserPart));
    const plan: PlannedWrite[] = [];
    const conflicts: RevertConflict[] = [];
    for (const c of selected) {
      const abs = safeTarget(c);
      if (abs && !(await checkJail(c.path, abs, false))) {
        conflicts.push({ path: c.path, reason: "unsafe_target" });
        continue;
      }
      if (c.part === "memory") {
        const delta = side?.memory?.[c.path];
        if (!abs || !c.revertible || !isDelta(delta)) {
          conflicts.push({ path: c.path, reason: "not_revertible" });
          continue;
        }
        // Entry-level: a second revert would take out a duplicate the user
        // kept, so a file this dream's revert already handled is done.
        if (rec.reverts.some((r) => r.files.includes(c.path))) {
          result.alreadyReverted.push(c.path);
          continue;
        }
        const current = await readOrNull(abs);
        const next = revertMemoryEntries(current, delta, c.beforeHash === null);
        if (next === current) {
          result.alreadyReverted.push(c.path);
          continue;
        }
        // Never past the store's cap: the memory tool would then refuse every
        // write, removals included. (A file already over it may still shrink.)
        const store = memoryStoreOf(c.path);
        const nextBytes = next === null ? 0 : Buffer.byteLength(next, "utf8");
        if (
          store &&
          nextBytes > memoryMaxBytes(store) &&
          nextBytes > Buffer.byteLength(current ?? "", "utf8")
        ) {
          conflicts.push({ path: c.path, reason: "memory_full" });
          continue;
        }
        if ((current === null ? null : sha256(current)) !== c.afterHash) {
          result.changedSince.push(c.path);
        }
        plan.push({ change: c, abs, restore: next, current });
        continue;
      }
      if (
        !abs ||
        !c.revertible ||
        !side ||
        !Object.prototype.hasOwnProperty.call(side.files, c.path)
      ) {
        conflicts.push({ path: c.path, reason: "not_revertible" });
        continue;
      }
      // The pre-dream copy must be what the record says it was.
      const stored: unknown = side.files[c.path];
      const restore = typeof stored === "string" ? stored : null;
      const copyMatches =
        (stored === null || typeof stored === "string") &&
        (restore === null ? c.beforeHash === null : sha256(restore) === c.beforeHash);
      if (!copyMatches) {
        conflicts.push({ path: c.path, reason: "not_revertible" });
        continue;
      }
      const current = await readOrNull(abs);
      const curHash = current === null ? null : sha256(current);
      if (curHash === c.beforeHash) {
        result.alreadyReverted.push(c.path);
      } else if (curHash === c.afterHash) {
        plan.push({ change: c, abs, restore, current });
      } else {
        conflicts.push({ path: c.path, reason: "modified_since" });
        if (force) plan.push({ change: c, abs, restore, current });
      }
    }
    const blocking = conflicts.filter((c) => BLOCKS_EVEN_FORCED.has(c.reason));
    if (blocking.length) throw new RevertConflictError(force ? blocking : conflicts);
    if (conflicts.length && !force) throw new RevertConflictError(conflicts);
    await revertTestSeams.afterPlan?.();
    result.skipped = conflicts.filter((c) => c.reason !== "modified_since").map((c) => c.path);

    const written: PlannedWrite[] = [];
    try {
      for (const w of plan) {
        await writeOrRemove(w.abs, w.restore, w.change.part as UserPart, w.change.path);
        written.push(w);
      }
    } catch (err) {
      // Roll back what we already wrote so a failed revert leaves no half state.
      for (const w of written.reverse()) {
        await writeOrRemove(w.abs, w.current, w.change.part as UserPart, w.change.path).catch(
          () => undefined,
        );
      }
      if (err instanceof UnsafeTargetError) {
        throw new RevertConflictError([{ path: err.relPath, reason: "unsafe_target" }]);
      }
      throw err;
    }
    result.reverted = plan.map((w) => w.change.path);

    if (result.reverted.length) {
      const at = new Date().toISOString();
      rec.reverts.push({ at, parts, files: result.reverted, forced: force });
      await writeDreamRecord(rec);
      await appendLine(
        reveAuditFile(),
        JSON.stringify({
          at,
          action: "revert",
          dreamId: id,
          parts,
          files: result.reverted,
          skipped: result.skipped,
          ...(result.changedSince.length ? { changedSince: result.changedSince } : {}),
          forced: force,
          ...(opts.actor ? { actor: opts.actor } : {}),
        }),
      );
    }
  };

  // reve → kb → memory, never another order (see the header).
  const inMemoryLock = () => (parts.includes("memory") ? withMemoryLock(body) : body());
  await lockReve(async () => {
    if (!parts.includes("kb")) return await inMemoryLock();
    // Same lock the KB store takes for every write.
    const { kbLockPath } = await import("../kb/paths.js");
    return await withFileLock(kbLockPath(), inMemoryLock, { timeoutMs: 10_000 });
  });

  if (result.reverted.some((p) => p.startsWith("kb/"))) {
    // The index / link graph are generated from the pages; rebuild, then
    // record a KB-git provenance commit (best-effort, local only).
    try {
      const { regenerateIndex } = await import("../kb/store.js");
      const { commitKb } = await import("../kb/git.js");
      await regenerateIndex();
      await commitKb(`reve: revert dream ${id}`);
    } catch {
      // the pages are restored; a stale index self-heals on the next KB write
    }
  }
  return result;
}

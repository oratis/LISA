/**
 * User revert of USER-owned data from a dream: memory, KB pages, and the
 * skills Lisa created or patched in that pass. Soul files are never touched
 * here — they are Lisa's (see reconsider.ts for the user's lever over those).
 *
 * Three-way safety: a file is restored to its pre-dream content only when it
 * still holds exactly what the dream left (hash == afterHash). If it changed
 * since, the whole revert is refused (RevertConflictError → HTTP 409) unless
 * `force` is set. A file already back at its pre-dream content is a no-op, so
 * repeating a revert is idempotent. Writes are atomic per file; if a write
 * fails midway, files already written are rolled back to their current
 * content. Every revert is appended to the record and to reve/audit.jsonl.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, atomicWrite } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import { withFileLock } from "../soul/lock.js";
import { reveAuditFile } from "./paths.js";
import { sha256 } from "./snapshot.js";
import { lockReve, readDream, readDreamSidecar, writeDreamRecord } from "./store.js";
import { USER_PARTS, type FileChange, type UserPart } from "./types.js";

export class RevertInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevertInputError";
  }
}

export interface RevertConflict {
  path: string;
  reason: "modified_since" | "not_revertible";
}

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
  /** Files skipped under `force` because no pre-dream content was kept. */
  skipped: string[];
  forced: boolean;
}

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

async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeOrRemove(abs: string, content: string | null, part: UserPart): Promise<void> {
  if (content !== null) {
    await atomicWrite(abs, content);
    return;
  }
  await fs.rm(abs, { force: true });
  if (part === "skills") {
    // A skill the dream created: drop its directory too when nothing else is in it.
    await fs.rmdir(path.dirname(abs)).catch(() => undefined);
  }
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
      if (
        !abs ||
        !c.revertible ||
        !side ||
        !Object.prototype.hasOwnProperty.call(side.files, c.path)
      ) {
        conflicts.push({ path: c.path, reason: "not_revertible" });
        continue;
      }
      const restore = side.files[c.path] ?? null;
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
    if (conflicts.length && !force) throw new RevertConflictError(conflicts);
    result.skipped = conflicts.filter((c) => c.reason === "not_revertible").map((c) => c.path);

    const written: PlannedWrite[] = [];
    try {
      for (const w of plan) {
        await writeOrRemove(w.abs, w.restore, w.change.part as UserPart);
        written.push(w);
      }
    } catch (err) {
      // Roll back what we already wrote so a failed revert leaves no half state.
      for (const w of written.reverse()) {
        await writeOrRemove(w.abs, w.current, w.change.part as UserPart).catch(() => undefined);
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
          forced: force,
          ...(opts.actor ? { actor: opts.actor } : {}),
        }),
      );
    }
  };

  await lockReve(async () => {
    if (!parts.includes("kb")) return await body();
    // Same lock the KB store takes for every write; order is reve → kb.
    const { kbLockPath } = await import("../kb/paths.js");
    return await withFileLock(kbLockPath(), body, { timeoutMs: 10_000 });
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

/** Source-grounded Rêve proposals. No model calls: the existing idle/reflect
 * turn does the reasoning, inside its own budget and cancellation boundary. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { memoryDir } from "../paths.js";
import { assertHomeDirectory, readHomeText, readHomeTextOrEmpty } from "../home-files.js";
import { evidenceHash, recentMemoryEvidence, type MemoryEvidence } from "./evidence.js";
import {
  withMemoryLock,
  writeMemoryUnlocked,
  normalizeMemory,
  readMemory,
  type MemoryStore,
} from "./store.js";
import { kbLinkTitles } from "../kb/memory-links.js";
import { parseWikilinks } from "../kb/links.js";

export interface MemoryChange {
  kind: "append" | "replace" | "remove";
  old_text?: string;
  new_text?: string;
  reason: string;
  evidence: { id: string; quote: string }[];
}

export interface MemoryReview {
  id: string;
  store: MemoryStore;
  before: string;
  generation: string;
  evidence: MemoryEvidence[];
}

export interface MemoryRevision {
  id: string;
  store: MemoryStore;
  before: string;
  after: string;
  createdAt: string;
  status: "prepared" | "applied";
  changes: MemoryChange[];
  /** Provenance identifiers, not a second archive of full conversations. */
  sources: Omit<MemoryEvidence, "text">[];
  restores?: string;
}

function recordFile(dir: "reviews" | "revisions", id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid memory review/revision id");
  return path.join(memoryDir(), dir, `${id}.json`);
}

async function savePrivate(file: string, value: unknown): Promise<void> {
  await assertHomeDirectory(path.dirname(file));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export function readReviewGeneration(): Promise<string> {
  return readHomeTextOrEmpty(reviewGenerationFile(), 256);
}

function reviewGenerationFile() {
  return path.join(memoryDir(), ".review-generation");
}

/** Called under the shared memory lock by Forget and import. Content-free,
 * tenant-specific token invalidates proposals that were already in flight. */
export async function invalidateMemoryReviews(): Promise<void> {
  await savePrivate(reviewGenerationFile(), crypto.randomUUID());
}

export async function createMemoryReview(
  store: MemoryStore,
  evidence: MemoryEvidence[],
): Promise<MemoryReview> {
  const generation = await readReviewGeneration();
  const before = await readMemory(store);
  if (Buffer.byteLength(before, "utf8") > 32_768)
    throw new Error("memory too large to review; trim the file first");
  const input = { store, before, generation, evidence };
  return { id: evidenceHash(input), ...input };
}

export async function prepareMemoryReview(
  store: MemoryStore,
  sessionIds?: string[],
): Promise<MemoryReview & { alreadyReviewed: boolean }> {
  return withMemoryLock(async () => {
    const review = await createMemoryReview(store, await recentMemoryEvidence(sessionIds));
    await savePrivate(recordFile("reviews", review.id), review);
    // Drafts include transcript excerpts, so keep only 48, and expire after a
    // day. Applied revisions retain the small before/after snapshot and quotes.
    const dir = path.dirname(recordFile("reviews", review.id));
    const files = (await fs.readdir(dir)).filter((f) => /^[a-f0-9]{64}\.json$/.test(f));
    const entries = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, at: (await fs.lstat(path.join(dir, file))).mtimeMs };
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      }),
    );
    const sorted = entries.filter((e) => e !== null).sort((a, b) => b.at - a.at);
    for (const [i, entry] of sorted.entries()) {
      if (entry.file !== `${review.id}.json` && (i >= 48 || Date.now() - entry.at > 86_400_000)) {
        await fs.rm(path.join(dir, entry.file), { force: true });
      }
    }
    const prior = await readHomeTextOrEmpty(recordFile("revisions", review.id), 512 * 1024);
    return { ...review, alreadyReviewed: prior ? JSON.parse(prior).status === "applied" : false };
  });
}

/** Validate the entire proposal before applying any part of it. Matching a
 * quote proves provenance, not semantic entailment; the model still judges
 * whether a fact is supported and whether newer evidence supersedes it. */
export function proposedMemory(review: MemoryReview, changes: MemoryChange[]): string {
  if (!Array.isArray(changes) || changes.length > 8)
    throw new Error("at most 8 memory changes per review");
  let next = review.before;
  for (const change of changes) {
    if (
      !change ||
      !["append", "replace", "remove"].includes(change.kind) ||
      typeof change.reason !== "string" ||
      !change.reason.trim() ||
      change.reason.length > 500 ||
      !Array.isArray(change.evidence) ||
      !change.evidence.length ||
      change.evidence.length > 4
    ) {
      throw new Error("each memory change needs a kind, reason and 1–4 source quotes");
    }
    const cited = change.evidence.map((citation) => {
      const source = review.evidence.find((e) => e.id === citation?.id);
      if (
        !source ||
        typeof citation.quote !== "string" ||
        !citation.quote.trim() ||
        (citation.quote.trim().length < 6 && citation.quote !== source.text) ||
        citation.quote.length > 500 ||
        !source.text.replace(/\n\[truncated\]$/, "").includes(citation.quote)
      ) {
        throw new Error(
          "memory evidence must quote a supplied source exactly (6–500 characters, or a complete shorter source)",
        );
      }
      return source;
    });
    if (
      !cited.some((e) => (review.store === "user" ? e.role === "user" : e.role !== "assistant"))
    ) {
      throw new Error(
        "user preferences need human evidence; assistant assertions alone cannot establish facts",
      );
    }
    if (change.kind === "append") {
      if (typeof change.new_text !== "string" || !change.new_text.trim())
        throw new Error("append needs new_text");
      const text = change.new_text.trim();
      const bullet = text.startsWith("- ") ? text : `- ${text}`;
      if (!next.split(/\r?\n/).some((line) => line.trim() === bullet)) {
        next += (next && !next.endsWith("\n") ? "\n" : "") + bullet + "\n";
      }
    } else {
      if (
        typeof change.old_text !== "string" ||
        !change.old_text.trim() ||
        next.split(change.old_text).length !== 2
      ) {
        throw new Error("old_text must match exactly one non-empty passage");
      }
      if (
        change.kind === "replace" &&
        (typeof change.new_text !== "string" || !change.new_text.trim())
      ) {
        throw new Error("replace needs new_text (use remove for deletion)");
      }
      next = next.replace(change.old_text, () =>
        change.kind === "remove" ? "" : change.new_text!,
      );
    }
  }
  return next === review.before
    ? next
    : normalizeMemory(review.store, next, Buffer.byteLength(review.before));
}

/** The caller holds the same lock as owner edits, Forget and imports until
 * both the memory write and provenance finalization are finished. */
async function commitRevision(
  revision: MemoryRevision,
  signal?: AbortSignal,
): Promise<{ revisionId: string; changed: boolean; alreadyApplied: boolean }> {
  const file = recordFile("revisions", revision.id);
  signal?.throwIfAborted();
  const current = await readMemory(revision.store);
  const raw = await readHomeTextOrEmpty(file, 512 * 1024);
  if (raw) {
    const prior = await readMemoryRevision(revision.id);
    if (
      prior.store !== revision.store ||
      prior.before !== revision.before ||
      prior.after !== revision.after ||
      evidenceHash(prior.changes) !== evidenceHash(revision.changes)
    ) {
      throw new Error("review already used for a different proposal; prepare a new review");
    }
    if (prior.status === "applied" || current === prior.after) {
      if (prior.status === "prepared") await savePrivate(file, { ...prior, status: "applied" });
      return { revisionId: prior.id, changed: prior.before !== prior.after, alreadyApplied: true };
    }
  }
  if (current !== revision.before)
    throw new Error("memory changed since review; prepare a new review");
  await savePrivate(file, revision);
  signal?.throwIfAborted();
  if (revision.after !== current) await writeMemoryUnlocked(revision.store, revision.after);
  // A crash/failure here leaves a recoverable prepared record. The memory
  // mutation has already succeeded; let a retry finish the provenance write.
  await savePrivate(file, { ...revision, status: "applied" }).catch(() => {});
  return {
    revisionId: revision.id,
    changed: revision.before !== revision.after,
    alreadyApplied: false,
  };
}

export async function applyMemoryReview(
  review: MemoryReview,
  changes: MemoryChange[],
  signal?: AbortSignal,
) {
  const after = proposedMemory(review, changes);
  const existingLinks = new Set(parseWikilinks(review.before));
  const newLinks = parseWikilinks(after).filter((ref) => !existingLinks.has(ref));
  if (newLinks.length) {
    const titles = await kbLinkTitles();
    if (newLinks.some((ref) => !titles.has(ref)))
      throw new Error("new memory links must resolve to an existing KB page");
  }
  const cited = new Set(changes.flatMap((c) => c.evidence.map((e) => e.id)));
  return withMemoryLock(async () => {
    if (review.generation !== (await readHomeTextOrEmpty(reviewGenerationFile(), 256)))
      throw new Error("memory changed since review; prepare a new review");
    return commitRevision(
      {
        id: review.id,
        store: review.store,
        before: review.before,
        after,
        createdAt: new Date().toISOString(),
        status: "prepared",
        changes,
        sources: review.evidence
          .filter((e) => cited.has(e.id))
          .map(({ text: _text, ...source }) => source),
      },
      signal,
    );
  });
}

export async function consolidateMemory(
  reviewId: string,
  changes: MemoryChange[],
  signal?: AbortSignal,
) {
  const file = recordFile("reviews", reviewId);
  await assertHomeDirectory(path.dirname(file));
  if (Date.now() - (await fs.lstat(file)).mtimeMs > 86_400_000)
    throw new Error("review expired; prepare a new review");
  const review: MemoryReview = JSON.parse(await readHomeText(file, 512 * 1024));
  if (
    review.id !== reviewId ||
    evidenceHash({
      store: review.store,
      before: review.before,
      generation: review.generation,
      evidence: review.evidence,
    }) !== reviewId
  ) {
    throw new Error("corrupt memory review");
  }
  return applyMemoryReview(review, changes, signal);
}

/** Keep only the newest records per store while walking the tenant's archive. */
export async function recentMemoryRevisions(
  limitPerStore = 10,
  only?: MemoryStore,
): Promise<MemoryRevision[]> {
  if (only !== undefined) normalizeMemory(only, "");
  const limit = Number.isFinite(limitPerStore)
    ? Math.max(1, Math.min(100, Math.floor(limitPerStore)))
    : 10;
  const newest: Record<MemoryStore, MemoryRevision[]> = { user: [], memory: [] };
  let directory;
  try {
    const dir = path.join(memoryDir(), "revisions");
    await assertHomeDirectory(dir);
    directory = await fs.opendir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const newestFirst = (a: MemoryRevision, b: MemoryRevision) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  for await (const entry of directory) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    let revision: MemoryRevision;
    try {
      revision = await readMemoryRevision(entry.name.slice(0, -5));
    } catch (err) {
      // Forget and import may remove a version between enumeration and read.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (only && only !== revision.store) continue;
    const recent = newest[revision.store];
    if (recent.length === limit && newestFirst(revision, recent[limit - 1]!) >= 0) continue;
    recent.push(revision);
    recent.sort(newestFirst);
    if (recent.length > limit) recent.pop();
  }
  return [...newest.user, ...newest.memory].sort(newestFirst);
}

export function memoryRevisionHistory(store: MemoryStore, limit = 10): Promise<MemoryRevision[]> {
  return recentMemoryRevisions(limit, store);
}

export async function readMemoryRevision(id: string): Promise<MemoryRevision> {
  const revision: MemoryRevision = JSON.parse(
    await readHomeText(recordFile("revisions", id), 512 * 1024),
  );
  if (
    !revision ||
    revision.id !== id ||
    typeof revision.createdAt !== "string" ||
    !Number.isFinite(Date.parse(revision.createdAt)) ||
    !["user", "memory"].includes(revision.store) ||
    !["prepared", "applied"].includes(revision.status) ||
    typeof revision.before !== "string" ||
    typeof revision.after !== "string" ||
    !Array.isArray(revision.changes) ||
    !Array.isArray(revision.sources)
  ) {
    throw new Error("corrupt memory revision");
  }
  return revision;
}

export async function restoreMemoryRevision(id: string, signal?: AbortSignal) {
  return withMemoryLock(async () => {
    const revision = await readMemoryRevision(id);
    // Restoring an oversized legacy snapshot would violate the current write cap.
    const after = normalizeMemory(revision.store, revision.before);
    // Repeating an undo while its target is still current is idempotent. If
    // the user subsequently undid that undo, allocate a new recorded step.
    const current = await readMemory(revision.store);
    let restoreId = evidenceHash(["restore", id]);
    for (;;) {
      const raw = await readHomeTextOrEmpty(recordFile("revisions", restoreId), 512 * 1024);
      if (!raw) break;
      const previous = await readMemoryRevision(restoreId);
      if (previous.restores !== id) throw new Error("corrupt restore chain");
      if (current === after && previous.status === "applied") {
        return {
          revisionId: restoreId,
          changed: previous.before !== previous.after,
          alreadyApplied: true,
        };
      }
      if (previous.status === "prepared") break;
      restoreId = evidenceHash(["restore", id, restoreId]);
    }
    return commitRevision(
      {
        id: restoreId,
        store: revision.store,
        before: revision.after,
        after,
        restores: id,
        createdAt: new Date().toISOString(),
        status: "prepared",
        changes: [],
        sources: [],
      },
      signal,
    );
  });
}

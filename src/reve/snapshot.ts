/**
 * Pre-/post-pass snapshots of the files a reflective pass may touch, and the
 * deterministic diff between them.
 *
 * The snapshot is the one capture path that works everywhere (local and the
 * cloud edition, where soul git is off on GCS FUSE). It holds content only in
 * memory for the length of the pass; after the pass only the PRE-pass content
 * of user-owned files that actually changed is persisted (the revert sidecar).
 *
 * Tracked files, relative to the active home:
 *   memory  memory/*.md
 *   kb      kb/SCHEMA.md, kb/sources/*.md, kb/wiki/*.md   (index.md/index.json
 *           are generated and rebuilt after a revert, so they are not tracked)
 *   skills  skills/<name>/SKILL.md                         (Lisa's own skills)
 *   soul    identity/purpose/constitution/name, values/, opinions/, desires/,
 *           relationships/, journal/ (last few days), emotions.json
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";
import type { DesireChanges, DreamPart, EmotionDelta, FileChange } from "./types.js";

/** Per-file content cap: bigger files are hashed but not diffable/revertible. */
export const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
/** Total content held in memory for one pass. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 16 * 1024 * 1024;
/** Hard bound on files walked per pass. */
export const MAX_SNAPSHOT_FILES = 5000;
/** Per-file diff text cap in a dream record. */
export const MAX_DIFF_CHARS = 8 * 1024;
/** Journal files older than this many days are not snapshotted. */
const JOURNAL_DAYS = 3;

export interface SnapFile {
  part: DreamPart;
  hash: string;
  bytes: number;
  /** Absent when the file exceeded the per-file or total content cap. */
  content?: string;
}

/** relPath (POSIX, relative to the home) → file state. */
export type Snapshot = Map<string, SnapFile>;

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function toRel(abs: string): string {
  return path.relative(lisaHome(), abs).split(path.sep).join("/");
}

async function listMd(dir: string, opts: { suffix?: string } = {}): Promise<string[]> {
  const suffix = opts.suffix ?? ".md";
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(suffix))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}

function recentJournalNames(now: Date): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < JOURNAL_DAYS; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60_000);
    out.add(`${d.toISOString().slice(0, 10)}.md`);
  }
  return out;
}

/** The absolute paths a part tracks right now. Deterministic order. */
export async function trackedFiles(part: DreamPart, now: Date = new Date()): Promise<string[]> {
  const home = lisaHome();
  if (part === "memory") return await listMd(path.join(home, "memory"));
  if (part === "kb") {
    const kb = path.join(home, "kb");
    const schema = path.join(kb, "SCHEMA.md");
    return [
      ...((await fileExists(schema)) ? [schema] : []),
      ...(await listMd(path.join(kb, "sources"))),
      ...(await listMd(path.join(kb, "wiki"))),
    ];
  }
  if (part === "skills") {
    const root = path.join(home, "skills");
    const out: string[] = [];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const f = path.join(root, e.name, "SKILL.md");
        if (await fileExists(f)) out.push(f);
      }
    } catch {
      // no skills dir yet
    }
    return out;
  }
  // soul
  const soul = path.join(home, "soul");
  const top = ["identity.md", "purpose.md", "constitution.md", "name.md", "emotions.json"].map(
    (n) => path.join(soul, n),
  );
  const out: string[] = [];
  for (const f of top) if (await fileExists(f)) out.push(f);
  for (const sub of ["values", "opinions", "desires", "relationships"]) {
    out.push(...(await listMd(path.join(soul, sub))));
  }
  const recent = recentJournalNames(now);
  out.push(
    ...(await listMd(path.join(soul, "journal"))).filter((f) => recent.has(path.basename(f))),
  );
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Snapshot every tracked file of the given parts. Never throws on a single unreadable file. */
export async function takeSnapshot(
  parts: readonly DreamPart[],
  now: Date = new Date(),
): Promise<Snapshot> {
  const snap: Snapshot = new Map();
  let budget = MAX_SNAPSHOT_TOTAL_BYTES;
  let count = 0;
  for (const part of parts) {
    for (const abs of await trackedFiles(part, now)) {
      if (count >= MAX_SNAPSHOT_FILES) return snap;
      let content: string;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue; // vanished between readdir and read
      }
      count++;
      const bytes = Buffer.byteLength(content, "utf8");
      const keep = bytes <= MAX_SNAPSHOT_FILE_BYTES && bytes <= budget;
      if (keep) budget -= bytes;
      snap.set(toRel(abs), {
        part,
        hash: sha256(content),
        bytes,
        content: keep ? content : undefined,
      });
    }
  }
  return snap;
}

// ── diff ──────────────────────────────────────────────────────────────────

export interface LineDiff {
  text: string;
  added: number;
  removed: number;
  truncated: boolean;
}

function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Compact, deterministic line diff: common prefix/suffix trimmed, then an LCS
 * over the middle when it is small, else a multiset fallback (removed lines
 * then added lines). Output lines are "- …" / "+ …"; capped at `cap` chars.
 */
export function lineDiff(before: string, after: string, cap = MAX_DIFF_CHARS): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: string[] = [];
  if (midA.length * midB.length <= 1_000_000) {
    // LCS table over the middle.
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] =
          midA[i] === midB[j]
            ? t[(i + 1) * w + j + 1]! + 1
            : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        i++;
        j++;
      } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) {
        ops.push(`- ${midA[i++]}`);
      } else {
        ops.push(`+ ${midB[j++]}`);
      }
    }
    while (i < n) ops.push(`- ${midA[i++]}`);
    while (j < m) ops.push(`+ ${midB[j++]}`);
  } else {
    const { added, removed } = multisetDiff(midA, midB);
    for (const l of removed) ops.push(`- ${l}`);
    for (const l of added) ops.push(`+ ${l}`);
  }
  const added = ops.filter((o) => o.startsWith("+ ")).length;
  const removed = ops.length - added;
  let text = ops.join("\n");
  let truncated = false;
  if (text.length > cap) {
    text = text.slice(0, cap) + `\n… [diff truncated, ${text.length - cap} more chars]`;
    truncated = true;
  }
  return { text, added, removed, truncated };
}

/** Lines in `b` not matched in `a` (added) and vice versa (removed), order-preserving. */
export function multisetDiff(a: string[], b: string[]): { added: string[]; removed: string[] } {
  const countA = new Map<string, number>();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const c = countA.get(l) ?? 0;
    if (c > 0) countA.set(l, c - 1);
    else added.push(l);
  }
  const countB = new Map<string, number>();
  for (const l of b) countB.set(l, (countB.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of a) {
    const c = countB.get(l) ?? 0;
    if (c > 0) countB.set(l, c - 1);
    else removed.push(l);
  }
  return { added, removed };
}

/** Memory entries: non-empty lines, a leading "- " bullet stripped. */
export function memoryEntries(text: string): string[] {
  return splitLines(text)
    .map((l) => l.trim().replace(/^-\s+/, ""))
    .filter(Boolean);
}

const MAX_ENTRY_CHARS = 400;
const MAX_ENTRIES_LISTED = 50;

function capEntries(list: string[]): string[] {
  return list
    .slice(0, MAX_ENTRIES_LISTED)
    .map((e) => (e.length > MAX_ENTRY_CHARS ? e.slice(0, MAX_ENTRY_CHARS) + "…" : e));
}

/** Diff two snapshots into per-file changes. emotions.json is summarized separately. */
export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  const out: FileChange[] = [];
  for (const rel of [...paths].sort()) {
    if (rel === "soul/emotions.json") continue;
    const b = before.get(rel);
    const a = after.get(rel);
    if (b && a && b.hash === a.hash) continue;
    const part = (a ?? b)!.part;
    const status: FileChange["status"] = !b ? "added" : !a ? "deleted" : "modified";
    const haveBefore = !b || b.content !== undefined;
    const haveAfter = !a || a.content !== undefined;
    const d =
      haveBefore && haveAfter
        ? lineDiff(b?.content ?? "", a?.content ?? "")
        : { text: "(file too large to diff)", added: 0, removed: 0, truncated: true };
    const change: FileChange = {
      part,
      path: rel,
      status,
      beforeHash: b?.hash ?? null,
      afterHash: a?.hash ?? null,
      bytesBefore: b?.bytes ?? 0,
      bytesAfter: a?.bytes ?? 0,
      linesAdded: d.added,
      linesRemoved: d.removed,
      diff: d.text,
      diffTruncated: d.truncated,
      // A user part is revertible when its pre-pass content (or absence) is known.
      revertible: part !== "soul" && haveBefore,
    };
    if (part === "memory" && haveBefore && haveAfter) {
      const { added, removed } = multisetDiff(
        memoryEntries(b?.content ?? ""),
        memoryEntries(a?.content ?? ""),
      );
      change.entriesAdded = capEntries(added);
      change.entriesRemoved = capEntries(removed);
    }
    out.push(change);
  }
  return out;
}

const CLOSED_RE = /^closed:\s*yes\s*$/im;

/** Desire churn from soul file changes (desires/<slug>.md, not .progress.md). */
export function desireChanges(
  changes: FileChange[],
  before: Snapshot,
  after: Snapshot,
): DesireChanges {
  const out: DesireChanges = { added: [], revised: [], closed: [] };
  for (const c of changes) {
    const m = /^soul\/desires\/([^/]+)\.md$/.exec(c.path);
    if (!m || m[1]!.endsWith(".progress")) continue;
    const slug = m[1]!;
    if (c.status === "added") {
      out.added.push(slug);
      continue;
    }
    const wasClosed = CLOSED_RE.test(before.get(c.path)?.content ?? "");
    const isClosed = c.status === "deleted" || CLOSED_RE.test(after.get(c.path)?.content ?? "");
    if (isClosed && !wasClosed) out.closed.push(slug);
    else out.revised.push(slug);
  }
  return out;
}

function emotionValues(f: SnapFile | undefined): Record<string, number> | null {
  if (!f?.content) return null;
  try {
    const parsed = JSON.parse(f.content) as { values?: Record<string, unknown> };
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed.values ?? {})) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Emotion before/after/delta from emotions.json, or null when unchanged/unknown. */
export function emotionDelta(before: Snapshot, after: Snapshot): EmotionDelta | null {
  const b = before.get("soul/emotions.json");
  const a = after.get("soul/emotions.json");
  if (b?.hash === a?.hash) return null;
  const bv = emotionValues(b) ?? {};
  const av = emotionValues(a) ?? {};
  const delta: Record<string, number> = {};
  for (const k of [...new Set([...Object.keys(bv), ...Object.keys(av)])].sort()) {
    const d = round4((av[k] ?? 0) - (bv[k] ?? 0));
    if (d !== 0) delta[k] = d;
  }
  if (Object.keys(delta).length === 0) return null;
  return { before: bv, after: av, delta };
}

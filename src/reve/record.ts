/**
 * Dream capture: wrap one reflective pass, diff what it changed, persist a
 * record. See docs/DESIGN_REVE_DREAMS.md.
 *
 *   const dream = await beginDream({ trigger: "idle" });
 *   try { await dream.run(() => thePass()); } finally { await dream.end(); }
 *
 * or simply `await withDream({ trigger: "reflect" }, () => thePass())`.
 *
 * Capture never breaks the pass: every failure degrades to "no record" with a
 * warning. A pass that changed nothing writes nothing (unless the user's
 * reconsider notes were injected into it — then the record shows she saw them).
 */
import { atomicWrite, ensureDir } from "../fs-utils.js";
import { logWarn, redactId } from "../log.js";
import { flushSoulCommits, soulCommitPatch, soulCommitsBetween, soulGitHead } from "../soul/git.js";
import type { AutonomyKind, AutonomyOutcome } from "../autonomy/runs.js";
import { newDreamId } from "./ids.js";
import { dreamSnapshotFile, dreamSummaryFile, dreamsDir } from "./paths.js";
import { settleReconsider } from "./reconsider.js";
import {
  currentDream,
  dreamScope,
  dreamsEnabled,
  markDreamActive,
  parseDreamTrailer,
  type DreamScope,
} from "./scope.js";
import {
  MAX_SNAPSHOT_FILES,
  desireChanges,
  diffSnapshots,
  emotionDelta,
  memoryEntryDelta,
  skippedSymlinks,
  takeSnapshot,
  uncapturedParts,
  type Snapshot,
} from "./snapshot.js";
import {
  MAX_RECORD_BYTES,
  fitRecord,
  lockReve,
  maybeApplyRetention,
  writeDreamRecord,
  type DreamSnapshotSidecar,
} from "./store.js";
import {
  DREAM_RECORD_VERSION,
  type DesireChanges,
  type DreamMetrics,
  type DreamPart,
  type DreamRecord,
  type DreamTrigger,
  type EmotionDelta,
  type FileChange,
  type SoulCommit,
} from "./types.js";

/** Whole-record cap; diffs are trimmed (largest first) to fit (store.ts holds it: reads cap too). */
export { MAX_RECORD_BYTES };
/** Revert sidecar cap; files past it are recorded as not revertible. */
export const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const MAX_COMMIT_DIFF_CHARS = 4 * 1024;
const MAX_COMMITS_WITH_DIFF = 50;
const FLUSH_TIMEOUT_MS = 20_000;

/** Which parts each trigger may touch (reflection never writes the KB). */
const PARTS_BY_TRIGGER: Record<DreamTrigger, DreamPart[]> = {
  idle: ["memory", "kb", "skills", "soul"],
  reflect: ["memory", "skills", "soul"],
  examen: ["memory", "kb", "skills", "soul"],
  "desire-review": ["memory", "soul"],
};

export { dreamsEnabled };

export interface DreamEndOptions {
  /** The pass threw. Its claimed reconsider notes go back to pending. */
  error?: unknown;
  /** Outcome override; defaults to the last autonomy run recorded in the pass. */
  outcome?: AutonomyOutcome;
}

export interface DreamHandle {
  /** null when dreams are disabled, nested, or capture failed to start. */
  readonly id: string | null;
  /** Run `fn` inside this dream's scope (commit stamps, run links, reconsider). */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Finish capture and persist the record. Idempotent; never throws. */
  end(opts?: DreamEndOptions): Promise<DreamRecord | null>;
}

const NOOP_HANDLE: DreamHandle = {
  id: null,
  run: (fn) => fn(),
  end: () => Promise.resolve(null),
};

/**
 * A capture error for the log: short, and with the tenant's uid in any
 * `users/<uid>/` path redacted like every other tenant log line.
 */
export function logSafeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/(^|[\\/])users([\\/])([^\\/\s'"]+)/g, (_m, a: string, b: string, uid: string) => {
      return `${a}users${b}${redactId(uid)}`;
    })
    .slice(0, 200);
}

/** Map an AutonomyRun kind to a dream trigger (null = not a reflective pass). */
export function dreamTriggerForKind(kind: AutonomyKind | string): DreamTrigger | null {
  if (kind === "idle" || kind === "reflect" || kind === "examen" || kind === "desire-review") {
    return kind;
  }
  return null;
}

/** Heartbeat convenience: a real dream for examen / desire review, a no-op otherwise. */
export async function beginDreamForKind(kind: AutonomyKind, task?: string): Promise<DreamHandle> {
  const trigger = dreamTriggerForKind(kind);
  return trigger ? await beginDream({ trigger, task }) : NOOP_HANDLE;
}

export async function beginDream(opts: {
  trigger: DreamTrigger;
  task?: string;
  now?: () => Date;
}): Promise<DreamHandle> {
  if (!dreamsEnabled()) return NOOP_HANDLE;
  // A pass nested inside another dream is part of that dream.
  if (currentDream()) return NOOP_HANDLE;
  const now = opts.now ?? (() => new Date());
  const start = now();
  const id = newDreamId(start);
  const parts = PARTS_BY_TRIGGER[opts.trigger];
  let before: Snapshot;
  let headBefore: string | null;
  try {
    // Pending soul commits from before the window belong to someone else.
    await withTimeout(flushSoulCommits(), FLUSH_TIMEOUT_MS);
    [before, headBefore] = await Promise.all([takeSnapshot(parts, start), soulGitHead()]);
  } catch (err) {
    logWarn(`[reve] dream capture could not start: ${logSafeError(err)}`);
    return NOOP_HANDLE;
  }
  const scope: DreamScope = {
    id,
    trigger: opts.trigger,
    runIds: [],
    runOutcomes: [],
    reconsiderIds: [],
  };
  let ended: Promise<DreamRecord | null> | null = null;
  markDreamActive(id, true);
  return {
    id,
    run: (fn) => dreamScope.run(scope, fn),
    end: (endOpts = {}) => {
      ended ??= (async () => {
        const failed = endOpts.error !== undefined || scope.runOutcomes.at(-1) === "error";
        let rec: DreamRecord | null = null;
        try {
          // The record (listing the notes this pass saw) is written first: it
          // is what claim recovery trusts if the acknowledgement never lands.
          rec = await finishDream({
            scope,
            trigger: opts.trigger,
            task: opts.task,
            parts,
            before,
            headBefore,
            start,
            end: now(),
            endOpts,
            failed,
          });
        } catch (err) {
          logWarn(`[reve] dream capture failed: ${logSafeError(err)}`);
        }
        try {
          await settleReconsider(scope.reconsiderIds, id, failed ? "release" : "ack");
        } catch (err) {
          // The claim stays; the next pass recovers it (delivered per the record, else pending).
          logWarn(`[reve] reconsider settle failed: ${logSafeError(err)}`);
        } finally {
          markDreamActive(id, false);
        }
        return rec;
      })();
      return ended;
    },
  };
}

/** Wrap one pass. Rethrows the pass's own error after recording. */
export async function withDream<T>(
  opts: { trigger: DreamTrigger; task?: string; now?: () => Date },
  fn: () => Promise<T>,
): Promise<T> {
  const dream = await beginDream(opts);
  let result: T;
  try {
    result = await dream.run(fn);
  } catch (err) {
    await dream.end({ error: err });
    throw err;
  }
  await dream.end();
  return result;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function captureSoulCommits(
  id: string,
  headBefore: string | null,
): Promise<{ commits: SoulCommit[]; headAfter?: string }> {
  if (!headBefore) return { commits: [] };
  const headAfter = await soulGitHead();
  if (!headAfter || headAfter === headBefore)
    return { commits: [], headAfter: headAfter ?? undefined };
  const infos = await soulCommitsBetween(headBefore, headAfter);
  const commits: SoulCommit[] = [];
  for (const info of infos) {
    const { base, dreamId, reconsider } = parseDreamTrailer(info.subject);
    // A commit stamped by ANOTHER dream (a concurrent pass) is that dream's.
    if (dreamId && dreamId !== id) continue;
    const m = /^([^:]+):\s.*\svia\s(\S+)$/.exec(base);
    const patch =
      commits.length < MAX_COMMITS_WITH_DIFF
        ? await soulCommitPatch(info.sha, MAX_COMMIT_DIFF_CHARS)
        : { text: "", truncated: true };
    commits.push({
      sha: info.sha,
      at: info.at,
      subject: info.subject,
      opKind: m?.[1] ?? "unknown",
      caller: m?.[2] ?? "unknown",
      ...(dreamId ? { dreamId } : {}),
      ...(reconsider?.length ? { reconsider } : {}),
      files: info.files,
      diff: patch.text,
      diffTruncated: patch.truncated,
    });
  }
  return { commits, headAfter };
}

/** Deterministic drift indicators (pure function of the record's own data). */
export function computeMetrics(input: {
  changes: FileChange[];
  soulCommits: SoulCommit[];
  desires: DesireChanges;
  emotions: EmotionDelta | null;
  skillsTouched: string[];
}): DreamMetrics {
  const patches = (file: string) => {
    const viaCommits = input.soulCommits.filter((c) => c.files.some((f) => f.path === file)).length;
    const viaSnapshot = input.changes.some((c) => c.path === `soul/${file}`) ? 1 : 0;
    return Math.max(viaCommits, viaSnapshot);
  };
  const churn = (dir: string) =>
    input.changes
      .filter((c) => c.path.startsWith(`soul/${dir}/`))
      .reduce((n, c) => n + c.linesAdded + c.linesRemoved, 0);
  const volatility = input.emotions
    ? Object.values(input.emotions.delta).reduce((n, d) => n + Math.abs(d), 0)
    : 0;
  const memory = input.changes.filter((c) => c.part === "memory");
  return {
    identityPatches: patches("identity.md"),
    purposePatches: patches("purpose.md"),
    constitutionPatches: patches("constitution.md"),
    valuesChurn: churn("values"),
    opinionsChurn: churn("opinions"),
    desireChurn:
      input.desires.added.length + input.desires.revised.length + input.desires.closed.length,
    emotionVolatility: Math.round(volatility * 10_000) / 10_000,
    memoryEntriesAdded: memory.reduce((n, c) => n + (c.entriesAdded?.length ?? 0), 0),
    memoryEntriesRemoved: memory.reduce((n, c) => n + (c.entriesRemoved?.length ?? 0), 0),
    kbFilesChanged: input.changes.filter((c) => c.part === "kb").length,
    skillsTouched: input.skillsTouched.length,
  };
}

const TRIGGER_LABEL: Record<DreamTrigger, string> = {
  idle: "Idle (Reve) pass",
  reflect: "Session reflection",
  examen: "Weekly examen",
  "desire-review": "Desire review",
};

export function renderSummary(rec: Omit<DreamRecord, "summary">): string {
  const bits: string[] = [];
  const m = rec.metrics;
  if (m.memoryEntriesAdded || m.memoryEntriesRemoved) {
    bits.push(`memory +${m.memoryEntriesAdded}/-${m.memoryEntriesRemoved} entries`);
  } else if (rec.changes.some((c) => c.part === "memory")) bits.push("memory edited");
  if (m.kbFilesChanged) bits.push(`knowledge base: ${m.kbFilesChanged} page(s)`);
  if (rec.skillsTouched.length) bits.push(`skills: ${rec.skillsTouched.join(", ")}`);
  const soulFiles = new Set<string>();
  for (const c of rec.changes) if (c.part === "soul") soulFiles.add(c.path.replace(/^soul\//, ""));
  for (const c of rec.soulCommits) for (const f of c.files) soulFiles.add(f.path);
  soulFiles.delete("emotions.json");
  if (soulFiles.size) {
    const list = [...soulFiles].sort();
    bits.push(
      `soul: ${list.slice(0, 5).join(", ")}${list.length > 5 ? ` (+${list.length - 5})` : ""}`,
    );
  }
  const d = rec.desires;
  if (d.added.length || d.revised.length || d.closed.length) {
    bits.push(`desires +${d.added.length} ~${d.revised.length} x${d.closed.length}`);
  }
  if (rec.emotions) {
    const top = Object.entries(rec.emotions.delta)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v.toFixed(2)}`);
    bits.push(`feelings: ${top.join(", ")}`);
  }
  if (rec.reconsiderDelivered.length) {
    bits.push(`considered ${rec.reconsiderDelivered.length} reconsider request(s)`);
  }
  if (rec.uncaptured?.length) {
    const list = rec.uncaptured.map((u) => `${u.part} (${u.files} files)`).join(", ");
    bits.push(`not captured: ${list}, over the ${MAX_SNAPSHOT_FILES}-file cap`);
  }
  const head = `${TRIGGER_LABEL[rec.trigger]}${rec.task ? ` (${rec.task})` : ""} — ${rec.outcome}`;
  return bits.length ? `${head}: ${bits.join("; ")}.` : `${head}: no changes.`;
}

function renderMarkdown(rec: DreamRecord): string {
  const lines = [
    `# Dream ${rec.id}`,
    "",
    rec.summary,
    "",
    `- trigger: ${rec.trigger}${rec.task ? ` (${rec.task})` : ""}`,
    `- window: ${rec.windowStart} → ${rec.windowEnd}`,
    `- outcome: ${rec.outcome}`,
    `- capture: ${rec.capture}`,
  ];
  if (rec.changes.length) {
    lines.push("", "## Changes");
    for (const c of rec.changes) {
      const tag =
        c.part === "soul"
          ? "Lisa's"
          : c.revertible
            ? "revertible"
            : `not revertible${c.notRevertibleReason ? `: ${c.notRevertibleReason}` : ""}`;
      lines.push(
        `- [${c.part}] ${c.path} — ${c.status}, +${c.linesAdded}/-${c.linesRemoved} (${tag})`,
      );
    }
  }
  if (rec.skippedSymlinks?.length) {
    lines.push("", "## Symlinks skipped (never followed)");
    for (const l of rec.skippedSymlinks) lines.push(`- ${l}`);
  }
  if (rec.uncaptured?.length) {
    lines.push("", "## Not captured");
    for (const u of rec.uncaptured) {
      lines.push(
        `- ${u.part}: ${u.files} tracked files, over the ${MAX_SNAPSHOT_FILES}-file cap; its changes are not in this record`,
      );
    }
  }
  if (rec.soulCommits.length) {
    lines.push("", "## Soul commits");
    for (const c of rec.soulCommits) lines.push(`- ${c.sha.slice(0, 10)} ${c.subject}`);
  }
  return lines.join("\n") + "\n";
}

async function finishDream(ctx: {
  scope: DreamScope;
  trigger: DreamTrigger;
  task?: string;
  parts: DreamPart[];
  before: Snapshot;
  headBefore: string | null;
  start: Date;
  end: Date;
  endOpts: DreamEndOptions;
  failed: boolean;
}): Promise<DreamRecord | null> {
  const { scope, endOpts, failed } = ctx;
  const reconsiderDelivered = failed ? [] : [...scope.reconsiderIds];

  await withTimeout(flushSoulCommits(), FLUSH_TIMEOUT_MS);
  // Exactly the parts the pre-pass snapshot captured, so nothing is compared
  // against a listing that was never taken.
  const after = await takeSnapshot(ctx.parts, ctx.start, { only: ctx.before.captured });
  const changes = diffSnapshots(ctx.before, after);
  const uncaptured = uncapturedParts(ctx.before, after);
  const { commits, headAfter } = await captureSoulCommits(scope.id, ctx.headBefore);
  const desires = desireChanges(changes, ctx.before, after);
  const emotions = emotionDelta(ctx.before, after);
  const skillsTouched = [
    ...new Set(
      changes
        .filter((c) => c.part === "skills")
        .map((c) => /^skills\/([^/]+)\/SKILL\.md$/.exec(c.path)?.[1])
        .filter((n): n is string => !!n),
    ),
  ].sort();

  if (
    changes.length === 0 &&
    commits.length === 0 &&
    !emotions &&
    reconsiderDelivered.length === 0 &&
    // A pass that ran while a part could not be captured is recorded, so the
    // log never claims "no changes" about a part it did not look at.
    (uncaptured.length === 0 || scope.runIds.length === 0)
  ) {
    return null;
  }

  // Revert sidecar, within the cap: for KB / skills the pre-pass content of
  // each changed file; for memory only the entry lines the pass added and
  // removed (an entry the pass never touched is never copied here).
  const sidecar: DreamSnapshotSidecar = { version: 1, id: scope.id, files: {}, memory: {} };
  let sidecarBytes = 0;
  for (const c of changes) {
    if (c.part === "soul" || !c.revertible) continue;
    const beforeText = ctx.before.files.get(c.path)?.content ?? null;
    const delta =
      c.part === "memory"
        ? memoryEntryDelta(beforeText ?? "", after.files.get(c.path)?.content ?? "")
        : null;
    const bytes = delta
      ? Buffer.byteLength([...delta.added, ...delta.removed].join("\n"), "utf8")
      : beforeText
        ? Buffer.byteLength(beforeText, "utf8")
        : 0;
    if (sidecarBytes + bytes > MAX_SIDECAR_BYTES) {
      c.revertible = false;
      c.notRevertibleReason = "the pre-dream copy did not fit the revert sidecar cap";
      continue;
    }
    sidecarBytes += bytes;
    if (delta) sidecar.memory![c.path] = delta;
    else sidecar.files[c.path] = beforeText;
  }
  const hasSidecar =
    Object.keys(sidecar.files).length > 0 || Object.keys(sidecar.memory!).length > 0;

  const outcome: DreamRecord["outcome"] =
    endOpts.outcome ??
    (endOpts.error !== undefined
      ? "error"
      : ((scope.runOutcomes.at(-1) as AutonomyOutcome | undefined) ?? "unknown"));
  const base: Omit<DreamRecord, "summary"> = {
    version: DREAM_RECORD_VERSION,
    id: scope.id,
    trigger: ctx.trigger,
    ...(ctx.task ? { task: ctx.task } : {}),
    windowStart: ctx.start.toISOString(),
    windowEnd: ctx.end.toISOString(),
    autonomyRunIds: [...scope.runIds],
    outcome,
    capture: ctx.headBefore ? "git" : "snapshot",
    soulCommits: commits,
    ...(ctx.headBefore ? { soulHeadBefore: ctx.headBefore } : {}),
    ...(headAfter ? { soulHeadAfter: headAfter } : {}),
    changes,
    desires,
    emotions,
    skillsTouched,
    metrics: computeMetrics({ changes, soulCommits: commits, desires, emotions, skillsTouched }),
    reconsiderDelivered,
    reverts: [],
    truncated: changes.some((c) => c.diffTruncated) || commits.some((c) => c.diffTruncated),
    capped: ctx.before.capped || after.capped,
    uncaptured,
    skippedSymlinks: skippedSymlinks(ctx.before, after),
  };
  const rec = fitRecord({ ...base, summary: renderSummary(base) }, MAX_RECORD_BYTES);

  await ensureDir(dreamsDir());
  await lockReve(async () => {
    // Sidecar first: a record must never point at revert data that is missing.
    if (hasSidecar) {
      await atomicWrite(dreamSnapshotFile(rec.id), JSON.stringify(sidecar) + "\n");
    }
    await writeDreamRecord(rec);
    await atomicWrite(dreamSummaryFile(rec.id), renderMarkdown(rec));
  });
  // Not on every pass, and not inside the record write's critical section.
  await maybeApplyRetention(ctx.end.getTime());
  return rec;
}

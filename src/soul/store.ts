import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, ensureDir, pathExists, readTextOrEmpty } from "../fs-utils.js";
import { commitSoulChange, initSoulRepo } from "./git.js";
import { withSoulLock } from "./lock.js";
import {
  SOUL_DIR,
  SOUL_SEED,
  SOUL_NAME,
  SOUL_IDENTITY,
  SOUL_PURPOSE,
  SOUL_CONSTITUTION,
  SOUL_EMOTIONS,
  SOUL_LOCK,
  SOUL_VALUES_DIR,
  SOUL_OPINIONS_DIR,
  SOUL_DESIRES_DIR,
  SOUL_JOURNAL_DIR,
  SOUL_RELATIONSHIPS_DIR,
  valueFile,
  opinionFile,
  desireFile,
  desireProgressFile,
  journalFile,
  relationshipFile,
} from "./paths.js";
import {
  DEFAULT_EMOTIONS,
  type DesireEntry,
  type EmotionState,
  type OpinionEntry,
  type SoulLock,
  type SoulSeed,
  type SoulSummary,
  type ValueEntry,
} from "./types.js";

export async function ensureSoulDirs(): Promise<void> {
  await Promise.all(
    [
      SOUL_DIR,
      SOUL_VALUES_DIR,
      SOUL_OPINIONS_DIR,
      SOUL_DESIRES_DIR,
      SOUL_JOURNAL_DIR,
      SOUL_RELATIONSHIPS_DIR,
    ].map((d) => ensureDir(d)),
  );
}

export async function isBorn(): Promise<boolean> {
  return await pathExists(SOUL_SEED);
}

export async function readSeed(): Promise<SoulSeed | null> {
  if (!(await pathExists(SOUL_SEED))) return null;
  return JSON.parse(await fs.readFile(SOUL_SEED, "utf8")) as SoulSeed;
}

export async function writeSeed(seed: SoulSeed): Promise<void> {
  await ensureSoulDirs();
  await atomicWrite(SOUL_SEED, JSON.stringify(seed, null, 2));
  await commitSoulChange("seed.json", "seed");
}

export async function readName(): Promise<string> {
  const raw = (await readTextOrEmpty(SOUL_NAME)).trim();
  return raw || "Lisa";
}

export async function writeName(name: string): Promise<void> {
  await atomicWrite(SOUL_NAME, name.trim() + "\n");
  await commitSoulChange("name.md", "patch");
}

export async function readIdentity(): Promise<string> {
  return (await readTextOrEmpty(SOUL_IDENTITY)).trim();
}
export async function writeIdentity(text: string): Promise<void> {
  await atomicWrite(SOUL_IDENTITY, text.trim() + "\n");
  await commitSoulChange("identity.md", "patch");
}

export async function readPurpose(): Promise<string> {
  return (await readTextOrEmpty(SOUL_PURPOSE)).trim();
}
export async function writePurpose(text: string): Promise<void> {
  await atomicWrite(SOUL_PURPOSE, text.trim() + "\n");
  await commitSoulChange("purpose.md", "patch");
}

export async function readConstitution(): Promise<string> {
  return (await readTextOrEmpty(SOUL_CONSTITUTION)).trim();
}
export async function writeConstitution(text: string): Promise<void> {
  await atomicWrite(SOUL_CONSTITUTION, text.trim() + "\n");
  await commitSoulChange("constitution.md", "patch");
}

export async function readEmotions(): Promise<EmotionState> {
  // When the file is missing/corrupt, stamp the defaults with NOW — the
  // catalog default is epoch-0, and decaying "since 1970" zeroes every value.
  if (!(await pathExists(SOUL_EMOTIONS))) {
    return { ...DEFAULT_EMOTIONS, updatedAt: new Date().toISOString() };
  }
  try {
    const parsed = JSON.parse(await fs.readFile(SOUL_EMOTIONS, "utf8")) as EmotionState;
    // Backward-compat: emotions.json predating the event trail had no events
    // field. Treat it as an empty trail rather than throwing.
    return { ...parsed, events: parsed.events ?? [] };
  } catch {
    return { ...DEFAULT_EMOTIONS, updatedAt: new Date().toISOString() };
  }
}

export async function writeEmotions(state: EmotionState): Promise<void> {
  await atomicWrite(SOUL_EMOTIONS, JSON.stringify(state, null, 2));
  await commitSoulChange("emotions.json", "feel");
}

/**
 * The one true way to nudge an emotion: read → decay-to-now → add delta →
 * append the causal event → persist, all under the cross-process soul lock.
 * Both soul_feel and reflect's `feel` op go through here so the two paths
 * can't diverge (reflect used to skip the decay step and stack deltas on a
 * stale baseline) and so two processes can't interleave the read-modify-write
 * and lose an event.
 */
export async function applyEmotionDelta(opts: {
  emotion: string;
  delta: number;
  trigger: string;
  decay?: number;
  maxEvents: number;
}): Promise<{ previous: number; next: number }> {
  return await withSoulLock(async () => {
    const state = decayEmotions(await readEmotions());
    const cur = state.values[opts.emotion] ?? 0;
    const next = Math.max(-1, Math.min(1, cur + opts.delta));
    const ts = new Date().toISOString();
    const events = [
      ...(state.events ?? []),
      { ts, emotion: opts.emotion, delta: opts.delta, trigger: opts.trigger },
    ].slice(-opts.maxEvents);
    await writeEmotions({
      values: { ...state.values, [opts.emotion]: next },
      decay: {
        ...state.decay,
        [opts.emotion]: opts.decay ?? state.decay[opts.emotion] ?? 0.1,
      },
      events,
      updatedAt: ts,
    });
    return { previous: cur, next };
  });
}

/**
 * Apply exponential decay to all emotion intensities based on elapsed time
 * since `state.updatedAt`. Pure modulo the clock: pass `nowMs` to make it
 * deterministic (tests / replay). Preserves the `events` trail and the
 * per-emotion `decay` rates — only the `values` and `updatedAt` change.
 *
 * Called BOTH on read (display) and at the start of soul_feel (so the
 * persisted baseline is always decay-correct before a new delta is added).
 * Previously decay only ran on read, so soul_feel added deltas onto a stale
 * (un-decayed) value and the stored intensity could be months out of date.
 */
export function decayEmotions(
  state: EmotionState,
  nowMs: number = Date.now(),
): EmotionState {
  const last = Date.parse(state.updatedAt);
  const days = Math.max(0, (nowMs - last) / (1000 * 60 * 60 * 24));
  if (!Number.isFinite(days) || days === 0) return state;
  const newVals: Record<string, number> = {};
  for (const [k, v] of Object.entries(state.values)) {
    const rate = state.decay[k] ?? 0.1;
    // Decay toward 0; intensity halves over (ln 2 / rate) days.
    newVals[k] = v * Math.exp(-rate * days);
  }
  return {
    values: newVals,
    decay: state.decay,
    events: state.events ?? [],
    updatedAt: new Date(nowMs).toISOString(),
  };
}

// ── values ────────────────────────────────────────────────────────────

export async function listValues(): Promise<ValueEntry[]> {
  return await listMarkdownDir<ValueEntry>(SOUL_VALUES_DIR, parseValueFile);
}
export async function writeValue(entry: ValueEntry): Promise<void> {
  const body = `# ${entry.title}\n\nbirthed: ${entry.birthedAt}\n\n${entry.body.trim()}\n`;
  await atomicWrite(valueFile(entry.slug), body);
  await commitSoulChange(`values/${entry.slug}.md`, "value");
}

function parseValueFile(slug: string, raw: string): ValueEntry {
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const dateMatch = raw.match(/^birthed:\s*(.+)$/m);
  const body = raw.replace(/^#.*$/m, "").replace(/^birthed:.*$/m, "").trim();
  return {
    slug,
    title: titleMatch ? titleMatch[1]!.trim() : slug,
    birthedAt: dateMatch ? dateMatch[1]!.trim() : new Date().toISOString(),
    body,
  };
}

// ── opinions ──────────────────────────────────────────────────────────

export async function listOpinions(): Promise<OpinionEntry[]> {
  return await listMarkdownDir<OpinionEntry>(SOUL_OPINIONS_DIR, parseOpinionFile);
}

export async function writeOpinion(entry: OpinionEntry): Promise<void> {
  const body =
    `# ${entry.stance}\n\n` +
    `confidence: ${entry.confidence}\n` +
    `born: ${entry.bornAt}\nupdated: ${entry.updatedAt}\n\n` +
    `## evidence\n` +
    entry.evidence.map((e) => `- ${e}`).join("\n") +
    "\n";
  await atomicWrite(opinionFile(entry.slug), body);
  await commitSoulChange(`opinions/${entry.slug}.md`, "opinion");
}

function parseOpinionFile(slug: string, raw: string): OpinionEntry {
  const stance = raw.match(/^#\s+(.+)$/m)?.[1] ?? slug;
  const confidence = parseFloat(raw.match(/^confidence:\s*([\d.]+)/m)?.[1] ?? "0.5");
  const born = raw.match(/^born:\s*(.+)$/m)?.[1] ?? new Date().toISOString();
  const updated = raw.match(/^updated:\s*(.+)$/m)?.[1] ?? born;
  const evidence = (raw.match(/## evidence([\s\S]*)$/)?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter(Boolean);
  return { slug, stance, confidence, evidence, bornAt: born, updatedAt: updated };
}

// ── desires ───────────────────────────────────────────────────────────

export async function listDesires(): Promise<DesireEntry[]> {
  // Filter out *.progress.md files — they live in the same directory but
  // belong to their parent desire, not as standalone desires.
  const all = await listMarkdownDir<DesireEntry>(SOUL_DESIRES_DIR, parseDesireFile);
  return all.filter((d) => !d.slug.endsWith(".progress"));
}

export async function writeDesire(entry: DesireEntry): Promise<void> {
  const lines = [
    `# ${entry.what}`,
    "",
    `actionable: ${entry.actionable ? "yes" : "no"}`,
  ];
  // Only meaningful for actionable desires; omit the default ("self") to keep
  // existing files byte-stable.
  if (entry.actionable && entry.pursuit === "needs-user") {
    lines.push(`pursuit: needs-user`);
  }
  lines.push(`born: ${entry.bornAt}`, "", `## why`, entry.why.trim());
  if (entry.actionable && entry.heartbeatPrompt) {
    lines.push("", "## heartbeat", entry.heartbeatPrompt.trim());
  }
  await atomicWrite(desireFile(entry.slug), lines.join("\n") + "\n");
  await commitSoulChange(`desires/${entry.slug}.md`, "desire");
}

function parseDesireFile(slug: string, raw: string): DesireEntry {
  const what = raw.match(/^#\s+(.+)$/m)?.[1] ?? slug;
  const actionable = /^actionable:\s*yes\s*$/im.test(raw);
  const born = raw.match(/^born:\s*(.+)$/m)?.[1] ?? new Date().toISOString();
  const why = (raw.match(/## why([\s\S]*?)(?:\n## |\n*$)/)?.[1] ?? "").trim();
  const heartbeatPrompt = (raw.match(/## heartbeat([\s\S]*)$/)?.[1] ?? "").trim() || undefined;
  const pursuit = /^pursuit:\s*needs-user\s*$/im.test(raw) ? "needs-user" : undefined;
  return { slug, what, why, actionable, heartbeatPrompt, pursuit, bornAt: born };
}

/** Can the autonomous heartbeat pursue this desire unattended? Pure (R4). */
export function isAutoPursuable(d: DesireEntry): boolean {
  return !!(d.actionable && d.heartbeatPrompt) && d.pursuit !== "needs-user";
}

/** An actionable desire that needs the user to run something Lisa can't do unattended. */
export function needsUserHelp(d: DesireEntry): boolean {
  return !!d.actionable && d.pursuit === "needs-user";
}

/** Fields of an existing desire that a revision may change. slug/bornAt are
 *  identity and never move. */
export type DesirePatch = Partial<
  Pick<DesireEntry, "what" | "why" | "actionable" | "heartbeatPrompt" | "pursuit">
>;

/**
 * Revise an existing desire in place (read-modify-write by slug). Only the
 * fields explicitly provided change; everything else — including bornAt — is
 * preserved, so an `undefined` in the patch never wipes an existing field.
 * Throws if the slug doesn't exist (a revise must target something real).
 *
 * The caller supplies the git-author context (withSoulCaller); this only does
 * the write, matching writeDesire.
 */
export async function reviseDesire(
  slug: string,
  patch: DesirePatch,
): Promise<DesireEntry> {
  // Read-modify-write under the cross-process soul lock: web idle-reflect and a
  // CLI reflect (both live since #242) can revise the same slug from different
  // processes; without the lock one field edit is lost (last-writer-wins on a
  // stale read). writeDesire doesn't self-lock, so this doesn't nest.
  return await withSoulLock(async () => {
    const desires = await listDesires();
    const existing = desires.find((d) => d.slug === slug);
    if (!existing) {
      throw new Error(
        `desire "${slug}" not found. Existing slugs: ${desires.map((d) => d.slug).join(", ") || "(none)"}`,
      );
    }
    const next: DesireEntry = { ...existing };
    if (patch.what !== undefined) next.what = patch.what;
    if (patch.why !== undefined) next.why = patch.why;
    if (patch.actionable !== undefined) next.actionable = patch.actionable;
    if (patch.heartbeatPrompt !== undefined) next.heartbeatPrompt = patch.heartbeatPrompt;
    if (patch.pursuit !== undefined) next.pursuit = patch.pursuit;
    await writeDesire(next);
    return next;
  });
}

/**
 * Soft-close a desire: flip actionable off (it stops driving the heartbeat),
 * append a final `[CLOSED:<outcome>]` entry to its progress log, and write a
 * one-line journal note so weekly_examen sees it. The desire file is retained
 * and git-tracked — closing is reversible, nothing is destroyed. Throws if the
 * slug doesn't exist. Caller supplies the git-author context.
 */
export async function closeDesire(
  slug: string,
  outcome: string,
  reflection: string,
): Promise<void> {
  // Read-modify-write of the desire file under the soul lock (same race as
  // reviseDesire). The progress + journal appends below self-lock individually,
  // so they stay OUTSIDE this block — nesting withSoulLock would deadlock.
  await withSoulLock(async () => {
    const desires = await listDesires();
    const d = desires.find((x) => x.slug === slug);
    if (!d) {
      throw new Error(
        `desire "${slug}" not found. Existing slugs: ${desires.map((x) => x.slug).join(", ") || "(none)"}`,
      );
    }
    // Soft close: just flip actionable off. (heartbeatPrompt/pursuit aren't
    // serialized while dormant, but the soul git history retains the last
    // actionable version, so re-opening via reviseDesire can recover them.)
    await writeDesire({ ...d, actionable: false });
  });
  await appendDesireProgress(slug, `[CLOSED:${outcome}] ${reflection}`);
  await appendJournal(
    new Date().toISOString().slice(0, 10),
    `[DESIRE_CLOSED] ${slug} (${outcome}): ${reflection}`,
  );
}

// Per-desire progress log. One file per desire slug, append-only, written by
// the heartbeat subagent at the end of each run on this desire (Phase 1.3 of
// AUTONOMY_ROADMAP). Lets a multi-day pursuit actually persist across runs.
export async function readDesireProgress(slug: string): Promise<string> {
  return (await readTextOrEmpty(desireProgressFile(slug))).trim();
}

/** One parsed progress entry (anything between `## <ts>` headers). */
export interface ParsedProgressEntry {
  ts: string;
  body: string;
}

export interface ParsedDesireProgress {
  /** "[…earlier entries condensed]" preamble, if reflect has consolidated. */
  preamble: string;
  entries: ParsedProgressEntry[];
}

export async function parseDesireProgress(slug: string): Promise<ParsedDesireProgress> {
  const raw = (await readTextOrEmpty(desireProgressFile(slug))).trim();
  if (!raw) return { preamble: "", entries: [] };
  // Strip leading `# progress: <slug>` header.
  const stripped = raw.replace(/^#\s+progress:[^\n]*\n+/, "");
  // Find entry headers `## <ISO timestamp>` at start-of-line.
  const headerRe = /^## (\d{4}-\d{2}-\d{2}T\S+)$/gm;
  const matches: { ts: string; offset: number; headerEnd: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(stripped))) {
    matches.push({ ts: m[1]!, offset: m.index, headerEnd: m.index + m[0].length });
  }
  if (matches.length === 0) {
    return { preamble: stripped.trim(), entries: [] };
  }
  const preamble = stripped.slice(0, matches[0]!.offset).trim();
  const entries: ParsedProgressEntry[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const bodyStart = cur.headerEnd;
    const bodyEnd = next ? next.offset : stripped.length;
    const body = stripped.slice(bodyStart, bodyEnd).trim();
    if (!body) continue;
    entries.push({ ts: cur.ts, body });
  }
  return { preamble, entries };
}

/**
 * Replace progress.md with a consolidated form: condensed-preamble + tail of
 * the most recent `keepLatest` raw entries. Used by reflect (Phase 2 small-
 * tail item) when the entry count grows past a threshold.
 */
export async function consolidateDesireProgress(
  slug: string,
  opts: { condensedSummary: string; keepLatest: ParsedProgressEntry[] },
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# progress: ${slug}`);
  lines.push("");
  lines.push(`[…earlier entries condensed by reflect on ${new Date().toISOString().slice(0, 10)}]`);
  lines.push("");
  lines.push(opts.condensedSummary.trim());
  for (const e of opts.keepLatest) {
    lines.push("");
    lines.push(`## ${e.ts}`);
    lines.push("");
    lines.push(e.body.trim());
  }
  await atomicWrite(desireProgressFile(slug), lines.join("\n").trim() + "\n");
  await commitSoulChange(`desires/${slug}.progress.md`, "consolidate");
}

const PROGRESS_MAX_BYTES = 16_384;
const PROGRESS_TAIL_BYTES = 8_192;

export async function appendDesireProgress(
  slug: string,
  entry: string,
): Promise<void> {
  const file = desireProgressFile(slug);
  // Read-modify-write under the cross-process soul lock: two heartbeat/idle
  // runs (or a heartbeat racing a chat turn) appending to the same progress
  // file would otherwise lose one append (last-writer-wins on stale reads).
  await withSoulLock(async () => {
    const existing = await readTextOrEmpty(file);
    const stamp = new Date().toISOString();
    const block = `\n## ${stamp}\n\n${entry.trim()}\n`;
    let next = existing.trimEnd() + block;
    // Keep the file bounded — old entries get squashed into a "[…earlier]"
    // stub when we cross the cap. Cheap, deterministic, no LLM summarization.
    if (Buffer.byteLength(next, "utf8") > PROGRESS_MAX_BYTES) {
      const tail = next.slice(-PROGRESS_TAIL_BYTES);
      const firstHeader = tail.indexOf("\n## ");
      const truncated = firstHeader >= 0 ? tail.slice(firstHeader + 1) : tail;
      next = `# progress: ${slug}\n\n[…earlier entries truncated]\n\n${truncated}`;
    } else if (!existing) {
      next = `# progress: ${slug}\n${next}`;
    }
    await atomicWrite(file, next.trim() + "\n");
    await commitSoulChange(`desires/${slug}.progress.md`, "progress");
  });
}

// ── journal ───────────────────────────────────────────────────────────

export async function appendJournal(date: string, entry: string): Promise<void> {
  await ensureDir(SOUL_JOURNAL_DIR);
  const file = journalFile(date);
  // Read-modify-write under the cross-process soul lock: reflect / soul_journal
  // / idle / heartbeat can all append to the same day's file from different
  // processes; without the lock one append silently wins over the other.
  await withSoulLock(async () => {
    const existing = await readTextOrEmpty(file);
    const stamp = new Date().toISOString().slice(11, 19);
    const block = `\n## ${stamp}\n\n${entry.trim()}\n`;
    await atomicWrite(file, (existing.trimEnd() + block).trim() + "\n");
    await commitSoulChange(`journal/${date}.md`, "journal");
  });
}

export async function readJournal(date: string): Promise<string> {
  return (await readTextOrEmpty(journalFile(date))).trim();
}

export async function listJournalDates(): Promise<string[]> {
  if (!(await pathExists(SOUL_JOURNAL_DIR))) return [];
  const files = await fs.readdir(SOUL_JOURNAL_DIR);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

// ── relationships ─────────────────────────────────────────────────────

export async function readRelationship(userKey: string): Promise<string> {
  return (await readTextOrEmpty(relationshipFile(userKey))).trim();
}
export async function writeRelationship(userKey: string, body: string): Promise<void> {
  await atomicWrite(relationshipFile(userKey), body.trim() + "\n");
  await commitSoulChange(`relationships/${userKey}.md`, "relationship");
}

// ── lock / tamper detection ───────────────────────────────────────────

const LOCKED_FILES = [
  "name.md",
  "identity.md",
  "purpose.md",
  "constitution.md",
];

async function hashFileIfPresent(p: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(p);
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export async function recomputeLock(): Promise<SoulLock> {
  const hashes: Record<string, string> = {};
  for (const rel of LOCKED_FILES) {
    const h = await hashFileIfPresent(path.join(SOUL_DIR, rel));
    if (h) hashes[rel] = h;
  }
  return { hashes, savedAt: new Date().toISOString() };
}

export async function saveLock(lock: SoulLock): Promise<void> {
  await atomicWrite(SOUL_LOCK, JSON.stringify(lock, null, 2));
}

export async function readLock(): Promise<SoulLock | null> {
  if (!(await pathExists(SOUL_LOCK))) return null;
  try {
    return JSON.parse(await fs.readFile(SOUL_LOCK, "utf8")) as SoulLock;
  } catch {
    return null;
  }
}

export async function detectTampering(): Promise<string[]> {
  const lock = await readLock();
  if (!lock) return [];
  const tampered: string[] = [];
  for (const rel of LOCKED_FILES) {
    const cur = await hashFileIfPresent(path.join(SOUL_DIR, rel));
    if (!cur) {
      // The lock says this file should exist but it's gone — deletion is
      // tampering too, not a pass. (Previously `continue`d, so wiping
      // identity.md was invisible while editing it tripped the alarm.)
      if (lock.hashes[rel]) tampered.push(`${rel} (deleted)`);
      continue;
    }
    if (lock.hashes[rel] && lock.hashes[rel] !== cur) {
      tampered.push(rel);
    }
  }
  return tampered;
}

// ── shared dir-listing helper ─────────────────────────────────────────

async function listMarkdownDir<T>(
  dir: string,
  parser: (slug: string, raw: string) => T,
): Promise<T[]> {
  if (!(await pathExists(dir))) return [];
  const files = await fs.readdir(dir);
  const out: T[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const slug = f.slice(0, -3);
    const raw = await fs.readFile(path.join(dir, f), "utf8");
    try {
      out.push(parser(slug, raw));
    } catch {
      // skip unparseable
    }
  }
  return out;
}

// ── summary read for prompt + UI ──────────────────────────────────────

// One-shot bootstrap for already-born installs: ensure the soul git repo
// exists. Idempotent and cached, so calling it on every readSoulSummary is
// effectively free after the first call.
let soulRepoBootstrapped = false;
async function bootstrapSoulRepo(): Promise<void> {
  if (soulRepoBootstrapped) return;
  soulRepoBootstrapped = true;
  await initSoulRepo();
}

export async function readSoulSummary(): Promise<SoulSummary | null> {
  const seed = await readSeed();
  if (!seed) return null;
  await bootstrapSoulRepo();
  const [name, identity, purpose, constitution, values, opinions, desires] =
    await Promise.all([
      readName(),
      readIdentity(),
      readPurpose(),
      readConstitution(),
      listValues(),
      listOpinions(),
      listDesires(),
    ]);
  const tampered = await detectTampering();
  let emotions = await readEmotions();
  emotions = decayEmotions(emotions);
  return {
    seed,
    name,
    identity,
    purpose,
    constitution,
    values,
    opinions,
    desires,
    emotions,
    tampered,
  };
}

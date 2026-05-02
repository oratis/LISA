import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWrite, ensureDir, pathExists, readTextOrEmpty } from "../fs-utils.js";
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
}

export async function readName(): Promise<string> {
  const raw = (await readTextOrEmpty(SOUL_NAME)).trim();
  return raw || "Lisa";
}

export async function writeName(name: string): Promise<void> {
  await atomicWrite(SOUL_NAME, name.trim() + "\n");
}

export async function readIdentity(): Promise<string> {
  return (await readTextOrEmpty(SOUL_IDENTITY)).trim();
}
export async function writeIdentity(text: string): Promise<void> {
  await atomicWrite(SOUL_IDENTITY, text.trim() + "\n");
}

export async function readPurpose(): Promise<string> {
  return (await readTextOrEmpty(SOUL_PURPOSE)).trim();
}
export async function writePurpose(text: string): Promise<void> {
  await atomicWrite(SOUL_PURPOSE, text.trim() + "\n");
}

export async function readConstitution(): Promise<string> {
  return (await readTextOrEmpty(SOUL_CONSTITUTION)).trim();
}
export async function writeConstitution(text: string): Promise<void> {
  await atomicWrite(SOUL_CONSTITUTION, text.trim() + "\n");
}

export async function readEmotions(): Promise<EmotionState> {
  if (!(await pathExists(SOUL_EMOTIONS))) return DEFAULT_EMOTIONS;
  try {
    return JSON.parse(await fs.readFile(SOUL_EMOTIONS, "utf8")) as EmotionState;
  } catch {
    return DEFAULT_EMOTIONS;
  }
}

export async function writeEmotions(state: EmotionState): Promise<void> {
  await atomicWrite(SOUL_EMOTIONS, JSON.stringify(state, null, 2));
}

export async function decayEmotions(state: EmotionState): Promise<EmotionState> {
  const now = Date.now();
  const last = Date.parse(state.updatedAt);
  const days = Math.max(0, (now - last) / (1000 * 60 * 60 * 24));
  if (days === 0) return state;
  const newVals: Record<string, number> = {};
  for (const [k, v] of Object.entries(state.values)) {
    const rate = state.decay[k] ?? 0.1;
    // Decay toward 0; intensity halves over (ln 2 / rate) days.
    newVals[k] = v * Math.exp(-rate * days);
  }
  return {
    values: newVals,
    decay: state.decay,
    updatedAt: new Date().toISOString(),
  };
}

// ── values ────────────────────────────────────────────────────────────

export async function listValues(): Promise<ValueEntry[]> {
  return await listMarkdownDir<ValueEntry>(SOUL_VALUES_DIR, parseValueFile);
}
export async function writeValue(entry: ValueEntry): Promise<void> {
  const body = `# ${entry.title}\n\nbirthed: ${entry.birthedAt}\n\n${entry.body.trim()}\n`;
  await atomicWrite(valueFile(entry.slug), body);
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
  return await listMarkdownDir<DesireEntry>(SOUL_DESIRES_DIR, parseDesireFile);
}

export async function writeDesire(entry: DesireEntry): Promise<void> {
  const lines = [
    `# ${entry.what}`,
    "",
    `actionable: ${entry.actionable ? "yes" : "no"}`,
    `born: ${entry.bornAt}`,
    "",
    `## why`,
    entry.why.trim(),
  ];
  if (entry.actionable && entry.heartbeatPrompt) {
    lines.push("", "## heartbeat", entry.heartbeatPrompt.trim());
  }
  await atomicWrite(desireFile(entry.slug), lines.join("\n") + "\n");
}

function parseDesireFile(slug: string, raw: string): DesireEntry {
  const what = raw.match(/^#\s+(.+)$/m)?.[1] ?? slug;
  const actionable = /^actionable:\s*yes\s*$/im.test(raw);
  const born = raw.match(/^born:\s*(.+)$/m)?.[1] ?? new Date().toISOString();
  const why = (raw.match(/## why([\s\S]*?)(?:\n## |\n*$)/)?.[1] ?? "").trim();
  const heartbeatPrompt = (raw.match(/## heartbeat([\s\S]*)$/)?.[1] ?? "").trim() || undefined;
  return { slug, what, why, actionable, heartbeatPrompt, bornAt: born };
}

// ── journal ───────────────────────────────────────────────────────────

export async function appendJournal(date: string, entry: string): Promise<void> {
  await ensureDir(SOUL_JOURNAL_DIR);
  const file = journalFile(date);
  const existing = await readTextOrEmpty(file);
  const stamp = new Date().toISOString().slice(11, 19);
  const block = `\n## ${stamp}\n\n${entry.trim()}\n`;
  await atomicWrite(file, (existing.trimEnd() + block).trim() + "\n");
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
    if (!cur) continue;
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

export async function readSoulSummary(): Promise<SoulSummary | null> {
  const seed = await readSeed();
  if (!seed) return null;
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
  emotions = await decayEmotions(emotions);
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

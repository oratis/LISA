/**
 * Cross-layer "forget" (memory sovereignty, W8): the person names a topic and
 * every layer of the ACTIVE home that holds it is cleaned, or — with
 * `dryRun` — previewed. The audit line carries counts only (not even the
 * query).
 *
 * Matching is by whole word: case-insensitive, Unicode-aware and
 * whitespace-tolerant, so "Ann" matches "Ann", "ann's" and "Ann-Marie" but
 * never "annual", "planning" or "announcement". Scripts written without
 * spaces between words (Chinese, Japanese, Korean, Thai…) have no word
 * boundaries; there the query matches as the exact character sequence, also
 * inside longer words, and the report says so (`match`). A minimum query
 * length keeps a stray "a" from wiping a home.
 *
 * Preview, then apply. A dry run lists every item it would change, each with
 * a stable id and a short snippet of the text around the match, plus a
 * `digest` over those ids. Apply with `digest` re-plans first and refuses
 * (`preview_changed`) unless it finds exactly the previewed set; each write
 * then re-checks its own item id against the file's current content, so
 * nothing the preview did not show is changed. What each layer does:
 *
 *  memory / user        drop every MEMORY.md / USER.md entry that mentions it
 *  kb                   delete a page whose title or a tag names it; elsewhere
 *                       replace matching body lines and provenance values. A
 *                       page is never deleted for its file name alone (listed
 *                       as untouched instead)
 *  memory_kb_links      strip `[[kb:slug]]` / `[[slug]]` pointers (in memory
 *                       and in other pages) to the pages deleted above
 *  sessions             replace matching message text with "[forgotten by
 *                       user]", redact matching lines in recorded prompts /
 *                       reflection summaries. Content fields only: the
 *                       header, types, ids, timestamps and roles are never
 *                       touched, so every transcript still loads
 *  reflections          per-session reflection records: matching content
 *                       strings (kinds, stores, slugs kept)
 *  tasks                task specs (title, instruction, summary, watcher
 *                       match text), run transcripts and pending notices —
 *                       content fields only, under each file's own lock
 *  search_index         drop the in-memory session + KB indexes and the
 *                       persisted embedding cache (vectors of the old text)
 *  relationships        literal matches only, soul-git commit `user-forget`
 *  journal              Lisa's private journal is HERS: only literal matches
 *                       of the user's words are replaced, each file change is
 *                       a soul-git commit labelled `user-forget`, and Lisa is
 *                       told (a prompt Notice) that the person used forget.
 *
 * Lisa's own self (identity, values, opinions, desires) is never edited; any
 * mentions there are reported as `untouched`. Everything else in the home
 * that can hold user text but is not scanned is named in `notScanned` (see
 * coverage.ts), so the re-scan after apply verifies only what it says.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { lisaGlobalHome, lisaHome, reflectionsDir, sessionsDir } from "../paths.js";
import {
  isMemoryStore,
  MEMORY_STORES,
  MemoryEditError,
  readMemoryStore,
  rewriteMemoryEntries,
  type MemoryEntry,
} from "../memory/entries.js";
import { forgetInEntry, listFullEntries, type KbEntry } from "../kb/store.js";
import { commitSoulChange, withSoulCaller } from "../soul/git.js";
import { withSoulLock } from "../soul/lock.js";
import { soulDir, soulJournalDir, soulRelationshipsDir } from "../soul/paths.js";
import { rewriteTaskJson, tasksDir } from "../tasks/store.js";
import { isSafeId } from "../tasks/types.js";
import { rewriteOutboxEntry, type OutboxEntry } from "../tasks/outbox.js";
import { appendSovereigntyAudit, sovereigntyDir } from "./audit.js";
import { notScannedIn, scannedAreas } from "./coverage.js";

export const FORGOTTEN = "[forgotten by user]";
export const FORGET_MIN_CHARS = 3;
/**
 * Two characters are a whole word in Chinese, Japanese and Korean (机密, 秘密,
 * 비밀), so a query with any CJK character may be that short.
 */
export const FORGET_MIN_CHARS_CJK = 2;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Stores some modules still keep in the process home rather than the account
 * home (they resolve their own path instead of `lisaHome()`). Inside an
 * account scope — the hosted edition — forget cannot reach them, so the report
 * names them instead of implying they were covered.
 */
export const OUTSIDE_ACCOUNT_HOME_STORES = [
  "mail — mail digests and alerts are stored outside your account home on this edition; not scanned",
  "sense — activity events are stored outside your account home on this edition; not scanned",
  "dispatches — coding-agent dispatch records are stored outside your account home on this edition; not scanned",
] as const;
export const FORGET_MAX_CHARS = 200;

export type ForgetLayer =
  | "memory"
  | "user"
  | "kb"
  | "memory_kb_links"
  | "sessions"
  | "reflections"
  | "tasks"
  | "search_index"
  | "relationships"
  | "journal";

export const FORGET_LAYERS: readonly ForgetLayer[] = [
  "memory",
  "user",
  "kb",
  "memory_kb_links",
  "sessions",
  "reflections",
  "tasks",
  "search_index",
  "relationships",
  "journal",
];

export type ForgetAction = "delete" | "redact" | "evict" | "unlink" | "none";

export interface ForgetLocation {
  /** Stable id of this item. Apply changes only items the preview listed. */
  id: string;
  layer: ForgetLayer | "soul";
  /**
   * Home-relative path, with `#<entry id>` for a memory entry and `:<line>`
   * (1-based) for a line of a transcript or a soul file.
   */
  location: string;
  matches: number;
  action: ForgetAction;
  /**
   * Dry run only: the text around the first match (whitespace collapsed,
   * about 80 characters), so the person sees what will go. Never in an
   * applied report, never in the audit.
   */
  snippet?: string;
  /** Why this action, when it is not obvious: "title", "tag", "file name". */
  why?: string;
}

export interface ForgetMatchInfo {
  /** "words": whole-word matching; "sequence": the query has unspaced text. */
  mode: "words" | "sequence";
  /** The matching rule in one sentence, for the preview. */
  note: string;
}

export interface ForgetReport {
  dryRun: boolean;
  match: ForgetMatchInfo;
  /**
   * Digest of the previewed item ids. Pass it back (`digest`) to apply
   * exactly this preview; apply refuses if the set has changed.
   */
  digest: string;
  counts: Record<ForgetLayer, number>;
  locations: ForgetLocation[];
  /** Mentions forget reports but does not edit (Lisa's own soul, KB file names). */
  untouched: ForgetLocation[];
  /** Layers that could not be processed (code only, no content). */
  errors: { layer: ForgetLayer; error: string }[];
  /** Things that cannot be erased from here, stated honestly. */
  residuals: string[];
  /** What forget searches (and an applied forget re-scans), as "area — what". */
  scanned: string[];
  /**
   * Entries present in this home that can hold user text and that forget
   * does not scan ("path — what"); each is also a "Not scanned: …" residual.
   */
  notScanned: string[];
  /**
   * Apply only: a re-scan of the `scanned` areas after the writes; every
   * count should be 0. It says nothing about `notScanned`.
   */
  remaining?: Record<ForgetLayer, number>;
}

export interface ForgetOptions {
  dryRun?: boolean;
  /**
   * The `digest` of the preview the person confirmed. Apply refuses with
   * `preview_changed` unless the current plan has exactly that digest.
   */
  digest?: string;
}

export class ForgetError extends Error {
  constructor(
    readonly code: "invalid_query" | "preview_changed",
    message: string,
  ) {
    super(message);
    this.name = "ForgetError";
  }
}

export const FORGET_RESIDUALS: readonly string[] = [
  "Model provider logs: anything already sent to the model provider is kept under that provider's own retention policy and can't be erased from here.",
  "Backups: Time Machine or volume snapshots, earlier exports, and import-backups/ folders still hold the old data.",
  "Git history: soul/.git and kb/.git keep earlier versions of changed files (that is what keeps this forget auditable); remove those repositories to purge history.",
  "Delivered messages: push notifications, Live Activities, email digests and IM/channel messages already sent can't be recalled.",
  "A conversation in progress keeps the topic in its context until it ends.",
  "Images and attachments inside past messages are not inspected.",
  "Lisa's own soul files (identity, values, opinions, desires) are hers and are never edited; mentions there are listed as untouched.",
  "Knowledge-base file names are not renamed; a page whose file name alone mentions the topic is listed as untouched.",
];

// ── matching ─────────────────────────────────────────────────────────────

export interface Matcher {
  mode: ForgetMatchInfo["mode"];
  test(s: string): boolean;
  count(s: string): number;
  /** Replace each match with FORGOTTEN. */
  redact(s: string): string;
  /** The first match, or null. */
  first(s: string): { index: number; length: number } | null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Scripts written without spaces between words: no word boundaries there. */
const UNSPACED =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}" +
  "\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}";
/** A character that continues a word in a spaced script. */
const WORD_CHAR = `(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}\\p{Pc}])`;
const WORD_CHAR_RE = new RegExp(`^${WORD_CHAR}$`, "u");
const UNSPACED_RE = new RegExp(`[${UNSPACED}]`, "u");

export function normalizeForgetQuery(raw: unknown): string {
  if (typeof raw !== "string") throw new ForgetError("invalid_query", "query must be a string");
  const q = raw.replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(q)) {
    throw new ForgetError("invalid_query", "query contains control characters");
  }
  const len = [...q].length;
  const min = CJK_RE.test(q) ? FORGET_MIN_CHARS_CJK : FORGET_MIN_CHARS;
  if (len < min) {
    throw new ForgetError("invalid_query", `query must be at least ${min} characters`);
  }
  if (len > FORGET_MAX_CHARS) {
    throw new ForgetError("invalid_query", `query must be at most ${FORGET_MAX_CHARS} characters`);
  }
  return q;
}

/**
 * Whole-word matcher: a query edge that is a letter or digit of a spaced
 * script must not continue into another letter or digit. Edges in an
 * unspaced script (or punctuation) match as they are.
 *
 * Existing placeholders are never matched: the text is matched piece by
 * piece between occurrences of FORGOTTEN, so a query such as "user" or
 * "forgotten" can't hit an earlier redaction (forget stays idempotent).
 */
export function forgetMatcher(query: string): Matcher {
  const chars = [...query];
  const lead = WORD_CHAR_RE.test(chars[0] ?? "") ? `(?<!${WORD_CHAR})` : "";
  const trail = WORD_CHAR_RE.test(chars[chars.length - 1] ?? "") ? `(?!${WORD_CHAR})` : "";
  const source = lead + query.split(" ").map(escapeRe).join("\\s+") + trail;
  const re = () => new RegExp(source, "giu");
  const pieces = (s: string) => s.split(FORGOTTEN);
  return {
    mode: UNSPACED_RE.test(query) ? "sequence" : "words",
    test: (s) => pieces(s).some((p) => re().test(p)),
    count: (s) => pieces(s).reduce((n, p) => n + [...p.matchAll(re())].length, 0),
    redact: (s) =>
      pieces(s)
        .map((p) => p.replace(re(), FORGOTTEN))
        .join(FORGOTTEN),
    first: (s) => {
      let offset = 0;
      for (const p of pieces(s)) {
        const hit = re().exec(p);
        if (hit) return { index: offset + hit.index, length: hit[0].length };
        offset += p.length + FORGOTTEN.length;
      }
      return null;
    },
  };
}

function matchInfo(m: Matcher): ForgetMatchInfo {
  return m.mode === "sequence"
    ? {
        mode: "sequence",
        note: "This topic is written in a script without spaces between words, so it matches wherever that exact character sequence appears, also inside longer words. Check the items before you confirm.",
      }
    : {
        mode: "words",
        note: "Matches the topic as whole words, ignoring case: “Ann” matches “Ann” and “Ann's”, never “annual” or “planning”.",
      };
}

const SNIPPET_RADIUS = 40;

/** About 80 characters around the first match, whitespace collapsed. */
export function snippetAround(text: string, m: Matcher): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const hit = m.first(flat);
  let start = hit ? Math.max(0, hit.index - SNIPPET_RADIUS) : 0;
  let end = hit
    ? Math.min(flat.length, hit.index + hit.length + SNIPPET_RADIUS)
    : Math.min(flat.length, 2 * SNIPPET_RADIUS);
  // Never cut a surrogate pair in half.
  if (start > 0 && /[\udc00-\udfff]/.test(flat[start]!)) start--;
  if (end < flat.length && /[\ud800-\udbff]/.test(flat[end - 1]!)) end++;
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

function redactLines(text: string, m: Matcher): string {
  return text
    .split("\n")
    .map((l) => (m.test(l) ? FORGOTTEN : l))
    .join("\n");
}

const NO_KEYS: ReadonlySet<string> = new Set();

/** Reflection-record keys that name kinds, stores or slugs, never content. */
const REFLECTION_STRUCTURAL: ReadonlySet<string> = new Set([
  "kind",
  "store",
  "slug",
  "emotion",
  "delta",
  "confidence",
  "underReflected",
]);

interface Redacted {
  value: unknown;
  changed: number;
  /** The first matched text, for the preview snippet. */
  sample?: string;
}

/**
 * Replace every matching string VALUE in a JSON-ish value. Keys are never
 * touched, and nor is any value under a key in `structural` (ids, types,
 * timestamps…), at any depth.
 */
function redactStrings(
  value: unknown,
  m: Matcher,
  structural: ReadonlySet<string> = NO_KEYS,
): Redacted {
  if (typeof value === "string") {
    return m.test(value) ? { value: FORGOTTEN, changed: 1, sample: value } : { value, changed: 0 };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    let sample: string | undefined;
    const out = value.map((v) => {
      const r = redactStrings(v, m, structural);
      changed += r.changed;
      sample ??= r.sample;
      return r.value;
    });
    return { value: out, changed, sample };
  }
  if (value && typeof value === "object") {
    let changed = 0;
    let sample: string | undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (structural.has(k)) {
        out[k] = v;
        continue;
      }
      const r = redactStrings(v, m, structural);
      changed += r.changed;
      sample ??= r.sample;
      out[k] = r.value;
    }
    return { value: out, changed, sample };
  }
  return { value, changed: 0 };
}

function rel(abs: string): string {
  return path.relative(lisaHome(), abs).split(path.sep).join("/");
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(ext))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

function zeroCounts(): Record<ForgetLayer, number> {
  return Object.fromEntries(FORGET_LAYERS.map((l) => [l, 0])) as Record<ForgetLayer, number>;
}

function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** A stable item id: what is changed, where, and the content it was planned on. */
function itemId(...parts: string[]): string {
  return sha(parts.join("\0")).slice(0, 16);
}

// ── run context ──────────────────────────────────────────────────────────

interface Ctx {
  m: Matcher;
  apply: boolean;
  snippets: boolean;
  /** Apply: the ids the confirmed preview listed; anything else is left alone. */
  allowed: Set<string> | null;
  report: ForgetReport;
}

type Item = Omit<ForgetLocation, "snippet">;

function allowed(ctx: Ctx, id: string): boolean {
  return !ctx.allowed || ctx.allowed.has(id);
}

/** Record an item (and count it under `layer`, unless null). */
function addItem(ctx: Ctx, item: Item, text: string | undefined, count: number): void {
  const out: ForgetLocation = { ...item };
  if (ctx.snippets && text !== undefined) out.snippet = snippetAround(text, ctx.m);
  ctx.report.locations.push(out);
  if (item.layer !== "soul") ctx.report.counts[item.layer] += count;
}

/** Digest over the ids of everything apply would change (search_index excluded). */
function digestOf(locations: ForgetLocation[]): string {
  const ids = locations
    .filter((l) => l.layer !== "search_index")
    .map((l) => l.id)
    .sort();
  return sha(ids.join("\n")).slice(0, 32);
}

// ── sessions ─────────────────────────────────────────────────────────────
//
// Only content-bearing fields are ever rewritten: message text, thinking
// (dropped whole — it is signed), tool inputs' string values and tool
// results, recorded prompt text and reflection summaries. The header line,
// entry types, ids, timestamps, roles, tool names / ids and every other
// entry type are left exactly as they are, so a transcript still loads and
// replays after a forget, whatever the query.

interface Block {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  input?: unknown;
  content?: unknown;
}

/** Redact one message's content. Returns the new content and the first matched text. */
function redactContent(
  content: unknown,
  m: Matcher,
): { content: unknown; changed: boolean; sample?: string } {
  if (typeof content === "string") {
    return m.test(content)
      ? { content: FORGOTTEN, changed: true, sample: content }
      : { content, changed: false };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  let sample: string | undefined;
  const out: unknown[] = [];
  for (const raw of content as Block[]) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const b: Block = { ...raw };
    if (b.type === "thinking" && typeof b.thinking === "string" && m.test(b.thinking)) {
      // A thinking block carries a provider signature over its text; an
      // edited one would be rejected on replay, so it is dropped instead.
      sample ??= b.thinking;
      changed = true;
      continue;
    }
    if (typeof b.text === "string" && m.test(b.text)) {
      sample ??= b.text;
      b.text = FORGOTTEN;
      changed = true;
    }
    if ((b.type === "tool_use" || b.type === "server_tool_use") && b.input !== undefined) {
      // Values only: the input's keys are the tool's schema.
      const r = redactStrings(b.input, m);
      if (r.changed) {
        sample ??= r.sample;
        b.input = r.value;
        changed = true;
      }
    }
    if (b.type === "tool_result" && b.content !== undefined) {
      const r = redactContent(b.content, m);
      if (r.changed) {
        sample ??= r.sample;
        b.content = r.content;
        changed = true;
      }
    }
    out.push(b);
  }
  if (out.length === 0) out.push({ type: "text", text: FORGOTTEN });
  return { content: out, changed, sample };
}

/** Redact the matching lines of a multi-line content field. */
function redactField(
  entry: Record<string, unknown>,
  key: string,
  m: Matcher,
): { line: string; hit: boolean; sample?: string } | null {
  const v = entry[key];
  if (typeof v !== "string" || !m.test(v)) return null;
  return { line: JSON.stringify({ ...entry, [key]: redactLines(v, m) }), hit: true, sample: v };
}

function redactSessionLine(
  line: string,
  m: Matcher,
): { line: string; hit: boolean; sample?: string } {
  const none = { line, hit: false };
  if (!m.test(line)) return none;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // A torn fragment (a crash mid-append) the reader already skips: when it
    // names the topic, replace it with a record every reader ignores.
    return { line: JSON.stringify({ type: "forgotten" }), hit: true, sample: line };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return none;
  const e = entry as Record<string, unknown>;
  if (e.type === "message" && e.message && typeof e.message === "object") {
    const msg = e.message as Record<string, unknown>;
    const r = redactContent(msg.content, m);
    if (!r.changed) return none;
    return {
      line: JSON.stringify({ ...e, message: { ...msg, content: r.content } }),
      hit: true,
      sample: r.sample,
    };
  }
  if (e.type === "prompt") return redactField(e, "text", m) ?? none;
  if (e.type === "reflection") return redactField(e, "summary", m) ?? none;
  // The header ("session") and every other entry type carry no user content.
  return none;
}

type LineRedactor = (line: string, m: Matcher) => { line: string; hit: boolean; sample?: string };

/**
 * Plan (and with `ctx.apply`, perform) the redaction of one append-only JSONL
 * file — a transcript or a task run log — one item per affected line.
 * Re-checks the file's size right before the rename so a record appended
 * meanwhile isn't lost (retried; reported if it persists).
 */
async function forgetInJsonl(
  file: string,
  layer: "sessions" | "tasks",
  redactLine: LineRedactor,
  ctx: Ctx,
): Promise<void> {
  const location = rel(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.stat(file);
    const raw = await fs.readFile(file, "utf8");
    if (!ctx.m.test(raw)) return;
    const lines = raw.split("\n");
    const items: { item: Item; text?: string }[] = [];
    const out = lines.map((line, i) => {
      if (!line) return line;
      const r = redactLine(line, ctx.m);
      if (!r.hit) return line;
      const id = itemId(layer, "redact", location, String(i + 1), sha(line));
      if (!allowed(ctx, id)) return line;
      items.push({
        item: { id, layer, location: `${location}:${i + 1}`, matches: 1, action: "redact" },
        text: r.sample,
      });
      return r.line;
    });
    if (ctx.apply && items.length > 0) {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.forget.tmp`;
      await fs.writeFile(tmp, out.join("\n"), { mode: 0o600 });
      const now = await fs.stat(file);
      if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
        await fs.rm(tmp, { force: true });
        continue; // appended meanwhile — redo from the new contents
      }
      await fs.rename(tmp, file);
    }
    for (const { item, text } of items) addItem(ctx, item, text, 1);
    return;
  }
  throw new Error("file kept changing during forget");
}

// ── tasks ────────────────────────────────────────────────────────────────
//
// Like transcripts, only content fields change. A task spec keeps its id,
// kind, state, schedule, watcher URL / selector / regex, envelope, budget and
// timestamps; its title, instruction, last summary, queued input and the
// watcher's match text are what forget redacts.

const TASK_SPEC_TEXT: readonly string[][] = [
  ["title"],
  ["instruction"],
  ["lastSummary"],
  ["queued", "input"],
  ["trigger", "contains"],
  ["trigger", "keywords"],
  ["trigger", "from"],
  ["trigger", "subject"],
];
const TASK_RUN_TEXT: readonly string[][] = [
  ["input"],
  ["summary"],
  ["error"],
  ["lastError"],
  ["artifacts", "*", "title"],
  ["artifacts", "*", "value"],
  ["effects", "*", "r"],
  ["executedDigests", "*"],
];
const TASK_NOTICE_TEXT: readonly string[][] = [
  ["notice", "title"],
  ["notice", "summary"],
  ["notice", "artifacts", "*", "title"],
  ["notice", "artifacts", "*", "value"],
];

/**
 * Replace matching strings at `paths` ("*" = every element / value) in a
 * copy of `value`; a string array at a path is redacted element-wise.
 */
function redactAt(
  value: unknown,
  paths: readonly string[][],
  m: Matcher,
): { value: unknown; matched: string[] } {
  const root = structuredClone(value);
  const matched: string[] = [];
  const visit = (node: unknown, p: readonly string[]): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const [head, ...rest] = p;
    for (const k of head === "*" ? Object.keys(obj) : [head!]) {
      const child = obj[k];
      if (rest.length > 0) {
        visit(child, rest);
      } else if (typeof child === "string" && m.test(child)) {
        matched.push(child);
        obj[k] = FORGOTTEN;
      } else if (Array.isArray(child)) {
        child.forEach((c, i) => {
          if (typeof c === "string" && m.test(c)) {
            matched.push(c);
            child[i] = FORGOTTEN;
          }
        });
      }
    }
  };
  for (const p of paths) visit(root, p);
  return { value: root, matched };
}

/** One record of a task run log: { t: "run" | "msg" | "event" | "reset", … }. */
function redactRunLine(line: string, m: Matcher): { line: string; hit: boolean; sample?: string } {
  const none = { line, hit: false };
  if (!m.test(line)) return none;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { line: JSON.stringify({ t: "forgotten" }), hit: true, sample: line };
  }
  if (!rec || typeof rec !== "object") return none;
  if (rec.t === "msg" && rec.message && typeof rec.message === "object") {
    const msg = rec.message as Record<string, unknown>;
    const r = redactContent(msg.content, m);
    if (!r.changed) return none;
    return {
      line: JSON.stringify({ ...rec, message: { ...msg, content: r.content } }),
      hit: true,
      sample: r.sample,
    };
  }
  const key = rec.t === "run" ? "run" : rec.t === "event" ? "event" : null;
  if (!key) return none;
  const r = redactAt(rec[key], key === "run" ? TASK_RUN_TEXT : [["summary"]], m);
  if (r.matched.length === 0) return none;
  return { line: JSON.stringify({ ...rec, [key]: r.value }), hit: true, sample: r.matched[0] };
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * A JSON document (task spec / outbox entry): one item per file, keyed on the
 * matched text, so unrelated updates (state, timestamps) between preview and
 * apply don't change the id. Apply re-reads under the owner's lock.
 */
async function forgetInTaskJson(
  file: string,
  paths: readonly string[][],
  rewrite: (fn: (value: unknown) => unknown) => Promise<boolean>,
  ctx: Ctx,
): Promise<void> {
  const location = rel(file);
  let value: unknown;
  try {
    const raw = await fs.readFile(file, "utf8");
    if (!ctx.m.test(raw)) return;
    value = JSON.parse(raw);
  } catch {
    ctx.report.errors.push({ layer: "tasks", error: `task_unreadable:${path.basename(file)}` });
    return;
  }
  const idOf = (matched: string[]) =>
    itemId("tasks", "redact", location, sha(JSON.stringify(matched)));
  let r = redactAt(value, paths, ctx.m);
  if (r.matched.length === 0 || !allowed(ctx, idOf(r.matched))) return;
  if (ctx.apply) {
    const done: { r: typeof r | null } = { r: null };
    await rewrite((fresh) => {
      const fr = redactAt(fresh, paths, ctx.m);
      if (fr.matched.length === 0 || !allowed(ctx, idOf(fr.matched))) return null;
      done.r = fr;
      return fr.value;
    });
    if (!done.r) return;
    r = done.r;
  }
  addItem(
    ctx,
    { id: idOf(r.matched), layer: "tasks", location, matches: r.matched.length, action: "redact" },
    r.matched[0],
    1,
  );
}

/**
 * A file the task store would never write (its name is not a valid id) has
 * no lock to take; rewrite it atomically as it is.
 */
function unlockedRewrite(file: string): (fn: (value: unknown) => unknown) => Promise<boolean> {
  return async (fn) => {
    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      return false;
    }
    const next = fn(value);
    if (next === null) return false;
    await atomicWrite(file, JSON.stringify(next, null, 2));
    return true;
  };
}

async function forgetInTasks(ctx: Ctx): Promise<void> {
  const dir = tasksDir();
  for (const file of await listFiles(dir, ".json")) {
    const id = path.basename(file, ".json");
    const rewrite = isSafeId(id)
      ? (fn: (value: unknown) => unknown) => rewriteTaskJson(id, fn)
      : unlockedRewrite(file);
    await forgetInTaskJson(file, TASK_SPEC_TEXT, rewrite, ctx);
  }
  for (const taskDir of await listDirs(path.join(dir, "runs"))) {
    for (const file of await listFiles(taskDir, ".jsonl")) {
      try {
        await forgetInJsonl(file, "tasks", redactRunLine, ctx);
      } catch {
        ctx.report.errors.push({ layer: "tasks", error: `run_busy:${path.basename(file)}` });
      }
    }
  }
  for (const file of await listFiles(path.join(dir, "outbox"), ".json")) {
    const id = path.basename(file, ".json");
    const rewrite = /^[a-z0-9][a-z0-9_-]{5,120}$/.test(id)
      ? (fn: (value: unknown) => unknown) =>
          rewriteOutboxEntry(id, (entry) => (fn(entry) as OutboxEntry | null) ?? null)
      : unlockedRewrite(file);
    await forgetInTaskJson(file, TASK_NOTICE_TEXT, rewrite, ctx);
  }
}

// ── soul (journal / relationships / untouched) ───────────────────────────

/** One item per matching line of a soul file; matches on allowed lines are replaced. */
function planSoulFile(
  text: string,
  location: string,
  layer: "journal" | "relationships",
  ctx: Ctx,
): { next: string; items: { item: Item; text: string }[] } {
  const items: { item: Item; text: string }[] = [];
  const next = text
    .split("\n")
    .map((line, i) => {
      const n = ctx.m.count(line);
      if (n === 0) return line;
      const id = itemId(layer, "redact", location, String(i + 1), sha(line));
      if (!allowed(ctx, id)) return line;
      items.push({
        item: { id, layer, location: `${location}:${i + 1}`, matches: n, action: "redact" },
        text: line,
      });
      return ctx.m.redact(line);
    })
    .join("\n");
  return { next, items };
}

/**
 * Lisa's relationships and journal: literal replacements on the matching
 * lines only. Apply re-reads and writes under the soul lock, so the lines it
 * changes are the lines it checked; each changed file is a soul-git commit.
 */
async function forgetInSoulDir(
  dir: string,
  layer: "journal" | "relationships",
  ctx: Ctx,
): Promise<void> {
  for (const file of await listFiles(dir, ".md")) {
    const location = rel(file);
    const text = await fs.readFile(file, "utf8");
    if (!ctx.m.test(text)) continue;
    let items: { item: Item; text: string }[] = [];
    if (!ctx.apply) {
      items = planSoulFile(text, location, layer, ctx).items;
    } else {
      await withSoulCaller("user_forget", () =>
        withSoulLock(async () => {
          const plan = planSoulFile(await fs.readFile(file, "utf8"), location, layer, ctx);
          items = plan.items;
          if (items.length === 0) return;
          await atomicWrite(file, plan.next);
          const soulRel = path.relative(soulDir(), file).split(path.sep).join("/");
          await commitSoulChange(soulRel, "user-forget");
        }),
      );
    }
    for (const { item, text: t } of items) addItem(ctx, item, t, item.matches);
  }
}

async function scanUntouched(ctx: Ctx): Promise<void> {
  const dir = soulDir();
  const candidates = [
    ...["name.md", "identity.md", "purpose.md", "constitution.md"].map((f) => path.join(dir, f)),
    ...(await listFiles(path.join(dir, "values"), ".md")),
    ...(await listFiles(path.join(dir, "opinions"), ".md")),
    ...(await listFiles(path.join(dir, "desires"), ".md")),
  ];
  for (const file of candidates) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const n = ctx.m.count(text);
    if (n > 0) {
      const location = rel(file);
      ctx.report.untouched.push({
        id: itemId("soul", "none", location),
        layer: "soul",
        location,
        matches: n,
        action: "none",
      });
    }
  }
}

// ── kb + links ───────────────────────────────────────────────────────────

function kbFile(e: KbEntry): string {
  return `kb/${e.layer}/${e.slug}.md`;
}

/** What content a KB item was planned on (title, tags, provenance, body). */
function kbFingerprint(e: KbEntry): string {
  return sha(JSON.stringify([e.title, e.tags, e.extra ?? {}, e.body]));
}

/** A page goes entirely only when its title or a tag names the topic. */
function deleteReason(e: KbEntry, m: Matcher): "title" | "tag" | null {
  if (m.test(e.title)) return "title";
  if (e.tags.some((t) => m.test(t))) return "tag";
  return null;
}

function linkPattern(slugs: Set<string>): RegExp | null {
  if (slugs.size === 0) return null;
  const alt = [...slugs].map(escapeRe).join("|");
  return new RegExp(`\\[\\[\\s*(?:kb:)?(?:${alt})\\s*(?:\\|[^\\]\\n]{0,200})?\\]\\]`, "g");
}

function countLinks(text: string, re: RegExp | null): number {
  return re ? [...text.matchAll(new RegExp(re.source, "g"))].length : 0;
}

function stripLinks(text: string, re: RegExp | null, replacement: string): string {
  return re ? text.replace(new RegExp(re.source, "g"), replacement) : text;
}

interface KbPlan {
  redactId: string | null;
  unlinkId: string | null;
  matches: number;
  links: number;
  sample?: string;
}

/** Matching body lines and provenance values, and links to deleted pages. */
function planKbEntry(e: KbEntry, ctx: Ctx, links: RegExp | null): KbPlan {
  const location = kbFile(e);
  const fp = kbFingerprint(e);
  const lines = e.body.split("\n").filter((l) => ctx.m.test(l));
  const extras = Object.values(e.extra ?? {}).filter((v) => ctx.m.test(v));
  const nLinks = countLinks(e.body, links);
  const redact = lines.length + extras.length > 0;
  const redactId = redact ? itemId("kb", "redact", location, fp) : null;
  const unlinkId = nLinks > 0 ? itemId("memory_kb_links", "unlink", location, fp) : null;
  return {
    redactId: redactId && allowed(ctx, redactId) ? redactId : null,
    unlinkId: unlinkId && allowed(ctx, unlinkId) ? unlinkId : null,
    matches: lines.length + extras.length,
    links: nLinks,
    sample: lines[0] ?? extras[0],
  };
}

function redactExtra(
  extra: Record<string, string> | undefined,
  m: Matcher,
): Record<string, string> | undefined {
  if (!extra) return extra;
  return Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, m.test(v) ? FORGOTTEN : v]));
}

async function forgetInKb(ctx: Ctx): Promise<RegExp | null> {
  let kbEntries: KbEntry[] = [];
  try {
    kbEntries = await listFullEntries();
  } catch {
    ctx.report.errors.push({ layer: "kb", error: "kb_unreadable" });
  }
  const deleteIdOf = (e: KbEntry) => itemId("kb", "delete", kbFile(e), kbFingerprint(e));
  const deletes = (e: KbEntry) => deleteReason(e, ctx.m) !== null && allowed(ctx, deleteIdOf(e));

  // Which pages go entirely decides which links dangle.
  const deleting = kbEntries.filter(deletes);
  const links = linkPattern(new Set(deleting.map((e) => e.slug)));

  for (const e of deleting) {
    if (ctx.apply) {
      const r = await forgetInEntry(e.layer, e.slug, (fresh) => (deletes(fresh) ? "delete" : null));
      if (r !== "deleted") continue;
    }
    const why = deleteReason(e, ctx.m)!;
    addItem(
      ctx,
      { id: deleteIdOf(e), layer: "kb", location: kbFile(e), matches: 1, action: "delete", why },
      why === "title" ? e.title : e.tags.find((t) => ctx.m.test(t)),
      1,
    );
  }

  for (const e of kbEntries) {
    if (deleting.includes(e)) continue;
    if (deleteReason(e, ctx.m) === null && ctx.m.test(e.slug)) {
      ctx.report.untouched.push({
        id: itemId("kb", "none", kbFile(e)),
        layer: "kb",
        location: kbFile(e),
        matches: 1,
        action: "none",
        why: "file name",
      });
    }
    let plan = planKbEntry(e, ctx, links);
    if (!plan.redactId && !plan.unlinkId) continue;
    if (ctx.apply) {
      // Re-planned on the page as it is under the KB lock.
      const done: { plan: KbPlan | null } = { plan: null };
      await forgetInEntry(e.layer, e.slug, (fresh) => {
        const p = planKbEntry(fresh, ctx, links);
        if (!p.redactId && !p.unlinkId) return null;
        done.plan = p;
        let body = fresh.body;
        if (p.redactId) body = redactLines(body, ctx.m);
        if (p.unlinkId) body = stripLinks(body, links, FORGOTTEN);
        return { body, extra: p.redactId ? redactExtra(fresh.extra, ctx.m) : fresh.extra };
      });
      if (!done.plan) continue;
      plan = done.plan;
    }
    const location = kbFile(e);
    if (plan.redactId) {
      addItem(
        ctx,
        { id: plan.redactId, layer: "kb", location, matches: plan.matches, action: "redact" },
        plan.sample,
        1,
      );
    }
    if (plan.unlinkId) {
      addItem(
        ctx,
        {
          id: plan.unlinkId,
          layer: "memory_kb_links",
          location,
          matches: plan.links,
          action: "unlink",
        },
        undefined,
        plan.links,
      );
    }
  }
  return links;
}

// ── memory ───────────────────────────────────────────────────────────────

async function forgetInMemory(ctx: Ctx, links: RegExp | null): Promise<void> {
  for (const store of MEMORY_STORES) {
    const file = `memory/${store === "memory" ? "MEMORY" : "USER"}.md`;
    const items: { item: Item; text?: string }[] = [];
    /** Decide one entry (records its item); the same rule for preview and apply. */
    const decide = (entry: MemoryEntry): "delete" | "unlink" | null => {
      const location = `${file}#${entry.id}`;
      if (ctx.m.test(entry.text)) {
        const id = itemId(store, "delete", entry.id);
        if (!allowed(ctx, id)) return null;
        items.push({
          item: { id, layer: store, location, matches: 1, action: "delete" },
          text: entry.text,
        });
        return "delete";
      }
      const n = countLinks(entry.text, links);
      const id = itemId("memory_kb_links", "unlink", entry.id);
      if (n === 0 || !allowed(ctx, id)) return null;
      items.push({
        item: { id, layer: "memory_kb_links", location, matches: n, action: "unlink" },
      });
      return "unlink";
    };
    try {
      if (!ctx.apply) {
        const parsed = await readMemoryStore(store);
        // Apply refuses to rewrite a store that is not clean text; say so now.
        if (parsed.corrupt)
          throw new MemoryEditError("memory_corrupt", `${file} is not clean text`);
        for (const entry of parsed.entries) decide(entry);
      } else if (isMemoryStore(store)) {
        // Decided under the memory lock, on the entries as they are now.
        await rewriteMemoryEntries(store, (entry) => {
          const what = decide(entry);
          if (what === "delete") return null;
          if (what !== "unlink") return entry.text;
          const stripped = stripLinks(entry.text, links, "")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
          return /[\p{L}\p{N}]/u.test(stripped) ? stripped : null;
        });
      }
      for (const { item, text } of items) addItem(ctx, item, text, item.matches);
    } catch (e) {
      ctx.report.errors.push({
        layer: store,
        error: e instanceof MemoryEditError ? e.code : "memory_unreadable",
      });
    }
  }
}

// ── reflections + search index ───────────────────────────────────────────

async function forgetInReflections(ctx: Ctx): Promise<void> {
  for (const file of await listFiles(reflectionsDir(), ".json")) {
    const location = rel(file);
    let raw: string;
    let parsed: unknown;
    try {
      raw = await fs.readFile(file, "utf8");
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const r = redactStrings(parsed, ctx.m, REFLECTION_STRUCTURAL);
    if (r.changed === 0) continue;
    const id = itemId("reflections", "redact", location, sha(raw));
    if (!allowed(ctx, id)) continue;
    if (ctx.apply) {
      // Written once per reflection; re-read so a rewrite meanwhile is not lost.
      if ((await fs.readFile(file, "utf8").catch(() => null)) !== raw) continue;
      await atomicWrite(file, JSON.stringify(r.value, null, 2));
    }
    addItem(
      ctx,
      { id, layer: "reflections", location, matches: r.changed, action: "redact" },
      r.sample,
      r.changed,
    );
  }
}

/**
 * The persisted embedding cache holds vectors of the old text; the in-memory
 * session/KB indexes are dropped and rebuild lazily. Always evicted on apply.
 */
async function evictSearchIndex(ctx: Ctx): Promise<void> {
  const embedDir = path.join(lisaHome(), "embeddings");
  const embedFiles = await listFiles(embedDir, ".json");
  const c = ctx.report.counts;
  const touched = c.sessions + c.kb + c.memory_kb_links + c.reflections;
  if (touched > 0 || embedFiles.length > 0) {
    c.search_index = embedFiles.length + 1;
    for (const location of ["(in-memory indexes)", ...embedFiles.map(rel)]) {
      ctx.report.locations.push({
        id: itemId("search_index", "evict", location),
        layer: "search_index",
        location,
        matches: 1,
        action: "evict",
      });
    }
  }
  if (ctx.apply) {
    await fs.rm(embedDir, { recursive: true, force: true });
    const [{ clearIndexCache }, { clearKbIndexCache }, { clearKbTitleCache }] = await Promise.all([
      import("../memory/vector.js"),
      import("../kb/search.js"),
      import("../kb/memory-links.js"),
    ]);
    clearIndexCache();
    clearKbIndexCache();
    clearKbTitleCache();
  }
}

// ── main ─────────────────────────────────────────────────────────────────

function forgetNoticeFile(): string {
  return path.join(sovereigntyDir(), "forget-notice.json");
}

export interface ForgetNotice {
  at: string;
  journal: number;
  relationships: number;
  memory: number;
}

/** The latest forget notice for Lisa's prompt, if recent (≤ 7 days). */
export async function readForgetNotice(now: number = Date.now()): Promise<ForgetNotice | null> {
  try {
    const n = JSON.parse(await fs.readFile(forgetNoticeFile(), "utf8")) as ForgetNotice;
    const at = Date.parse(n.at);
    if (!Number.isFinite(at) || now - at > 7 * 86_400_000) return null;
    return n;
  } catch {
    return null;
  }
}

export function forgetNoticeFilePath(): string {
  return forgetNoticeFile();
}

async function run(
  m: Matcher,
  opts: { apply: boolean; snippets: boolean; allowed: Set<string> | null },
): Promise<ForgetReport> {
  const ctx: Ctx = {
    m,
    ...opts,
    report: {
      dryRun: !opts.apply,
      match: matchInfo(m),
      digest: "",
      counts: zeroCounts(),
      locations: [],
      untouched: [],
      errors: [],
      residuals: [...FORGET_RESIDUALS],
      scanned: scannedAreas(),
      notScanned: [
        ...(await notScannedIn(lisaHome())),
        ...(lisaHome() !== lisaGlobalHome() ? OUTSIDE_ACCOUNT_HOME_STORES : []),
      ],
    },
  };
  for (const n of ctx.report.notScanned) ctx.report.residuals.push(`Not scanned: ${n}`);
  // (b) KB first: which pages go entirely decides which links dangle.
  const links = await forgetInKb(ctx);
  // (a) memory + user entries, and their pointers to deleted pages.
  await forgetInMemory(ctx, links);
  // (c) session transcripts and reflection records.
  for (const file of await listFiles(sessionsDir(), ".jsonl")) {
    try {
      await forgetInJsonl(file, "sessions", redactSessionLine, ctx);
    } catch {
      ctx.report.errors.push({ layer: "sessions", error: `session_busy:${path.basename(file)}` });
    }
  }
  await forgetInReflections(ctx);
  // (c') tasks: specs, run transcripts, pending notices.
  await forgetInTasks(ctx);
  // (d) search indexes.
  await evictSearchIndex(ctx);
  // (e) relationships, (f) journal — Lisa's soul: literal matches only.
  await forgetInSoulDir(soulRelationshipsDir(), "relationships", ctx);
  await forgetInSoulDir(soulJournalDir(), "journal", ctx);
  await scanUntouched(ctx);
  ctx.report.digest = digestOf(ctx.report.locations);
  return ctx.report;
}

function nonZero(counts: Record<ForgetLayer, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

/**
 * Forget `query` across every layer of the ACTIVE home (tenant-scoped under
 * the cloud request scope). A dry run previews, with snippets, and writes
 * nothing; apply with the preview's `digest` changes exactly what it listed.
 */
export async function forget(query: string, opts: ForgetOptions = {}): Promise<ForgetReport> {
  const q = normalizeForgetQuery(query);
  const m = forgetMatcher(q);
  if (opts.dryRun) {
    const preview = await run(m, { apply: false, snippets: true, allowed: null });
    await appendSovereigntyAudit({
      action: "forget.dry_run",
      counts: nonZero(preview.counts),
      ...(preview.errors.length ? { note: `${preview.errors.length} layer error(s)` } : {}),
    });
    return preview;
  }
  const plan = await run(m, { apply: false, snippets: false, allowed: null });
  if (opts.digest !== undefined && opts.digest !== plan.digest) {
    throw new ForgetError(
      "preview_changed",
      "what matches has changed since the preview, so nothing was forgotten; preview again",
    );
  }
  const report = await run(m, {
    apply: true,
    snippets: false,
    allowed: new Set(plan.locations.map((l) => l.id)),
  });
  report.digest = plan.digest;
  const counts = nonZero(report.counts);
  const after = await run(m, { apply: false, snippets: false, allowed: null });
  report.remaining = after.counts;
  // search_index "remaining" is the cache we just rebuilt from clean data.
  report.remaining.search_index = 0;
  const changed = Object.values(counts).reduce((a, b) => a + b, 0);
  if (changed > 0) {
    const notice: ForgetNotice = {
      at: new Date().toISOString(),
      journal: report.counts.journal,
      relationships: report.counts.relationships,
      memory: report.counts.memory + report.counts.user,
    };
    await atomicWrite(forgetNoticeFile(), JSON.stringify(notice) + "\n");
  }
  await appendSovereigntyAudit({
    action: "forget.apply",
    counts,
    ...(report.errors.length ? { note: `${report.errors.length} layer error(s)` } : {}),
  });
  return report;
}

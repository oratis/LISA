/**
 * Cross-layer "forget" (memory sovereignty, W8): the person names a topic and
 * every layer of the ACTIVE home that holds it is cleaned, or — with
 * `dryRun` — merely counted. The report carries counts and locations, never
 * content; the audit line carries counts only (not even the query).
 *
 * Matching is literal and case-insensitive (whitespace-tolerant), with a
 * minimum query length so a stray "a" can't wipe a home. What each layer does:
 *
 *  memory / user        drop every MEMORY.md / USER.md entry that mentions it
 *  kb                   delete pages whose title/slug/tags/provenance name it;
 *                       replace matching body lines elsewhere
 *  memory_kb_links      strip `[[kb:slug]]` / `[[slug]]` pointers (in memory
 *                       and in other pages) to the pages deleted above
 *  sessions             replace matching message text with "[forgotten by
 *                       user]" (structure kept), redact matching lines in
 *                       recorded prompts / reflection summaries
 *  reflections          per-session reflection records: matching strings
 *  search_index         drop the in-memory session + KB indexes and the
 *                       persisted embedding cache (vectors of the old text)
 *  relationships        literal matches only, soul-git commit `user-forget`
 *  journal              Lisa's private journal is HERS: only literal matches
 *                       of the user's words are replaced, each file change is
 *                       a soul-git commit labelled `user-forget`, and Lisa is
 *                       told (a prompt Notice) that the person used forget.
 *
 * Lisa's own self (identity, values, opinions, desires) is never edited; any
 * mentions there are reported as `untouched`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { lisaHome, reflectionsDir, sessionsDir } from "../paths.js";
import {
  isMemoryStore,
  MEMORY_STORES,
  MemoryEditError,
  readMemoryStore,
  rewriteMemoryEntries,
} from "../memory/entries.js";
import type { MemoryStore } from "../memory/store.js";
import { listFullEntries, redactEntryBody, removeEntry, type KbEntry } from "../kb/store.js";
import { commitSoulChange, withSoulCaller } from "../soul/git.js";
import { withSoulLock } from "../soul/lock.js";
import { soulDir, soulJournalDir, soulRelationshipsDir } from "../soul/paths.js";
import { appendSovereigntyAudit, sovereigntyDir } from "./audit.js";

export const FORGOTTEN = "[forgotten by user]";
export const FORGET_MIN_CHARS = 3;
export const FORGET_MAX_CHARS = 200;

export type ForgetLayer =
  | "memory"
  | "user"
  | "kb"
  | "memory_kb_links"
  | "sessions"
  | "reflections"
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
  "search_index",
  "relationships",
  "journal",
];

export type ForgetAction = "delete" | "redact" | "evict" | "unlink" | "none";

export interface ForgetLocation {
  layer: ForgetLayer | "soul";
  /** Home-relative path, with `#<entry id>` for a memory entry. Never content. */
  location: string;
  matches: number;
  action: ForgetAction;
}

export interface ForgetReport {
  dryRun: boolean;
  counts: Record<ForgetLayer, number>;
  locations: ForgetLocation[];
  /** Mentions in Lisa's own soul files — reported, never edited. */
  untouched: ForgetLocation[];
  /** Layers that could not be processed (code only, no content). */
  errors: { layer: ForgetLayer; error: string }[];
  /** Things that cannot be erased from here, stated honestly. */
  residuals: string[];
  /** Apply only: a re-scan after the writes; every count should be 0. */
  remaining?: Record<ForgetLayer, number>;
}

export interface ForgetOptions {
  dryRun?: boolean;
}

export class ForgetError extends Error {
  constructor(
    readonly code: "invalid_query",
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
];

// ── matching ─────────────────────────────────────────────────────────────

export interface Matcher {
  test(s: string): boolean;
  count(s: string): number;
  /** Replace each literal match with FORGOTTEN. */
  redact(s: string): string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeForgetQuery(raw: unknown): string {
  if (typeof raw !== "string") throw new ForgetError("invalid_query", "query must be a string");
  const q = raw.replace(/\s+/g, " ").trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(q)) {
    throw new ForgetError("invalid_query", "query contains control characters");
  }
  const len = [...q].length;
  if (len < FORGET_MIN_CHARS) {
    throw new ForgetError("invalid_query", `query must be at least ${FORGET_MIN_CHARS} characters`);
  }
  if (len > FORGET_MAX_CHARS) {
    throw new ForgetError("invalid_query", `query must be at most ${FORGET_MAX_CHARS} characters`);
  }
  return q;
}

export function forgetMatcher(query: string): Matcher {
  const source = query.split(" ").map(escapeRe).join("\\s+");
  const re = () => new RegExp(source, "giu");
  return {
    test: (s) => re().test(s),
    count: (s) => [...s.matchAll(re())].length,
    redact: (s) => s.replace(re(), FORGOTTEN),
  };
}

function redactLines(text: string, m: Matcher): string {
  return text
    .split("\n")
    .map((l) => (m.test(l) ? FORGOTTEN : l))
    .join("\n");
}

/** Replace every matching string value in a JSON-ish value (structure kept). */
function redactStrings(value: unknown, m: Matcher): { value: unknown; changed: number } {
  if (typeof value === "string") {
    return m.test(value) ? { value: FORGOTTEN, changed: 1 } : { value, changed: 0 };
  }
  if (Array.isArray(value)) {
    let changed = 0;
    const out = value.map((v) => {
      const r = redactStrings(v, m);
      changed += r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactStrings(v, m);
      changed += r.changed;
      out[k] = r.value;
    }
    return { value: out, changed };
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

// ── sessions ─────────────────────────────────────────────────────────────

interface Block {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  input?: unknown;
  content?: unknown;
}

/** Redact one message's content. Returns the new content and whether it changed. */
function redactContent(content: unknown, m: Matcher): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    return m.test(content) ? { content: FORGOTTEN, changed: true } : { content, changed: false };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const out: unknown[] = [];
  for (const raw of content as Block[]) {
    if (!raw || typeof raw !== "object") {
      out.push(raw);
      continue;
    }
    const b: Block = { ...raw };
    if (typeof b.text === "string" && m.test(b.text)) {
      b.text = FORGOTTEN;
      changed = true;
    }
    if (b.type === "thinking" && typeof b.thinking === "string" && m.test(b.thinking)) {
      // A thinking block carries a provider signature over its text; an
      // edited one would be rejected on replay, so it is dropped instead.
      changed = true;
      continue;
    }
    if (b.input !== undefined) {
      const r = redactStrings(b.input, m);
      if (r.changed) {
        b.input = r.value;
        changed = true;
      }
    }
    if (b.type === "tool_result" && b.content !== undefined) {
      const r = redactContent(b.content, m);
      if (r.changed) {
        b.content = r.content;
        changed = true;
      }
    }
    out.push(b);
  }
  if (out.length === 0) out.push({ type: "text", text: FORGOTTEN });
  return { content: out, changed };
}

function redactSessionLine(line: string, m: Matcher, isHeader: boolean): { line: string; hit: boolean } {
  if (!m.test(line)) return { line, hit: false };
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    // A torn line that still names the topic: keep the line count, drop it.
    return { line: JSON.stringify({ type: "forgotten" }), hit: true };
  }
  if (isHeader || !entry || typeof entry !== "object") {
    const r = redactStrings(entry, m);
    return { line: JSON.stringify(r.value), hit: r.changed > 0 };
  }
  if (entry.type === "message" && entry.message && typeof entry.message === "object") {
    const msg = { ...(entry.message as Record<string, unknown>) };
    const r = redactContent(msg.content, m);
    msg.content = r.content;
    const rest = redactStrings({ ...entry, message: undefined }, m);
    const out = { ...(rest.value as Record<string, unknown>), message: msg };
    return { line: JSON.stringify(out), hit: r.changed || rest.changed > 0 };
  }
  if (entry.type === "prompt" && typeof entry.text === "string") {
    return { line: JSON.stringify({ ...entry, text: redactLines(entry.text, m) }), hit: true };
  }
  if (entry.type === "reflection" && typeof entry.summary === "string") {
    return { line: JSON.stringify({ ...entry, summary: redactLines(entry.summary, m) }), hit: true };
  }
  const r = redactStrings(entry, m);
  return { line: JSON.stringify(r.value), hit: r.changed > 0 };
}

/**
 * Rewrite one transcript. Re-checks the file's size right before the rename
 * so a turn appended meanwhile isn't lost (retried; reported if it persists).
 */
async function forgetInSession(file: string, m: Matcher, apply: boolean): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await fs.stat(file);
    const raw = await fs.readFile(file, "utf8");
    if (!m.test(raw)) return 0;
    const lines = raw.split("\n");
    let hits = 0;
    const out = lines.map((line, i) => {
      if (!line) return line;
      const r = redactSessionLine(line, m, i === 0);
      if (r.hit) hits++;
      return r.line;
    });
    if (!apply || hits === 0) return hits;
    const tmp = `${file}.${process.pid}.forget.tmp`;
    await fs.writeFile(tmp, out.join("\n"), { mode: 0o600 });
    const now = await fs.stat(file);
    if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
      await fs.rm(tmp, { force: true });
      continue; // appended meanwhile — redo from the new contents
    }
    await fs.rename(tmp, file);
    return hits;
  }
  throw new Error("session kept changing during forget");
}

// ── soul (journal / relationships / untouched) ───────────────────────────

async function forgetInSoulDir(
  dir: string,
  layer: "journal" | "relationships",
  m: Matcher,
  apply: boolean,
  report: ForgetReport,
): Promise<void> {
  for (const file of await listFiles(dir, ".md")) {
    const text = await fs.readFile(file, "utf8");
    const n = m.count(text);
    if (n === 0) continue;
    report.counts[layer] += n;
    report.locations.push({ layer, location: rel(file), matches: n, action: "redact" });
    if (!apply) continue;
    await withSoulCaller("user_forget", () =>
      withSoulLock(async () => {
        const fresh = await fs.readFile(file, "utf8");
        await atomicWrite(file, m.redact(fresh));
        const soulRel = path.relative(soulDir(), file).split(path.sep).join("/");
        await commitSoulChange(soulRel, "user-forget");
      }),
    );
  }
}

async function scanUntouched(m: Matcher, report: ForgetReport): Promise<void> {
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
    const n = m.count(text);
    if (n > 0) report.untouched.push({ layer: "soul", location: rel(file), matches: n, action: "none" });
  }
}

// ── kb + links ───────────────────────────────────────────────────────────

function kbFile(e: KbEntry): string {
  return `kb/${e.layer}/${e.slug}.md`;
}

function metaMatches(e: KbEntry, m: Matcher): boolean {
  return (
    m.test(e.title) ||
    m.test(e.slug) ||
    e.tags.some((t) => m.test(t)) ||
    Object.values(e.extra ?? {}).some((v) => m.test(v))
  );
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

async function run(m: Matcher, apply: boolean): Promise<ForgetReport> {
  const report: ForgetReport = {
    dryRun: !apply,
    counts: zeroCounts(),
    locations: [],
    untouched: [],
    errors: [],
    residuals: [...FORGET_RESIDUALS],
  };

  // (b) KB first: which pages go entirely decides which links dangle.
  let kbEntries: KbEntry[] = [];
  try {
    kbEntries = await listFullEntries();
  } catch {
    report.errors.push({ layer: "kb", error: "kb_unreadable" });
  }
  const deleted = kbEntries.filter((e) => metaMatches(e, m));
  const deletedSlugs = new Set(deleted.map((e) => e.slug));
  const links = linkPattern(deletedSlugs);
  for (const e of deleted) {
    report.counts.kb++;
    report.locations.push({ layer: "kb", location: kbFile(e), matches: 1, action: "delete" });
    if (apply) await removeEntry(e.layer, e.slug);
  }
  for (const e of kbEntries) {
    if (deleted.includes(e)) continue;
    const lines = e.body.split("\n").filter((l) => m.test(l)).length;
    const nLinks = countLinks(e.body, links);
    if (lines === 0 && nLinks === 0) continue;
    if (lines > 0) {
      report.counts.kb++;
      report.locations.push({ layer: "kb", location: kbFile(e), matches: lines, action: "redact" });
    }
    if (nLinks > 0) {
      report.counts.memory_kb_links += nLinks;
      report.locations.push({
        layer: "memory_kb_links",
        location: kbFile(e),
        matches: nLinks,
        action: "unlink",
      });
    }
    if (apply) {
      const body = stripLinks(redactLines(e.body, m), links, FORGOTTEN);
      await redactEntryBody(e.layer, e.slug, body);
    }
  }

  // (a) memory + user entries, and their pointers to deleted pages.
  for (const store of MEMORY_STORES) {
    try {
      const parsed = await readMemoryStore(store);
      const file = `memory/${store === "memory" ? "MEMORY" : "USER"}.md`;
      for (const entry of parsed.entries) {
        if (m.test(entry.text)) {
          report.counts[store]++;
          report.locations.push({
            layer: store,
            location: `${file}#${entry.id}`,
            matches: 1,
            action: "delete",
          });
        } else {
          const n = countLinks(entry.text, links);
          if (n > 0) {
            report.counts.memory_kb_links += n;
            report.locations.push({
              layer: "memory_kb_links",
              location: `${file}#${entry.id}`,
              matches: n,
              action: "unlink",
            });
          }
        }
      }
      if (apply && isMemoryStore(store)) await applyMemory(store, m, links);
    } catch (e) {
      report.errors.push({
        layer: store,
        error: e instanceof MemoryEditError ? e.code : "memory_unreadable",
      });
    }
  }

  // (c) session transcripts.
  for (const file of await listFiles(sessionsDir(), ".jsonl")) {
    try {
      const n = await forgetInSession(file, m, apply);
      if (n === 0) continue;
      report.counts.sessions += n;
      report.locations.push({ layer: "sessions", location: rel(file), matches: n, action: "redact" });
    } catch {
      report.errors.push({ layer: "sessions", error: `session_busy:${path.basename(file)}` });
    }
  }
  for (const file of await listFiles(reflectionsDir(), ".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    const r = redactStrings(parsed, m);
    if (r.changed === 0) continue;
    report.counts.reflections += r.changed;
    report.locations.push({ layer: "reflections", location: rel(file), matches: r.changed, action: "redact" });
    if (apply) await atomicWrite(file, JSON.stringify(r.value, null, 2));
  }

  // (d) search indexes: the persisted embedding cache holds vectors of the
  // old text; the in-memory session/KB indexes are dropped and rebuild lazily.
  const embedDir = path.join(lisaHome(), "embeddings");
  const embedFiles = await listFiles(embedDir, ".json");
  const touched =
    report.counts.sessions + report.counts.kb + report.counts.memory_kb_links + report.counts.reflections;
  if (touched > 0 || embedFiles.length > 0) {
    report.counts.search_index = embedFiles.length + 1;
    report.locations.push({ layer: "search_index", location: "(in-memory indexes)", matches: 1, action: "evict" });
    for (const f of embedFiles) {
      report.locations.push({ layer: "search_index", location: rel(f), matches: 1, action: "evict" });
    }
  }
  if (apply) {
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

  // (e) relationships, (f) journal — Lisa's soul: literal matches only.
  await forgetInSoulDir(soulRelationshipsDir(), "relationships", m, apply, report);
  await forgetInSoulDir(soulJournalDir(), "journal", m, apply, report);
  await scanUntouched(m, report);
  return report;
}

async function applyMemory(store: MemoryStore, m: Matcher, links: RegExp | null): Promise<void> {
  await rewriteMemoryEntries(store, (entry) => {
    if (m.test(entry.text)) return null;
    if (countLinks(entry.text, links) === 0) return entry.text;
    const stripped = stripLinks(entry.text, links, "").replace(/[ \t]{2,}/g, " ").trim();
    return /[\p{L}\p{N}]/u.test(stripped) ? stripped : null;
  });
}

/**
 * Forget `query` across every layer of the ACTIVE home (tenant-scoped under
 * the cloud request scope). Dry-run counts without writing.
 */
export async function forget(query: string, opts: ForgetOptions = {}): Promise<ForgetReport> {
  const q = normalizeForgetQuery(query);
  const m = forgetMatcher(q);
  const apply = !opts.dryRun;
  const report = await run(m, apply);
  const counts = Object.fromEntries(
    Object.entries(report.counts).filter(([, n]) => n > 0),
  ) as Record<string, number>;
  if (apply) {
    const after = await run(m, false);
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
  }
  await appendSovereigntyAudit({
    action: apply ? "forget.apply" : "forget.dry_run",
    counts,
    ...(report.errors.length ? { note: `${report.errors.length} layer error(s)` } : {}),
  });
  return report;
}

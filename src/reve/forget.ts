/**
 * Forget inside the Reve dream log (#423 review F4).
 *
 * Memory sovereignty's cross-layer `forget` (src/sovereignty/forget.ts, #421)
 * cleans `reve/` through this one function, the same way it cleans its other
 * layers:
 *
 *   const r = await forgetInReve((text) => m.test(text), { apply, only });
 *
 * `match` says whether a piece of text mentions the forgotten topic (forget's
 * whole-word matcher). What changes, in the ACTIVE home:
 *
 *  - dream records `<id>.json`: every matching line of a change's or a soul
 *    commit's diff, every matching memory entry listed as added or removed,
 *    a matching soul-commit subject and a matching summary become
 *    "[forgotten by user]". Ids, hashes, counts and timestamps stay, so the
 *    record still loads. Paths and skill / desire / task names are structure
 *    (like KB file names for forget): never renamed, reported as `untouched`.
 *  - summaries `<id>.md`: matching lines replaced.
 *  - revert sidecars `<id>.before.json`: one that holds a match anywhere is
 *    deleted whole. Every change of that dream it covered becomes not
 *    revertible, and the record says why.
 *  - reconsider notes (`reve/reconsider.json`): a matching note is replaced.
 *  - the audit log (`reve/audit.jsonl`): matching string values are replaced
 *    (a line that is not JSON is replaced whole).
 *
 * A dry run (`apply: false`) writes nothing and lists the same items, each
 * with a `sample` of the matching text for the preview. Every item carries a
 * stable id — its location plus the content it was planned on — so a caller
 * can preview, confirm, then apply exactly the confirmed set (`only`): items
 * outside it are left alone. Apply runs under the reve lock (every reve
 * writer takes it) and appends a counts-only audit line.
 *
 * The match is always decided on text (parsed JSON string values, Markdown
 * and diff lines), never on serialized JSON, where an escape such as `\n`
 * would hide a word boundary from forget's whole-word matcher.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appendLine, atomicWrite } from "../fs-utils.js";
import { lisaHome } from "../paths.js";
import {
  dreamFile,
  dreamSnapshotFile,
  dreamSummaryFile,
  reconsiderFile,
  reveAuditFile,
} from "./paths.js";
import { idsOnDisk, lockReve } from "./store.js";

/** The placeholder forget writes (the same text #421's forget uses). */
export const REVE_FORGOTTEN = "[forgotten by user]";

/** Does this text mention the forgotten topic? */
export type ReveForgetMatch = (text: string) => boolean;

export const SIDECAR_FORGOTTEN_REASON =
  "its pre-dream copy was deleted by forget, so it cannot be reverted";

export interface ReveForgetCounts {
  /** Dream records with content replaced (or deleted, when unreadable JSON). */
  records: number;
  /** Dream summaries (`<id>.md`) with lines replaced. */
  summaries: number;
  /** Revert sidecars deleted because they held a match. */
  sidecars: number;
  /** Reconsider notes replaced. */
  reconsider: number;
  /** Audit-log lines rewritten. */
  audit: number;
}

export interface ReveForgetItem {
  /** Stable: the location and the content it was planned on. */
  id: string;
  /**
   * Home-relative: `reve/dreams/<id>.json`, `reve/dreams/<id>.md`,
   * `reve/dreams/<id>.before.json`, `reve/reconsider.json#<request id>`,
   * `reve/audit.jsonl:<line>` (1-based).
   */
  location: string;
  kind: keyof ReveForgetCounts;
  /** Fields / lines replaced; 1 for a deletion. */
  matches: number;
  action: "redact" | "delete";
  /** Dry run only: the first matching text, for the preview's snippet. */
  sample?: string;
}

export interface ReveForgetResult {
  apply: boolean;
  /** Items changed (apply) or that would change (dry run), by kind. */
  counts: ReveForgetCounts;
  /** Sum of `counts`: what forget adds to its count for this layer. */
  total: number;
  items: ReveForgetItem[];
  /** Records whose paths or names match: structure, left as they are. */
  untouched: string[];
}

export interface ReveForgetOptions {
  /** false = dry run: list, write nothing. */
  apply: boolean;
  /** Apply only these item ids (from a confirmed dry run). */
  only?: ReadonlySet<string>;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

function parseObj(text: string): Obj | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function itemId(location: string, content: string): string {
  return crypto
    .createHash("sha256")
    .update(location + "\0" + content)
    .digest("hex")
    .slice(0, 16);
}

function toRel(abs: string): string {
  return path.relative(lisaHome(), abs).split(path.sep).join("/");
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A diff / summary line marker kept in front of the placeholder. */
const MARKER_RE = /^(?:[+-] |[+\- ])/;

function lineHit(line: string, match: ReveForgetMatch): boolean {
  const body = line.replace(MARKER_RE, "");
  return body !== REVE_FORGOTTEN && line !== REVE_FORGOTTEN && match(line);
}

function valueHit(v: unknown, match: ReveForgetMatch): v is string {
  return typeof v === "string" && v !== REVE_FORGOTTEN && match(v);
}

/** Replace each matching line, keeping a leading diff marker. */
function redactLines(text: string, match: ReveForgetMatch): { text: string; n: number } {
  let n = 0;
  const out = text.split("\n").map((line) => {
    if (!lineHit(line, match)) return line;
    n++;
    return (MARKER_RE.exec(line)?.[0] ?? "") + REVE_FORGOTTEN;
  });
  return { text: out.join("\n"), n };
}

/** The first matching line of a text, or undefined. */
function firstHitLine(text: string, match: ReveForgetMatch): string | undefined {
  return text.split("\n").find((line) => lineHit(line, match));
}

/**
 * Redact a parsed record in place; returns the number of fields / lines
 * replaced and the first text replaced.
 */
function redactRecord(rec: Obj, match: ReveForgetMatch): { n: number; sample?: string } {
  let n = 0;
  let sample: string | undefined;
  const lines = (o: Obj, key: string) => {
    if (typeof o[key] !== "string") return;
    sample ??= firstHitLine(o[key], match);
    const r = redactLines(o[key], match);
    if (r.n) {
      o[key] = r.text;
      n += r.n;
    }
  };
  const value = (v: unknown): boolean => {
    if (!valueHit(v, match)) return false;
    sample ??= v;
    n++;
    return true;
  };
  for (const c of arr(rec.changes)) {
    lines(c, "diff");
    for (const key of ["entriesAdded", "entriesRemoved"]) {
      const list = c[key];
      if (!Array.isArray(list)) continue;
      c[key] = list.map((e: unknown) => (value(e) ? REVE_FORGOTTEN : e));
    }
  }
  for (const c of arr(rec.soulCommits)) {
    lines(c, "diff");
    if (value(c.subject)) c.subject = REVE_FORGOTTEN;
  }
  if (value(rec.summary)) rec.summary = REVE_FORGOTTEN;
  return { n, sample };
}

/** Paths and names in a record that match: structure, never rewritten. */
function structuralHit(rec: Obj, match: ReveForgetMatch): boolean {
  const names: unknown[] = [
    rec.task,
    ...(Array.isArray(rec.skillsTouched) ? rec.skillsTouched : []),
  ];
  for (const c of arr(rec.changes)) names.push(c.path);
  for (const c of arr(rec.soulCommits)) for (const f of arr(c.files)) names.push(f.path);
  if (isObj(rec.desires)) {
    for (const list of Object.values(rec.desires)) if (Array.isArray(list)) names.push(...list);
  }
  return names.some((v) => valueHit(v, match));
}

/** Every string inside a JSON value. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (isObj(v)) for (const x of Object.values(v)) strings(x, out);
  return out;
}

/** Audit keys that are structure (when, what, which dream / request). */
const AUDIT_STRUCTURAL = new Set(["at", "action", "dreamId", "requestId"]);

function redactAuditValue(
  v: unknown,
  match: ReveForgetMatch,
  hits: string[],
  key?: string,
): [unknown, number] {
  if (key && AUDIT_STRUCTURAL.has(key)) return [v, 0];
  if (valueHit(v, match)) {
    hits.push(v);
    return [REVE_FORGOTTEN, 1];
  }
  if (Array.isArray(v)) {
    let n = 0;
    const out = v.map((x) => {
      const [y, k] = redactAuditValue(x, match, hits);
      n += k;
      return y;
    });
    return [out, n];
  }
  if (isObj(v)) {
    let n = 0;
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) {
      const [y, c] = redactAuditValue(x, match, hits, k);
      out[k] = y;
      n += c;
    }
    return [out, n];
  }
  return [v, 0];
}

function emptyCounts(): ReveForgetCounts {
  return { records: 0, summaries: 0, sidecars: 0, reconsider: 0, audit: 0 };
}

export async function forgetInReve(
  match: ReveForgetMatch,
  opts: ReveForgetOptions,
): Promise<ReveForgetResult> {
  const run = () => forgetPass(match, opts);
  return opts.apply ? await lockReve(run) : await run();
}

async function forgetPass(
  match: ReveForgetMatch,
  opts: ReveForgetOptions,
): Promise<ReveForgetResult> {
  const result: ReveForgetResult = {
    apply: opts.apply,
    counts: emptyCounts(),
    total: 0,
    items: [],
    untouched: [],
  };
  /** Record an item; true when apply should write it. */
  const take = (
    location: string,
    content: string,
    kind: keyof ReveForgetCounts,
    matches: number,
    action: ReveForgetItem["action"],
    sample?: string,
  ): boolean => {
    const id = itemId(location, content);
    if (opts.apply && opts.only && !opts.only.has(id)) return false;
    result.items.push({
      id,
      location,
      kind,
      matches,
      action,
      ...(!opts.apply && sample !== undefined ? { sample } : {}),
    });
    result.counts[kind]++;
    return opts.apply;
  };

  for (const id of await idsOnDisk()) {
    // Sidecar first: a deleted copy makes the record's changes not revertible.
    let sidecarGone = false;
    const sidePath = dreamSnapshotFile(id);
    const sideText = await readOrNull(sidePath);
    if (sideText !== null) {
      let hit: string | undefined;
      try {
        hit = strings(JSON.parse(sideText)).find((s) => valueHit(s, match));
      } catch {
        hit = match(sideText) ? sideText : undefined;
      }
      if (hit !== undefined && take(toRel(sidePath), sideText, "sidecars", 1, "delete", hit)) {
        await fs.rm(sidePath, { force: true });
        sidecarGone = true;
      }
    }

    const recPath = dreamFile(id);
    const recText = await readOrNull(recPath);
    if (recText !== null) {
      const parsed = parseObj(recText);
      if (!parsed) {
        // Unreadable as a record: it cannot be redacted field by field.
        if (match(recText) && take(toRel(recPath), recText, "records", 1, "delete", recText)) {
          await fs.rm(recPath, { force: true });
        }
      } else {
        const redacted = structuredClone(parsed);
        const { n, sample } = redactRecord(redacted, match);
        if (structuralHit(parsed, match)) result.untouched.push(toRel(recPath));
        const taken = n > 0 && take(toRel(recPath), recText, "records", n, "redact", sample);
        const rec = taken ? redacted : parsed;
        let write = taken;
        if (sidecarGone) {
          for (const c of arr(rec.changes)) {
            if (c.part !== "soul" && c.revertible === true) {
              c.revertible = false;
              c.notRevertibleReason = SIDECAR_FORGOTTEN_REASON;
              write = true;
            }
          }
        }
        if (write) await atomicWrite(recPath, JSON.stringify(rec, null, 2) + "\n");
      }
    }

    const mdPath = dreamSummaryFile(id);
    const mdText = await readOrNull(mdPath);
    if (mdText !== null) {
      const r = redactLines(mdText, match);
      const sample = firstHitLine(mdText, match);
      if (r.n && take(toRel(mdPath), mdText, "summaries", r.n, "redact", sample)) {
        await atomicWrite(mdPath, r.text);
      }
    }
  }

  // Reconsider notes.
  const rcPath = reconsiderFile();
  const rcText = await readOrNull(rcPath);
  if (rcText !== null) {
    const parsed = parseObj(rcText);
    const queue = parsed && Array.isArray(parsed.requests) ? parsed : null;
    if (!queue) {
      if (match(rcText) && take(toRel(rcPath), rcText, "reconsider", 1, "delete", rcText)) {
        await fs.rm(rcPath, { force: true });
      }
    } else {
      let changed = false;
      for (const r of arr(queue.requests)) {
        if (!valueHit(r.note, match)) continue;
        const where = `${toRel(rcPath)}#${typeof r.id === "string" ? r.id : "?"}`;
        if (take(where, r.note, "reconsider", 1, "redact", r.note)) {
          r.note = REVE_FORGOTTEN;
          changed = true;
        }
      }
      if (changed) await atomicWrite(rcPath, JSON.stringify(queue, null, 2) + "\n");
    }
  }

  // Audit log.
  const auditPath = reveAuditFile();
  const auditText = await readOrNull(auditPath);
  if (auditText !== null) {
    let changed = false;
    const lines = auditText.split("\n").map((line, i) => {
      if (!line.trim()) return line;
      let next: string;
      let n: number;
      const hits: string[] = [];
      let parsed: unknown;
      let json = true;
      try {
        parsed = JSON.parse(line);
      } catch {
        json = false;
      }
      if (json) {
        // Decided on the parsed values, never on the serialized line.
        const [v, k] = redactAuditValue(parsed, match, hits);
        next = JSON.stringify(v);
        n = k;
      } else {
        if (!match(line)) return line;
        hits.push(line);
        next = JSON.stringify({ action: "forgotten" });
        n = 1;
      }
      if (n === 0) return line; // nothing, or only structure, matched
      if (!take(`${toRel(auditPath)}:${i + 1}`, line, "audit", n, "redact", hits[0])) return line;
      changed = true;
      return next;
    });
    if (changed) await atomicWrite(auditPath, lines.join("\n"));
  }

  result.total = Object.values(result.counts).reduce((a, b) => a + b, 0);
  if (opts.apply && result.total > 0) {
    // Counts only: never the topic, never the text.
    await appendLine(
      auditPath,
      JSON.stringify({ at: new Date().toISOString(), action: "forget", counts: result.counts }),
    );
  }
  return result;
}

/**
 * Reach-out ledger — `<lisaHome>/reachout/ledger.jsonl`.
 *
 * One line per gate decision, plus feedback and deferred-release lines. It is
 * what the daily budget, dedupe, dismissal learning and the "useful rate" are
 * computed from. PRIVACY: it never stores a message. A notice is recorded as
 * source + kind + a hash and length of its title + the length of its body; the
 * dedupe key is stored hashed too (it can embed a mailbox id).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";
import { atomicWrite, ensureDir } from "../fs-utils.js";
import { withFileLock } from "../soul/lock.js";
import { localMoment } from "./clock.js";
import { reachOutDir } from "./settings.js";
import {
  REACH_OUT_SOURCES,
  type ReachOutChannel,
  type ReachOutDecision,
  type ReachOutNotice,
  type ReachOutPriority,
  type ReachOutReason,
  type ReachOutSource,
  type ReachOutVerdict,
} from "./types.js";

export type LedgerOutcome = "delivered" | "deferred" | "dropped";

export interface LedgerNoticeEntry {
  v: 1;
  type: "notice";
  id: string;
  /** ISO instant of the decision. */
  ts: string;
  /** Local calendar day the decision counts against ("YYYY-MM-DD"). */
  day: string;
  source: ReachOutSource;
  kind: string;
  priority: ReachOutPriority;
  solicited: boolean;
  outcome: LedgerOutcome;
  channels: ReachOutChannel[];
  deferred?: ReachOutChannel[];
  deferUntil?: string;
  reason: ReachOutReason;
  /** Consumed one unit of the day's unsolicited budget. */
  budget: boolean;
  score?: number;
  titleHash: string;
  titleLen: number;
  bodyLen: number;
  /** sha256 prefix of the dedupe key, when one was given. */
  dedupe?: string;
}

export interface LedgerFeedbackEntry {
  v: 1;
  type: "feedback";
  id: string;
  ts: string;
  verdict: ReachOutVerdict;
  source: ReachOutSource;
  kind: string;
}

/** A deferred channel was released (or given up on) after quiet hours. */
export interface LedgerReleaseEntry {
  v: 1;
  type: "release";
  id: string;
  ts: string;
  channels: ReachOutChannel[];
}

export type LedgerEntry = LedgerNoticeEntry | LedgerFeedbackEntry | LedgerReleaseEntry;

/** How long a `dedupeKey` suppresses a repeat. */
export const DEDUPE_WINDOW_MS = 24 * 60 * 60_000;
/** How far back feedback shapes the value gate. Old dismissals are forgiven. */
export const FEEDBACK_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Compact the file past this size, keeping `LEDGER_KEEP_MS` of history. */
const LEDGER_MAX_BYTES = 1024 * 1024;
const LEDGER_KEEP_MS = 90 * 24 * 60 * 60_000;

export function reachOutLedgerPath(home: string = lisaHome()): string {
  return path.join(reachOutDir(home), "ledger.jsonl");
}

export function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Sender-supplied category → a short safe token (it is written to disk). */
export function sanitizeKind(kind: string): string {
  const k = String(kind ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return k || "unknown";
}

export function newLedgerId(): string {
  return `ro_${crypto.randomBytes(9).toString("base64url")}`;
}

export function outcomeOf(decision: ReachOutDecision): LedgerOutcome {
  if (decision.deferred && decision.deferred.length > 0) return "deferred";
  return decision.deliver ? "delivered" : "dropped";
}

/** Build the ledger line for a decision. No title, no body — sizes and a hash only. */
export function noticeEntry(
  id: string,
  notice: ReachOutNotice,
  decision: ReachOutDecision,
  at: Date,
  tz: string | null,
  solicited: boolean,
): LedgerNoticeEntry {
  const entry: LedgerNoticeEntry = {
    v: 1,
    type: "notice",
    id,
    ts: at.toISOString(),
    day: localMoment(at, tz).day,
    source: notice.source,
    kind: sanitizeKind(notice.kind),
    priority: notice.priority,
    solicited,
    outcome: outcomeOf(decision),
    channels: decision.channels,
    reason: decision.reason,
    budget: decision.countsBudget === true,
    titleHash: hashText(notice.title),
    titleLen: notice.title.length,
    bodyLen: notice.body.length,
  };
  if (decision.deferred?.length) {
    entry.deferred = decision.deferred;
    entry.deferUntil = decision.deferUntil;
  }
  if (typeof decision.score === "number") entry.score = Math.round(decision.score * 1000) / 1000;
  if (notice.dedupeKey) entry.dedupe = hashText(notice.dedupeKey);
  return entry;
}

function isEntry(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  if (typeof e.id !== "string" || typeof e.ts !== "string") return false;
  if (e.type === "notice") {
    return (
      typeof e.day === "string" &&
      typeof e.source === "string" &&
      (REACH_OUT_SOURCES as readonly string[]).includes(e.source) &&
      typeof e.kind === "string" &&
      Array.isArray(e.channels)
    );
  }
  if (e.type === "feedback") return e.verdict === "useful" || e.verdict === "dismissed";
  return e.type === "release";
}

/** Read every well-formed line; a torn or foreign line is skipped, never fatal. */
export function readLedger(home: string = lisaHome()): LedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(reachOutLedgerPath(home), "utf8");
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) out.push(parsed);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Append entries, compacting the file when it has grown past the cap. */
export async function appendLedger(
  entries: LedgerEntry[],
  home: string = lisaHome(),
  now: Date = new Date(),
): Promise<void> {
  if (entries.length === 0) return;
  const file = reachOutLedgerPath(home);
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    const { size } = await fsp.stat(file);
    if (size > LEDGER_MAX_BYTES) {
      const cutoff = now.getTime() - LEDGER_KEEP_MS;
      const kept = readLedger(home).filter((e) => Date.parse(e.ts) >= cutoff);
      await atomicWrite(
        file,
        kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
      );
    }
  } catch {
    /* compaction is best-effort */
  }
}

// One writer at a time per home: an in-process chain (cheap, covers the server)
// around a file lock (covers the CLI and a second process).
const chains = new Map<string, Promise<unknown>>();

export function withReachOutLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(home) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(() => withFileLock(path.join(reachOutDir(home), ".lock"), fn));
  const tail = run.catch(() => undefined);
  chains.set(home, tail);
  void tail.then(() => {
    if (chains.get(home) === tail) chains.delete(home);
  });
  return run;
}

/** Units of the unsolicited budget already spent on `day`. */
export function budgetUsed(entries: LedgerEntry[], day: string): number {
  let n = 0;
  for (const e of entries) if (e.type === "notice" && e.budget && e.day === day) n++;
  return n;
}

/** Was a notice with this dedupe key let through inside the window? */
export function seenRecently(
  entries: LedgerEntry[],
  dedupeKey: string | undefined,
  now: Date,
  windowMs: number = DEDUPE_WINDOW_MS,
): boolean {
  if (!dedupeKey) return false;
  const h = hashText(dedupeKey);
  const since = now.getTime() - windowMs;
  return entries.some(
    (e) =>
      e.type === "notice" && e.dedupe === h && e.outcome !== "dropped" && Date.parse(e.ts) >= since,
  );
}

/**
 * Dismissals minus "useful" marks for one source+kind inside the feedback
 * window, floored at 0. This is the reach-out twin of the advisor's
 * `categoryDismissals`: it feeds the same decay in `relevanceScore`.
 */
export function netDismissals(
  entries: LedgerEntry[],
  source: ReachOutSource,
  kind: string,
  now: Date,
  windowMs: number = FEEDBACK_WINDOW_MS,
): number {
  const k = sanitizeKind(kind);
  const since = now.getTime() - windowMs;
  // Latest verdict per notice wins, so changing your mind does not count twice.
  const latest = new Map<string, ReachOutVerdict>();
  for (const e of entries) {
    if (e.type !== "feedback" || e.source !== source || e.kind !== k) continue;
    if (Date.parse(e.ts) < since) continue;
    latest.set(e.id, e.verdict);
  }
  let net = 0;
  for (const verdict of latest.values()) net += verdict === "dismissed" ? 1 : -1;
  return Math.max(0, net);
}

export type FeedbackResult =
  { ok: true; entry: LedgerFeedbackEntry } | { ok: false; error: "not_found" };

/** Record the user's verdict on a delivered notice. Latest verdict per id wins. */
export async function recordReachOutFeedback(
  id: string,
  verdict: ReachOutVerdict,
  home: string = lisaHome(),
  now: Date = new Date(),
): Promise<FeedbackResult> {
  return withReachOutLock(home, async () => {
    const notice = readLedger(home).find((e) => e.type === "notice" && e.id === id);
    if (!notice || notice.type !== "notice")
      return { ok: false as const, error: "not_found" as const };
    const entry: LedgerFeedbackEntry = {
      v: 1,
      type: "feedback",
      id,
      ts: now.toISOString(),
      verdict,
      source: notice.source,
      kind: notice.kind,
    };
    await appendLedger([entry], home, now);
    return { ok: true as const, entry };
  });
}

export interface SourceTally {
  delivered: number;
  deferred: number;
  dropped: number;
  /** Notices that used (or were queued for) an interrupting channel: push / IM. */
  interrupted: number;
  useful: number;
  dismissed: number;
}

export interface LedgerAggregate {
  days: number;
  /** First local day included ("YYYY-MM-DD"). */
  since: string;
  totals: SourceTally;
  bySource: Record<ReachOutSource, SourceTally>;
  /** Budget units spent today (local day). */
  budgetUsedToday: number;
  /**
   * useful ÷ every notice that reached the user in the window; null when
   * nothing reached them. Charter §7 — initial target ≥ 0.6.
   */
  usefulRate: number | null;
}

const emptyTally = (): SourceTally => ({
  delivered: 0,
  deferred: 0,
  dropped: 0,
  interrupted: 0,
  useful: 0,
  dismissed: 0,
});

/** Roll the ledger up for the last `days` local days (today included). Pure. */
export function aggregateLedger(
  entries: LedgerEntry[],
  days: number,
  now: Date,
  tz: string | null,
): LedgerAggregate {
  const span = Math.min(90, Math.max(1, Math.floor(days) || 1));
  const today = localMoment(now, tz).day;
  const since = localMoment(new Date(now.getTime() - (span - 1) * 86_400_000), tz).day;
  const bySource = {} as Record<ReachOutSource, SourceTally>;
  for (const s of REACH_OUT_SOURCES) bySource[s] = emptyTally();
  const totals = emptyTally();

  const inWindow = new Map<string, LedgerNoticeEntry>();
  for (const e of entries) {
    if (e.type !== "notice" || e.day < since || e.day > today) continue;
    inWindow.set(e.id, e);
    const t = bySource[e.source];
    t[e.outcome]++;
    totals[e.outcome]++;
    const interrupts = [...e.channels, ...(e.deferred ?? [])].some((c) => c !== "inapp");
    if (interrupts) {
      t.interrupted++;
      totals.interrupted++;
    }
  }
  // Latest verdict per notice wins (a user can change their mind).
  const verdicts = new Map<string, ReachOutVerdict>();
  for (const e of entries)
    if (e.type === "feedback" && inWindow.has(e.id)) verdicts.set(e.id, e.verdict);
  for (const [id, verdict] of verdicts) {
    const src = inWindow.get(id)!.source;
    bySource[src][verdict]++;
    totals[verdict]++;
  }
  const reached = totals.delivered + totals.deferred;
  return {
    days: span,
    since,
    totals,
    bySource,
    budgetUsedToday: budgetUsed(entries, today),
    usefulRate: reached > 0 ? totals.useful / reached : null,
  };
}

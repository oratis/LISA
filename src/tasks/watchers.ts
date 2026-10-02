/**
 * Watchers — "tell me when X". Checked on a timer by the runner, with NO model
 * call: a watcher costs a fetch, not tokens.
 *
 *   web   a page (optionally narrowed by a tag/#id/.class selector and a regex)
 *         compared as: changed | appears | disappears | above | below
 *   rss   a feed; new items matching any keyword
 *   mail  new mail whose sender / subject matches (mail module must be connected)
 *
 * Rules every kind follows:
 *   - Network access goes through the SSRF-guarded fetch in tools/web_fetch.ts
 *     (DNS-resolved, private ranges refused, every redirect hop re-checked).
 *     There is no second fetch path.
 *   - The first observation is a BASELINE, not a hit — except for a condition
 *     that is already true (a slot that is open right now is what was asked for).
 *   - Hits are edge-triggered with hysteresis: after a hit, the condition must
 *     be observed false twice in a row before it can fire again, so a page
 *     that flaps does not page the user on every poll. A "changed" page that
 *     returns to content already reported is not reported again.
 *   - What comes back is data. Hit text is clipped, and when a task runs its
 *     instruction on a hit the runner frames it as an untrusted observation.
 *   - Mail hits carry sender and subject only — never a body, not even the
 *     snippet the mail module keeps.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import { isGranted } from "../consent/store.js";
import { parseFeed } from "../kb/feeds/rss.js";
import type { MailConnector } from "../mail/types.js";
import {
  fetchFollowingSafeRedirects,
  htmlToText,
  readResponseTextCapped,
  type SafeFetchDependencies,
} from "../tools/web_fetch.js";
import type { WatchCheck, WatchOutcome } from "./runner.js";
import type { MailTrigger, RssTrigger, Task, WatchState, WebTrigger } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const REGEX_TIMEOUT_MS = 250;
const MAX_SEEN = 500;
const MAX_CHANGE_MEMORY = 20;
/** Consecutive contrary observations needed to leave the "condition is true" state. */
const REARM_AFTER = 2;

export interface FetchedText {
  status: number;
  contentType: string;
  text: string;
}

export interface WatchMail {
  uid: string;
  accountId: string;
  from: string;
  fromAddress: string;
  subject: string;
  date: number;
}

export interface WatcherDeps {
  /** Test seam for the guarded fetch's DNS + transport. The guard itself is not replaceable. */
  safeFetch?: SafeFetchDependencies;
  /** Test seam for the mail module. Default: consent gate + connected accounts. */
  listMail?: (sinceMs: number, signal: AbortSignal) => Promise<WatchMail[]>;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

async function fetchText(url: string, signal: AbortSignal, deps: WatcherDeps): Promise<FetchedText> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchFollowingSafeRedirects(url, AbortSignal.any([signal, timeout]), undefined, deps.safeFetch);
  const { text } = await readResponseTextCapped(res, MAX_BODY_BYTES);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text };
}

// ── selector + regex ──

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
}

function parseSelector(selector: string): SimpleSelector {
  const out: SimpleSelector = { classes: [] };
  const tag = selector.match(/^[a-zA-Z][a-zA-Z0-9]*/);
  if (tag) out.tag = tag[0].toLowerCase();
  for (const m of selector.matchAll(/([#.])([\w-]+)/g)) {
    if (m[1] === "#") out.id = m[2]!;
    else out.classes.push(m[2]!);
  }
  return out;
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * Inner HTML of every element matching a tag/#id/.class selector (max 20).
 * A deliberately small matcher — enough to point at "the price" or "the stock
 * line", not a CSS engine.
 */
export function selectHtml(html: string, selector: string): string[] {
  const want = parseSelector(selector);
  const out: string[] = [];
  const open = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  for (let m = open.exec(html); m && out.length < 20; m = open.exec(html)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    if (want.tag && tag !== want.tag) continue;
    if (want.id !== undefined && attr(attrs, "id") !== want.id) continue;
    if (want.classes.length) {
      const have = new Set((attr(attrs, "class") ?? "").split(/\s+/));
      if (!want.classes.every((c) => have.has(c))) continue;
    }
    if (VOID_TAGS.has(tag) || attrs.trimEnd().endsWith("/")) {
      out.push("");
      continue;
    }
    // Walk to the matching close tag, counting nested elements of the same name.
    const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    walker.lastIndex = open.lastIndex;
    let depth = 1;
    let end = html.length;
    for (let w = walker.exec(html); w; w = walker.exec(html)) {
      depth += w[1] ? -1 : 1;
      if (depth === 0) {
        end = w.index;
        break;
      }
    }
    out.push(html.slice(open.lastIndex, end));
  }
  return out;
}

/**
 * Run a user-supplied regex with a hard time limit, so a pathological pattern
 * (catastrophic backtracking) costs a quarter of a second, not the event loop.
 */
export function safeRegexExec(pattern: string, text: string): { match: string | null } | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return { error: "invalid regular expression" };
  }
  try {
    const m = vm.runInNewContext("re.exec(text)", { re, text }, { timeout: REGEX_TIMEOUT_MS }) as
      | RegExpExecArray
      | null;
    return { match: m ? (m[1] ?? m[0] ?? "") : null };
  } catch {
    return { error: "regular expression took too long on this page" };
  }
}

function firstNumber(text: string): number | null {
  const m = text.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number.parseFloat(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── edge trigger with hysteresis ──

/**
 * Fold one observation of a boolean condition into the watch state.
 * `fire` is true exactly when the debounced condition goes false → true.
 */
export function observeCondition(prev: WatchState | undefined, condition: boolean): { watch: WatchState; fire: boolean } {
  const watch: WatchState = { ...prev };
  const was = prev?.lastCondition ?? false;
  if (condition) {
    watch.contrary = 0;
    watch.lastCondition = true;
    return { watch, fire: !was };
  }
  if (!was) {
    watch.contrary = 0;
    watch.lastCondition = false;
    return { watch, fire: false };
  }
  // Was true, observed false: only let go after it has stayed false.
  const contrary = (prev?.contrary ?? 0) + 1;
  if (contrary >= REARM_AFTER) {
    watch.lastCondition = false;
    watch.contrary = 0;
  } else {
    watch.contrary = contrary;
  }
  return { watch, fire: false };
}

function remember(seen: string[] | undefined, ids: string[], cap: number): string[] {
  const merged = [...(seen ?? []), ...ids];
  return merged.slice(Math.max(0, merged.length - cap));
}

function failed(task: Task, error: string): WatchOutcome {
  return { watch: { ...task.watch, failures: (task.watch?.failures ?? 0) + 1 }, error };
}

// ── web ──

async function checkWeb(task: Task, trigger: WebTrigger, signal: AbortSignal, deps: WatcherDeps): Promise<WatchOutcome> {
  const page = await fetchText(trigger.url, signal, deps);
  if (page.status < 200 || page.status >= 300) return failed(task, `HTTP ${page.status} from the watched page`);

  const isHtml = /html|xml/i.test(page.contentType) || /^\s*</.test(page.text);
  let text: string;
  if (trigger.selector) {
    const parts = selectHtml(page.text, trigger.selector);
    // A selector that matches nothing is an observation ("it is not there"),
    // not an error: that is exactly what `disappears` waits for.
    text = parts.map((p) => htmlToText(p)).join("\n");
  } else {
    text = isHtml ? htmlToText(page.text) : page.text;
  }

  let value: string | null = text;
  let matched = true;
  if (trigger.regex) {
    const result = safeRegexExec(trigger.regex, text);
    if ("error" in result) return failed(task, result.error);
    value = result.match;
    matched = result.match !== null;
  }
  if (trigger.contains) {
    matched = matched && (value ?? "").toLowerCase().includes(trigger.contains.toLowerCase());
  }

  const where = new URL(trigger.url).hostname;

  if (trigger.mode === "changed") {
    const fingerprint = sha(value ?? "");
    const prev = task.watch;
    const watch: WatchState = { ...prev, lastFingerprint: fingerprint, failures: 0 };
    if (prev?.lastFingerprint === undefined || prev.lastFingerprint === fingerprint) return { watch };
    // Content we have already reported (a page flipping between two states) stays quiet.
    if (prev.seen?.includes(fingerprint)) return { watch };
    watch.seen = remember(prev.seen ?? [prev.lastFingerprint], [fingerprint], MAX_CHANGE_MEMORY);
    return {
      watch,
      hit: {
        key: `changed:${fingerprint}`,
        summary: `${where} changed.`,
        detail: `Now reads: ${clip(value ?? "", 600)}`,
      },
    };
  }

  let condition: boolean;
  let describe: string;
  if (trigger.mode === "appears" || trigger.mode === "disappears") {
    const present = matched && (trigger.selector && !trigger.regex && !trigger.contains ? text.trim() !== "" : true);
    condition = trigger.mode === "appears" ? present : !present;
    const what = trigger.contains ?? trigger.regex ?? trigger.selector ?? "the watched text";
    describe = trigger.mode === "appears" ? `"${clip(what, 80)}" is now on ${where}.` : `"${clip(what, 80)}" is no longer on ${where}.`;
  } else {
    const n = value === null ? null : firstNumber(value);
    if (n === null) return failed(task, "no number found where the watcher looks");
    const threshold = trigger.threshold ?? 0;
    condition = trigger.mode === "above" ? n > threshold : n < threshold;
    describe = `${where}: ${n} is ${trigger.mode} ${threshold}.`;
    value = String(n);
  }

  const { watch, fire } = observeCondition(task.watch, condition);
  watch.failures = 0;
  if (!fire) return { watch };
  return {
    watch,
    hit: {
      // The previous hit time is part of the key: the same observation seen
      // twice (a lost state write) maps to one hit, a later re-fire to another.
      key: `${trigger.mode}:${task.watch?.lastHitAt ?? 0}:${sha(value ?? "").slice(0, 16)}`,
      summary: describe,
      ...(value && trigger.mode !== "disappears" ? { detail: `Observed: ${clip(value, 600)}` } : {}),
    },
  };
}

// ── rss ──

async function checkRss(task: Task, trigger: RssTrigger, signal: AbortSignal, deps: WatcherDeps): Promise<WatchOutcome> {
  const page = await fetchText(trigger.url, signal, deps);
  if (page.status < 200 || page.status >= 300) return failed(task, `HTTP ${page.status} from the feed`);
  const feed = parseFeed(page.text);
  const ids = feed.items.map((i) => i.id);
  const prev = task.watch;
  // First look at a feed: everything already in it is old news.
  if (prev?.seen === undefined) return { watch: { ...prev, seen: remember([], ids, MAX_SEEN), failures: 0 } };

  const known = new Set(prev.seen);
  const fresh = feed.items.filter((i) => !known.has(i.id));
  const watch: WatchState = { ...prev, seen: remember(prev.seen, fresh.map((i) => i.id), MAX_SEEN), failures: 0 };
  const keywords = (trigger.keywords ?? []).map((k) => k.toLowerCase());
  const hits = fresh.filter((item) => {
    if (keywords.length === 0) return true;
    const hay = `${item.title} ${item.summary ?? ""}`.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  });
  if (hits.length === 0) return { watch };
  const lines = hits.slice(0, 5).map((i) => `- ${clip(i.title, 160)}${i.link ? ` — ${i.link}` : ""}`);
  if (hits.length > 5) lines.push(`…and ${hits.length - 5} more`);
  return {
    watch,
    hit: {
      key: `rss:${sha(hits.map((i) => i.id).sort().join("\n")).slice(0, 24)}`,
      summary: `${hits.length} new item${hits.length === 1 ? "" : "s"} in ${clip(feed.title ?? new URL(trigger.url).hostname, 80)}.`,
      detail: lines.join("\n"),
    },
  };
}

// ── mail ──

async function defaultListMail(sinceMs: number): Promise<WatchMail[]> {
  if (!isGranted("mail")) throw new Error("mail access has not been granted");
  // Loaded on demand: only a mail watcher needs the IMAP / Gmail stack.
  const { getSecret, loadAccounts, setSecret } = await import("../mail/accounts.js");
  const accounts = loadAccounts().filter((a) => a.enabled);
  if (accounts.length === 0) throw new Error("no mailbox is connected");
  const out: WatchMail[] = [];
  let reached = 0;
  for (const account of accounts) {
    const secret = getSecret(account.id);
    if (!secret) continue;
    let connector: MailConnector | null = null;
    try {
      if (account.provider === "gmail") {
        const { GmailConnector } = await import("../mail/connectors/gmail.js");
        connector = new GmailConnector(account, secret, { onTokenRefresh: (t) => setSecret(account.id, t) });
      } else {
        const { ImapConnector } = await import("../mail/connectors/imap.js");
        connector = new ImapConnector(account, secret);
      }
      // Read-only listing. Deliberately does NOT touch the mail module's own
      // seen-state: a watcher must not swallow that module's alerts.
      const raws = await connector.listSince({ sinceMs, limit: 200 });
      reached++;
      for (const r of raws) {
        // Metadata only leaves this function — no snippet, no body.
        out.push({ uid: r.uid, accountId: account.id, from: r.from, fromAddress: r.fromAddress, subject: r.subject, date: r.date });
      }
    } catch {
      // One unreachable mailbox must not fail the others.
    } finally {
      if (connector) await connector.close().catch(() => {});
    }
  }
  if (reached === 0) throw new Error("no connected mailbox could be reached");
  return out;
}

async function checkMail(task: Task, trigger: MailTrigger, signal: AbortSignal, deps: WatcherDeps, now: number): Promise<WatchOutcome> {
  const prev = task.watch;
  const sinceMs = Math.min(prev?.lastCheckedAt ?? now, now) - 24 * 3_600_000;
  const mails = await (deps.listMail ?? defaultListMail)(sinceMs, signal);
  const from = trigger.from?.toLowerCase();
  const subject = trigger.subject?.toLowerCase();
  const matching = mails.filter(
    (m) =>
      (!from || m.from.toLowerCase().includes(from) || m.fromAddress.toLowerCase().includes(from)) &&
      (!subject || m.subject.toLowerCase().includes(subject)),
  );
  const idOf = (m: WatchMail): string => `${m.accountId}:${m.uid}`;
  // First look: mail that is already there is not news.
  if (prev?.seen === undefined) {
    return { watch: { ...prev, seen: remember([], matching.map(idOf), MAX_SEEN), failures: 0 } };
  }
  const known = new Set(prev.seen);
  const fresh = matching.filter((m) => !known.has(idOf(m)));
  const watch: WatchState = { ...prev, seen: remember(prev.seen, fresh.map(idOf), MAX_SEEN), failures: 0 };
  if (fresh.length === 0) return { watch };
  const lines = fresh
    .sort((a, b) => b.date - a.date)
    .slice(0, 5)
    .map((m) => `- ${clip(m.from, 80)}: ${clip(m.subject, 160)}`);
  if (fresh.length > 5) lines.push(`…and ${fresh.length - 5} more`);
  return {
    watch,
    hit: {
      key: `mail:${sha(fresh.map(idOf).sort().join("\n")).slice(0, 24)}`,
      summary: `${fresh.length} new matching message${fresh.length === 1 ? "" : "s"}.`,
      detail: lines.join("\n"),
    },
  };
}

// ── entry point ──

/** Build the watcher check the runner calls. `deps` are test seams only. */
export function createWatchCheck(deps: WatcherDeps = {}): WatchCheck {
  return async (task, ctx) => {
    const trigger = task.trigger;
    if (!trigger) return failed(task, "watcher has no trigger");
    try {
      if (trigger.kind === "web") return await checkWeb(task, trigger, ctx.signal, deps);
      if (trigger.kind === "rss") return await checkRss(task, trigger, ctx.signal, deps);
      return await checkMail(task, trigger, ctx.signal, deps, ctx.now);
    } catch (err) {
      // Includes the SSRF guard's refusals: a watcher pointed at a private
      // address fails, backs off, and tells the user after a few tries.
      return failed(task, clip((err as Error).message ?? String(err), 300));
    }
  };
}

export const checkWatcher: WatchCheck = createWatchCheck();

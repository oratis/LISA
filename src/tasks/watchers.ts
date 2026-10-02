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
 *     snippet the mail module keeps — and both pass through the mail inbound
 *     hygiene filter (warden/hygiene-mail.ts) first, so a one-time code or a
 *     sign-in link in a subject line never reaches a notice or a model.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import { isGranted } from "../consent/store.js";
import { parseFeed } from "../kb/feeds/rss.js";
import type { MailConnector } from "../mail/types.js";
import { sanitizeMailBatch, sanitizeMailFields } from "../warden/hygiene-mail.js";
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
/** Hard bound on turning a fetched page or feed into the text that is compared. */
const EXTRACT_TIMEOUT_MS = 1_000;
/**
 * How many item ids a feed / mailbox watcher remembers, and how many items of
 * one fetch it looks at. The same number on purpose: the memory always covers
 * everything a fetch can contain, so nothing in the feed as fetched can be
 * forgotten and look new again.
 */
const MAX_SEEN = 2_000;
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

async function fetchText(
  url: string,
  signal: AbortSignal,
  deps: WatcherDeps,
): Promise<FetchedText> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetchFollowingSafeRedirects(
    url,
    AbortSignal.any([signal, timeout]),
    undefined,
    deps.safeFetch,
  );
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

const ID_ATTR = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const CLASS_ATTR = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

function attr(attrs: string, re: RegExp): string | null {
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

interface TagToken {
  name: string;
  close: boolean;
  /** Offsets of `<` and of the character after `>`. */
  start: number;
  end: number;
  attrs: string;
}

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9]*/y;

/**
 * Every tag in the document, in one left-to-right pass.
 *
 * Linear by construction: the position of the next `>` is searched for once
 * and reused for every `<` before it, and the scan ends at the first `<` with
 * no `>` after it. (The regex this replaces re-scanned to the end of the input
 * from every `<` — a page of `<a<a<a…` with no `>` took seconds and froze the
 * event loop.)
 */
function scanTags(html: string): TagToken[] {
  const tags: TagToken[] = [];
  let i = 0;
  let gt = -1;
  for (;;) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (gt <= lt) {
      gt = html.indexOf(">", lt + 1);
      if (gt < 0) break; // nothing after this point can be a complete tag
    }
    let j = lt + 1;
    const close = html.charCodeAt(j) === 47; // "/"
    if (close) j++;
    TAG_NAME.lastIndex = j;
    const name = TAG_NAME.exec(html);
    if (!name || TAG_NAME.lastIndex > gt) {
      i = lt + 1; // a stray "<" — not a tag
      continue;
    }
    tags.push({
      name: name[0].toLowerCase(),
      close,
      start: lt,
      end: gt + 1,
      attrs: html.slice(TAG_NAME.lastIndex, gt),
    });
    i = gt + 1;
  }
  return tags;
}

/**
 * Inner HTML of every element matching a tag/#id/.class selector (max 20).
 * A deliberately small matcher — enough to point at "the price" or "the stock
 * line", not a CSS engine.
 */
export function selectHtml(html: string, selector: string): string[] {
  const want = parseSelector(selector);
  const out: string[] = [];
  const tags = scanTags(html);
  for (let t = 0; t < tags.length && out.length < 20; t++) {
    const tag = tags[t]!;
    if (tag.close) continue;
    if (want.tag && tag.name !== want.tag) continue;
    if (want.id !== undefined && attr(tag.attrs, ID_ATTR) !== want.id) continue;
    if (want.classes.length) {
      const have = new Set((attr(tag.attrs, CLASS_ATTR) ?? "").split(/\s+/));
      if (!want.classes.every((c) => have.has(c))) continue;
    }
    if (VOID_TAGS.has(tag.name) || tag.attrs.trimEnd().endsWith("/")) {
      out.push("");
      continue;
    }
    // Walk to the matching close tag, counting nested elements of the same name.
    let depth = 1;
    let end = html.length;
    for (let w = t + 1; w < tags.length; w++) {
      const other = tags[w]!;
      if (other.name !== tag.name) continue;
      if (!other.close && other.attrs.trimEnd().endsWith("/")) continue;
      depth += other.close ? -1 : 1;
      if (depth === 0) {
        end = other.start;
        break;
      }
    }
    out.push(html.slice(tag.end, end));
  }
  return out;
}

/**
 * Run `fn` with a hard time limit. Everything a watcher does to a fetched page
 * — tag scanning, HTML-to-text, feed parsing — is synchronous work on content
 * an outsider controls, so all of it runs under this: a page built to be slow
 * costs the limit once and counts as a failed check (which backs off), instead
 * of blocking the event loop for as long as it likes on every poll.
 */
export function withinTimeLimit<T>(
  fn: () => T,
  ms: number,
): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: vm.runInNewContext("fn()", { fn }, { timeout: ms }) as T };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { ok: false };
    throw e;
  }
}

/**
 * Run a user-supplied regex with a hard time limit, so a pathological pattern
 * (catastrophic backtracking) costs a quarter of a second, not the event loop.
 */
export function safeRegexExec(
  pattern: string,
  text: string,
): { match: string | null } | { error: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return { error: "invalid regular expression" };
  }
  try {
    const m = vm.runInNewContext(
      "re.exec(text)",
      { re, text },
      { timeout: REGEX_TIMEOUT_MS },
    ) as RegExpExecArray | null;
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
export function observeCondition(
  prev: WatchState | undefined,
  condition: boolean,
): { watch: WatchState; fire: boolean } {
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

/** A stable, bounded stand-in for an item id (feed guids can be whole URLs). */
function seenKey(id: string): string {
  return id.length <= 24 ? id : `h:${sha(id).slice(0, 20)}`;
}

/**
 * The seen-list after a fetch: everything in THIS fetch first, then what was
 * remembered before, oldest-seen dropped from the tail. Because the current
 * fetch is always kept whole, an item that is still in the feed can never be
 * evicted — which is what made a long feed fire on every poll.
 */
function rememberFetch(current: string[], previous: string[] | undefined, cap: number): string[] {
  const out: string[] = [];
  const have = new Set<string>();
  for (const key of [...current, ...(previous ?? [])]) {
    if (have.has(key)) continue;
    have.add(key);
    out.push(key);
    if (out.length >= cap) break;
  }
  return out;
}

function failed(task: Task, error: string): WatchOutcome {
  return { watch: { ...task.watch, failures: (task.watch?.failures ?? 0) + 1 }, error };
}

// ── web ──

async function checkWeb(
  task: Task,
  trigger: WebTrigger,
  signal: AbortSignal,
  deps: WatcherDeps,
): Promise<WatchOutcome> {
  const page = await fetchText(trigger.url, signal, deps);
  if (page.status < 200 || page.status >= 300)
    return failed(task, `HTTP ${page.status} from the watched page`);

  const isHtml = /html|xml/i.test(page.contentType) || /^\s*</.test(page.text);
  const selector = trigger.selector;
  const extracted = withinTimeLimit(() => {
    if (selector) {
      // A selector that matches nothing is an observation ("it is not there"),
      // not an error: that is exactly what `disappears` waits for.
      return selectHtml(page.text, selector)
        .map((part) => htmlToText(part))
        .join("\n");
    }
    return isHtml ? htmlToText(page.text) : page.text;
  }, EXTRACT_TIMEOUT_MS);
  if (!extracted.ok) return failed(task, "the page took too long to process");
  const text = extracted.value;

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
    if (prev?.lastFingerprint === undefined || prev.lastFingerprint === fingerprint)
      return { watch };
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
    const present =
      matched &&
      (trigger.selector && !trigger.regex && !trigger.contains ? text.trim() !== "" : true);
    condition = trigger.mode === "appears" ? present : !present;
    const what = trigger.contains ?? trigger.regex ?? trigger.selector ?? "the watched text";
    describe =
      trigger.mode === "appears"
        ? `"${clip(what, 80)}" is now on ${where}.`
        : `"${clip(what, 80)}" is no longer on ${where}.`;
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
      ...(value && trigger.mode !== "disappears"
        ? { detail: `Observed: ${clip(value, 600)}` }
        : {}),
    },
  };
}

// ── rss ──

async function checkRss(
  task: Task,
  trigger: RssTrigger,
  signal: AbortSignal,
  deps: WatcherDeps,
): Promise<WatchOutcome> {
  const page = await fetchText(trigger.url, signal, deps);
  if (page.status < 200 || page.status >= 300)
    return failed(task, `HTTP ${page.status} from the feed`);
  const parsed = withinTimeLimit(() => parseFeed(page.text), EXTRACT_TIMEOUT_MS);
  if (!parsed.ok) return failed(task, "the feed took too long to process");
  const feed = parsed.value;
  // Only the head of an enormous feed is considered — the same bound as the
  // memory, so every item considered is also remembered.
  const items = feed.items.slice(0, MAX_SEEN);
  const keys = items.map((i) => seenKey(i.id));
  const prev = task.watch;
  // First look at a feed: everything already in it is old news.
  if (prev?.seen === undefined)
    return { watch: { ...prev, seen: rememberFetch(keys, undefined, MAX_SEEN), failures: 0 } };

  const known = new Set(prev.seen);
  const fresh = items.filter((_, index) => !known.has(keys[index]!));
  const watch: WatchState = {
    ...prev,
    seen: rememberFetch(keys, prev.seen, MAX_SEEN),
    failures: 0,
  };
  const keywords = (trigger.keywords ?? []).map((k) => k.toLowerCase());
  const hits = fresh.filter((item) => {
    if (keywords.length === 0) return true;
    const hay = `${item.title} ${item.summary ?? ""}`.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  });
  if (hits.length === 0) return { watch };
  const lines = hits
    .slice(0, 5)
    .map((i) => `- ${clip(i.title, 160)}${i.link ? ` — ${i.link}` : ""}`);
  if (hits.length > 5) lines.push(`…and ${hits.length - 5} more`);
  return {
    watch,
    hit: {
      key: `rss:${sha(
        hits
          .map((i) => i.id)
          .sort()
          .join("\n"),
      ).slice(0, 24)}`,
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
        connector = new GmailConnector(account, secret, {
          onTokenRefresh: (t) => setSecret(account.id, t),
        });
      } else {
        const { ImapConnector } = await import("../mail/connectors/imap.js");
        connector = new ImapConnector(account, secret);
      }
      // Read-only listing. Deliberately does NOT touch the mail module's own
      // seen-state: a watcher must not swallow that module's alerts.
      const fetched = await connector.listSince({ sinceMs, limit: 200 });
      reached++;
      // Inbound hygiene (W2b), applied where mail enters — same as the mail
      // service does. Subject and snippet are read together here because a
      // one-time code is often announced in one and printed in the other.
      const raws = sanitizeMailBatch(fetched).mails;
      for (const r of raws) {
        // Metadata only leaves this function — no snippet, no body.
        out.push({
          uid: r.uid,
          accountId: account.id,
          from: r.from,
          fromAddress: r.fromAddress,
          subject: r.subject,
          date: r.date,
        });
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

async function checkMail(
  task: Task,
  trigger: MailTrigger,
  signal: AbortSignal,
  deps: WatcherDeps,
  now: number,
): Promise<WatchOutcome> {
  const prev = task.watch;
  const sinceMs = Math.min(prev?.lastCheckedAt ?? now, now) - 24 * 3_600_000;
  const listed = await (deps.listMail ?? defaultListMail)(sinceMs, signal);
  // Cleaned again here (the filter is idempotent) so that no source of mail —
  // an injected lister, a future caller — can put a one-time code or a sign-in
  // link into a notice, the conversation, or a model's context.
  const mails = listed.map((m) => {
    const cleaned = sanitizeMailFields({ from: m.from, subject: m.subject, snippet: "" }).mail;
    return { ...m, from: cleaned.from ?? m.from, subject: cleaned.subject };
  });
  const from = trigger.from?.toLowerCase();
  const subject = trigger.subject?.toLowerCase();
  const matching = mails.filter(
    (m) =>
      (!from ||
        m.from.toLowerCase().includes(from) ||
        m.fromAddress.toLowerCase().includes(from)) &&
      (!subject || m.subject.toLowerCase().includes(subject)),
  );
  const idOf = (m: WatchMail): string => seenKey(`${m.accountId}:${m.uid}`);
  // First look: mail that is already there is not news.
  if (prev?.seen === undefined) {
    return {
      watch: { ...prev, seen: rememberFetch(matching.map(idOf), undefined, MAX_SEEN), failures: 0 },
    };
  }
  const known = new Set(prev.seen);
  const fresh = matching.filter((m) => !known.has(idOf(m)));
  const watch: WatchState = {
    ...prev,
    seen: rememberFetch(matching.map(idOf), prev.seen, MAX_SEEN),
    failures: 0,
  };
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

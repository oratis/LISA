import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../paths.js";
import { ensureDir, pathExists } from "../fs-utils.js";
import { jsonlLines } from "./jsonl.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";

export interface SessionInfo {
  id: string;
  path: string;
  startedAt: string;
  cwd: string;
  model: string;
  messageCount: number;
  lastUserMessage?: string;
  /** First user message (80 chars) — the session's display name in the
   *  web shell tree/tabs (PLAN_UI_SESSION_SHELL_v1.1 F2). */
  firstUserMessage?: string;
}

/**
 * Summary cache (T-4).
 *
 * The session list is polled by the web shell, the iOS roster and the tab
 * strip, and every poll used to re-read and re-parse every .jsonl in the
 * directory — on a machine with a year of sessions that is tens of MB of
 * whole-file reads and JSON.parse per poll, on the request path, which is
 * exactly the profile behind the multi-second event-loop stalls in the v0.24
 * review.
 *
 * A summary is a pure function of the file's bytes, so (mtimeMs, size) is a
 * sound cache key: an append changes size, a rewrite changes mtime, and the
 * pair changing means the summary must be recomputed. Keys are ABSOLUTE
 * paths, which include the per-uid home, so one tenant can never read another
 * tenant's cached summary (INVARIANTS §身份与租户 2/3).
 *
 * Bounded by an LRU cap rather than left to grow (INVARIANTS §身份与租户 2):
 * the Map is kept in access order, so the oldest untouched entry is evicted
 * first.
 */
interface CachedSummary {
  mtimeMs: number;
  size: number;
  /** null for a file that parsed to nothing — cached so it isn't retried. */
  info: SessionInfo | null;
}

const SUMMARY_CACHE_MAX = 500;
const summaryCache = new Map<string, CachedSummary>();

/** Drop every cached summary. For tests and for a home switch. */
export function clearSessionSummaryCache(): void {
  summaryCache.clear();
}

/** Cache statistics, for tests and diagnostics. */
export function sessionSummaryCacheSize(): number {
  return summaryCache.size;
}

function cacheTouch(key: string, entry: CachedSummary): void {
  // Re-insert so Map iteration order stays least-recently-used first.
  summaryCache.delete(key);
  summaryCache.set(key, entry);
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next();
    if (oldest.done) break;
    summaryCache.delete(oldest.value);
  }
}

export async function listSessionsOnDisk(): Promise<SessionInfo[]> {
  const dir = sessionsDir();
  await ensureDir(dir);
  const files = await fs.readdir(dir);
  const out: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const full = path.join(dir, file);
    seen.add(full);
    try {
      const st = await fs.stat(full);
      const hit = summaryCache.get(full);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        cacheTouch(full, hit);
        if (hit.info) out.push(hit.info);
        continue;
      }
      const info = await summarize(full);
      cacheTouch(full, { mtimeMs: st.mtimeMs, size: st.size, info });
      if (info) out.push(info);
    } catch {
      // skip corrupt sessions
    }
  }
  // Forget deleted sessions — but only within the directory we just listed, so
  // a cloud request scoped to one uid never evicts another uid's entries.
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const key of [...summaryCache.keys()]) {
    if (key.startsWith(prefix) && !seen.has(key)) summaryCache.delete(key);
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

/**
 * Summarize one session file. Streamed rather than read whole (T-5): the
 * counts and the first/last user line are all computable in one pass, and a
 * multi-megabyte session must not become a multi-megabyte string plus an
 * array of every line just to produce an 80-character preview.
 */
async function summarize(file: string): Promise<SessionInfo | null> {
  let header: SessionHeader | null = null;
  let messageCount = 0;
  let lastUser: string | undefined;
  let firstUser: string | undefined;
  for await (const line of jsonlLines(file)) {
    if (!header) {
      header = JSON.parse(line) as SessionHeader;
      continue;
    }
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue; // skip a torn line rather than losing the whole session
    }
    if (entry.type !== "message") continue;
    messageCount++;
    if (entry.message.role === "user") {
      // Only the first 80 characters are ever shown, so never keep more.
      const text = textOf(entry.message).slice(0, 80);
      if (text) {
        lastUser = text;
        if (firstUser === undefined) firstUser = text;
      }
    }
  }
  if (!header) return null;
  return {
    id: header.id,
    path: file,
    startedAt: header.startedAt,
    cwd: header.cwd,
    model: header.model,
    messageCount,
    lastUserMessage: lastUser,
    firstUserMessage: firstUser,
  };
}

function textOf(message: StoredMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join(" ");
}

export async function loadSessionMessages(id: string): Promise<{
  header: SessionHeader;
  messages: StoredMessage[];
}> {
  const file = path.join(sessionsDir(), `${id}.jsonl`);
  if (!(await pathExists(file))) {
    throw new Error(`session ${id} not found at ${file}`);
  }
  // Streamed (T-5). The caller wants every message, so the RESULT is
  // unavoidably proportional to the file — but the intermediate whole-file
  // string and line array are not, and they were the allocations that hurt.
  let header: SessionHeader | null = null;
  const messages: StoredMessage[] = [];
  for await (const line of jsonlLines(file)) {
    if (!header) {
      header = JSON.parse(line) as SessionHeader;
      continue;
    }
    let entry: SessionEntry;
    try {
      entry = JSON.parse(line) as SessionEntry;
    } catch {
      continue;
    }
    if (entry.type === "message") messages.push(entry.message);
  }
  if (!header) throw new Error(`session ${id} is empty`);
  return { header, messages };
}

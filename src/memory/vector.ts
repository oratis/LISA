import path from "node:path";
import fs from "node:fs/promises";
import { listSessionsOnDisk, loadSessionMessages } from "../sessions/list.js";
import { SESSIONS_DIR } from "../paths.js";
import { extractTextFromContent } from "../agent.js";

interface Document {
  sessionId: string;
  startedAt: string;
  text: string;
  tokens: string[];
  tokenSet: Set<string>;
  termFreq: Map<string, number>;
}

interface Index {
  docs: Document[];
  idf: Map<string, number>;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "for", "is", "it",
  "this", "that", "be", "are", "was", "were", "with", "on", "as", "at",
  "by", "from", "but", "not", "i", "you", "we", "they", "he", "she",
  "lisa", "tool", "use", "user", "assistant",
]);

// ── index cache ───────────────────────────────────────────────────────────
// buildIndex re-reads + re-tokenizes EVERY past session, which is O(total
// transcript bytes). memory_search was calling it fresh on every invocation,
// so a chat that searches its memory N times in one session paid that cost N
// times even when nothing changed. We cache the built index keyed by a cheap
// fingerprint of the sessions directory (each .jsonl's mtime + size). The
// fingerprint changes the instant any session is appended to or a new one
// appears, so the cache is correct, not just fast.
let cachedIndex: Index | null = null;
let cachedFingerprint = "";

async function sessionsFingerprint(): Promise<string> {
  let files: string[];
  try {
    files = await fs.readdir(SESSIONS_DIR);
  } catch {
    // Missing dir and empty dir must fingerprint identically: buildIndex →
    // listSessionsOnDisk → ensureDir CREATES the dir as a side effect, so a
    // distinct "no-dir" sentinel would spuriously miss the cache on the very
    // next call. Both collapse to the empty fingerprint.
    return "";
  }
  const parts: string[] = [];
  for (const f of files.sort()) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = await fs.stat(path.join(SESSIONS_DIR, f));
      parts.push(`${f}:${st.mtimeMs}:${st.size}`);
    } catch {
      // file vanished between readdir and stat — ignore
    }
  }
  return parts.join("|");
}

/** Drop the cached index (test hook / explicit invalidation). */
export function clearIndexCache(): void {
  cachedIndex = null;
  cachedFingerprint = "";
}

export async function buildIndex(opts: { cache?: boolean } = {}): Promise<Index> {
  const useCache = opts.cache !== false;
  if (useCache) {
    const fp = await sessionsFingerprint();
    if (cachedIndex && fp === cachedFingerprint) return cachedIndex;
    const built = await buildIndexUncached();
    cachedIndex = built;
    cachedFingerprint = fp;
    return built;
  }
  return buildIndexUncached();
}

async function buildIndexUncached(): Promise<Index> {
  const sessions = await listSessionsOnDisk();
  const docs: Document[] = [];
  const docFreq = new Map<string, number>();
  for (const info of sessions) {
    try {
      const { messages } = await loadSessionMessages(info.id);
      const text = messages
        .map((m) => extractTextFromContent(m.content))
        .join("\n");
      if (!text.trim()) continue;
      const tokens = tokenize(text);
      const set = new Set(tokens);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of set) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      docs.push({
        sessionId: info.id,
        startedAt: info.startedAt,
        text,
        tokens,
        tokenSet: set,
        termFreq: tf,
      });
    } catch {
      // skip
    }
  }
  const idf = new Map<string, number>();
  const N = Math.max(1, docs.length);
  for (const [term, df] of docFreq) {
    idf.set(term, Math.log(1 + N / df));
  }
  return { docs, idf };
}

export interface SearchHit {
  sessionId: string;
  startedAt: string;
  score: number;
  excerpt: string;
}

export function search(index: Index, query: string, k = 5): SearchHit[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return [];
  const qFreq = new Map<string, number>();
  for (const t of qTokens) qFreq.set(t, (qFreq.get(t) ?? 0) + 1);
  const scored: { doc: Document; score: number }[] = [];
  for (const doc of index.docs) {
    let score = 0;
    for (const [term, qf] of qFreq) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const idf = index.idf.get(term) ?? 0;
      score += qf * tf * idf;
    }
    if (score > 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => ({
    sessionId: s.doc.sessionId,
    startedAt: s.doc.startedAt,
    score: s.score,
    excerpt: excerptAround(s.doc.text, qTokens, 200),
  }));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function excerptAround(
  text: string,
  qTokens: string[],
  width: number,
): string {
  const lower = text.toLowerCase();
  for (const t of qTokens) {
    const idx = lower.indexOf(t);
    if (idx >= 0) {
      const start = Math.max(0, idx - width / 2);
      const end = Math.min(text.length, idx + width / 2);
      return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
    }
  }
  return text.slice(0, width).replace(/\s+/g, " ").trim();
}

export const _unused_for_typecheck: typeof path | typeof fs | undefined = undefined;

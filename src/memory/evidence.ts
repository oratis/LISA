import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertHomeDirectory, openHomeFile } from "../home-files.js";
import { sessionsDir } from "../paths.js";
import { tailLines } from "../sessions/jsonl.js";
import { BASE_STOPWORDS, tokenize } from "../tokenize.js";
import type { StoredMessage } from "../types.js";

export interface MemoryEvidence {
  id: string;
  sessionId: string;
  at?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  /** UTF-16 offsets in the original text part; omitted for untruncated parts. */
  start?: number;
  end?: number;
}

export const EVIDENCE_CHAR_BUDGET = 24_000;
const MAX_SESSIONS = 6;
const MAX_MESSAGE_CHARS = 3_000;

export function evidenceHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertSessionId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error("invalid session id");
  return id;
}

/** Tool responses are observations, never relabelled as human preferences. */
function messageEvidence(message: StoredMessage, sessionId: string, at?: string): MemoryEvidence[] {
  if (message.role !== "user" && message.role !== "assistant") return [];
  const parts: { role: MemoryEvidence["role"]; text: string }[] = [];
  if (typeof message.content === "string") {
    parts.push({ role: message.role, text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text") parts.push({ role: message.role, text: block.text });
      if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? [])
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("\n");
        parts.push({ role: "tool", text });
      }
    }
  }
  return parts
    .filter((p) => {
      if (!p.text.trim()) return false;
      // The chat loop persists its own objection prompt and base64 attachment
      // envelopes as user text. This applies to existing JSONL as well as live history.
      if (p.role !== "user") return true;
      return (
        !p.text.startsWith(
          "[architecture] You raised the following objection(s) during this turn",
        ) &&
        !(p.text.startsWith("[Attached file: ") && p.text.includes(" — base64 data follows]\n"))
      );
    })
    .flatMap((p) =>
      p.text.length <= MAX_MESSAGE_CHARS
        ? [
            {
              id: evidenceHash([sessionId, at, p.role, p.text]).slice(0, 24),
              sessionId,
              at,
              role: p.role,
              text: p.text,
            },
          ]
        : [0, p.text.length - MAX_MESSAGE_CHARS / 2].map((start) => ({
            id: evidenceHash([sessionId, at, p.role, p.text, start]).slice(0, 24),
            sessionId,
            at,
            role: p.role,
            start,
            end: start + MAX_MESSAGE_CHARS / 2,
            // Preserve the end, where explicit corrections often appear. Separate
            // excerpts cannot be cited as a fictional contiguous quotation.
            text: p.text.slice(start, start + MAX_MESSAGE_CHARS / 2),
          })),
    );
}

function boundedEvidence(items: MemoryEvidence[], budget = EVIDENCE_CHAR_BUDGET): MemoryEvidence[] {
  const kept: MemoryEvidence[] = [];
  const seen = new Set<string>();
  let chars = 2;
  for (const item of items.toReversed()) {
    if (seen.has(item.id)) continue;
    // Include metadata/JSON escaping in the bound, not just the source text.
    const size = JSON.stringify(item).length + (kept.length ? 1 : 0);
    if (chars + size > budget) continue;
    chars += size;
    seen.add(item.id);
    kept.push(item);
  }
  return kept.reverse();
}

export function evidenceFromHistory(history: StoredMessage[], sessionId: string): MemoryEvidence[] {
  // Walk backwards and stop once enough evidence is available; never materialize
  // a second copy of an unbounded conversation just to truncate it afterwards.
  const out: MemoryEvidence[] = [];
  let size = 0;
  for (let i = history.length - 1; i >= 0 && size < EVIDENCE_CHAR_BUDGET * 2; i--) {
    const items = messageEvidence(history[i]!, sessionId);
    out.unshift(...items);
    size += JSON.stringify(items).length;
  }
  return boundedEvidence(out);
}

async function recentSessionIds(exclude?: string, maxStats?: number): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const recent: { id: string; mtime: number }[] = [];
  // Include old sessions that were resumed recently. Stat in small batches,
  // without scanning or parsing every transcript (unlike listSessionsOnDisk).
  let candidates = files.filter(
    (f) => f.slice(0, -6) !== exclude && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.jsonl$/.test(f),
  );
  // Reflection runs on every substantial session. In very large archives,
  // shortlist by the sortable creation stamp in native session filenames
  // before statting for recency. Explicit review keeps its full mtime search.
  if (maxStats && candidates.length > maxStats) candidates = candidates.sort().slice(-maxStats);
  for (let i = 0; i < candidates.length; i += 32) {
    const batch = await Promise.all(
      candidates.slice(i, i + 32).map(async (file) => {
        try {
          const st = await fs.lstat(path.join(sessionsDir(), file));
          return st.isFile() ? { id: file.slice(0, -6), mtime: st.mtimeMs } : null;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      }),
    );
    recent.push(...batch.filter((s) => s !== null));
    recent.sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id));
    recent.length = Math.min(recent.length, MAX_SESSIONS);
  }
  return recent.map((s) => s.id);
}

function transcriptEvidence(id: string, lines: string[], matchLiveIds = false): MemoryEvidence[] {
  const items: MemoryEvidence[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role))
        continue;
      const at = typeof entry.ts === "string" ? entry.ts : undefined;
      const parts = messageEvidence(entry.message, id, matchLiveIds ? undefined : at);
      if (matchLiveIds) for (const part of parts) part.at = at;
      items.push(...parts);
    } catch {
      /* A torn or malformed record is not evidence. */
    }
  }
  return items;
}

/** Bounded tails only: no prompt snapshots, reflection summaries or synthetic traces. */
export async function recentMemoryEvidence(sessionIds?: string[]): Promise<MemoryEvidence[]> {
  await assertHomeDirectory(sessionsDir());
  let ids: string[];
  if (sessionIds !== undefined) {
    if (!Array.isArray(sessionIds) || sessionIds.length > MAX_SESSIONS) {
      throw new Error(`choose at most ${MAX_SESSIONS} sessions`);
    }
    ids = [...new Set(sessionIds.map(assertSessionId))];
  } else {
    ids = await recentSessionIds();
  }
  const out: MemoryEvidence[] = [];
  for (const id of ids.toReversed()) {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    try {
      if (!(await fs.lstat(file)).isFile()) continue;
      const { lines } = await tailLines(file, 64 * 1024, openHomeFile);
      const items = transcriptEvidence(id, lines);
      // One busy conversation must not crowd every other session out.
      out.push(
        ...boundedEvidence(items, Math.floor(EVIDENCE_CHAR_BUDGET / Math.max(ids.length, 1))),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return boundedEvidence(out);
}

const RELATED_STOPWORDS = new Set([
  ...BASE_STOPWORDS,
  ..."my your me please can could would will use using keep have has had want now also all only".split(
    " ",
  ),
  ..."should about remember update record instead new old one just some still earlier previous last next what when".split(
    " ",
  ),
]);

/** Pin workspace metadata and user turns to the same opened file, even if the
 * session is concurrently replaced. Never follow a link to another home. */
async function sessionUserWindow(id: string, expectedCwd?: string) {
  let cwd = "";
  let start = NaN;
  const { lines } = await tailLines(
    path.join(sessionsDir(), assertSessionId(id) + ".jsonl"),
    32 * 1024,
    async (file) => {
      const handle = await openHomeFile(file);
      try {
        const head = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        const newline = head.subarray(0, bytesRead).indexOf(10);
        if (newline === -1) throw new Error("missing session header");
        const header = JSON.parse(head.subarray(0, newline).toString("utf8"));
        if (
          header.type !== "session" ||
          header.id !== id ||
          header.origin !== undefined ||
          typeof header.cwd !== "string" ||
          !path.isAbsolute(header.cwd) ||
          (expectedCwd !== undefined && header.cwd !== expectedCwd)
        )
          throw new Error("session outside reflection scope");
        cwd = header.cwd;
        start = Date.parse(header.startedAt);
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
  );
  const users = transcriptEvidence(id, lines, expectedCwd === undefined).filter(
    (item) => item.role === "user" && item.at && Date.parse(item.at) >= start,
  );
  return { cwd, users };
}

/** Find nearby source utterances for anaphora or corrections in the focused
 * conversation. An unpersisted/ambiguous focus has no reliable time boundary.
 * Unreadable history is optional context and must not block a reflection. */
export async function relatedSessionEvidence(
  current: MemoryEvidence[],
  sessionId: string,
): Promise<MemoryEvidence[]> {
  const focus = current.findLast((item) => item.role === "user" && item.sessionId === sessionId);
  const budget = Math.min(2200, EVIDENCE_CHAR_BUDGET - JSON.stringify(current).length);
  if (!focus || budget < 100) return [];
  const active = await sessionUserWindow(sessionId).catch(() => null);
  if (!active) return [];
  const anchors = active.users.filter((u) => u.id === focus.id);
  if (anchors.length !== 1) return [];
  const cutoff = Date.parse(anchors[0]!.at!);
  if (cutoff > Date.now()) return [];
  const words = new Set(tokenize(focus.text, RELATED_STOPWORDS));
  if (!words.size) return [];

  const sorted: { item: MemoryEvidence; score: number }[] = [];
  const ids = await recentSessionIds(sessionId, 128).catch(() => []);
  for (const id of ids) {
    const earlier = await sessionUserWindow(id, active.cwd).catch(() => null);
    for (const item of earlier?.users ?? []) {
      if (Date.parse(item.at!) >= cutoff) continue;
      const terms = new Set(tokenize(item.text, RELATED_STOPWORDS));
      const shared = [...terms].filter((term) => words.has(term));
      // Two topic words (including CJK bigrams), or a distinctive name/code.
      // Normalise by document length so a sprawling note does not crowd out
      // a short message which defines the actual item.
      if (!shared.length || (shared.length === 1 && shared[0]!.length < 4)) continue;
      const score = shared.length / Math.sqrt(terms.size);
      sorted.push({ item, score });
    }
  }
  sorted.sort((a, b) => b.score - a.score || Date.parse(b.item.at!) - Date.parse(a.item.at!));
  return boundedEvidence(
    sorted
      .slice(0, 3)
      .reverse()
      .map((s) => s.item),
    budget,
  );
}

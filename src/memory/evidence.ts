import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertHomeDirectory, openHomeFile } from "../home-files.js";
import { sessionsDir } from "../paths.js";
import { tailLines } from "../sessions/jsonl.js";
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
    const candidates = files.filter((f) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.jsonl$/.test(f));
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
    ids = recent.map((s) => s.id);
  }
  const out: MemoryEvidence[] = [];
  for (const id of ids.toReversed()) {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    try {
      if (!(await fs.lstat(file)).isFile()) continue;
      const { lines } = await tailLines(file, 64 * 1024, openHomeFile);
      const items: MemoryEvidence[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role))
            continue;
          items.push(
            ...messageEvidence(
              entry.message,
              id,
              typeof entry.ts === "string" ? entry.ts : undefined,
            ),
          );
        } catch {
          /* A torn or malformed record is not evidence. */
        }
      }
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

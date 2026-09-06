import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../paths.js";
import { appendLine, ensureDir } from "../fs-utils.js";
import { resolveSandboxMode, type SandboxMode } from "../sandbox/mode.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";
import { jsonlLines, tailLines } from "./jsonl.js";

/** Content hash of a system prompt — the identity of a `prompt` entry. */
export function promptFingerprint(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export class SessionStore {
  readonly id: string;
  readonly path: string;
  readonly header: SessionHeader;
  /**
   * Fingerprint of the last system prompt written to this file, so an
   * unchanged prompt isn't re-serialized on every turn (and a resumed session
   * doesn't duplicate the prompt it is still running with). Recovered on
   * open() from the file we already read.
   */
  private lastPromptFingerprint?: string;

  private constructor(
    id: string,
    file: string,
    header: SessionHeader,
    lastPromptFingerprint?: string,
  ) {
    this.id = id;
    this.path = file;
    this.header = header;
    this.lastPromptFingerprint = lastPromptFingerprint;
  }

  /**
   * Open an existing session. Streamed (T-5): only the header and the newest
   * prompt fingerprint are wanted, so a long conversation must not be
   * materialized as one string plus an array of every line to get them.
   */
  static async open(id: string): Promise<SessionStore> {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    let header: SessionHeader | null = null;
    let fingerprint: string | undefined;
    for await (const line of jsonlLines(file)) {
      if (!header) {
        header = JSON.parse(line) as SessionHeader;
        continue;
      }
      try {
        const entry = JSON.parse(line) as Partial<SessionEntry>;
        // Keep the LAST one seen — same answer as the old backwards scan.
        if (entry.type === "prompt" && "fingerprint" in entry) {
          fingerprint = entry.fingerprint as string;
        }
      } catch {
        // Skip a torn line rather than failing the whole open.
      }
    }
    if (!header) throw new Error(`session ${id} is empty`);
    return new SessionStore(id, file, header, fingerprint);
  }

  static async create(opts: {
    cwd: string;
    model: string;
    /** Overrides the environment-resolved mode (H2). */
    sandboxMode?: SandboxMode;
  }): Promise<SessionStore> {
    // Session logs now carry the full system prompt — soul, USER.md, MEMORY.md,
    // KB — the same sensitive user context the rest of ~/.lisa keeps private, so
    // hold them to the same 0600-in-0700 discipline as config.env / devices /
    // mail. append's mode only applies on create, so chmod after to tighten a
    // dir or file that predates this hardening.
    await ensureDir(sessionsDir());
    await fs.chmod(sessionsDir(), 0o700).catch(() => {});
    const id = `${stamp()}-${crypto.randomBytes(3).toString("hex")}`;
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      id,
      version: 2,
      startedAt: new Date().toISOString(),
      cwd: opts.cwd,
      model: opts.model,
      // Resolved once, here. A session carries the posture it was created
      // under, so editing a setting cannot widen what a task already running
      // under the old one is permitted to do.
      sandboxMode: resolveSandboxMode(opts.sandboxMode),
    };
    await appendLine(file, JSON.stringify(header));
    await fs.chmod(file, 0o600).catch(() => {});
    return new SessionStore(id, file, header);
  }

  /**
   * Record the system prompt the model is about to see (H3). No-op when the
   * text is byte-identical to the last one written — "the prompt in effect at
   * entry N" is therefore the nearest preceding prompt entry, and a long chat
   * that never self-modifies costs exactly one entry.
   *
   * Returns whether an entry was actually appended (tests and telemetry care;
   * callers generally don't).
   */
  async appendPrompt(
    text: string,
    reason: "initial" | "rebuilt",
  ): Promise<boolean> {
    const fingerprint = promptFingerprint(text);
    if (fingerprint === this.lastPromptFingerprint) return false;
    const entry: SessionEntry = {
      type: "prompt",
      ts: new Date().toISOString(),
      fingerprint,
      text,
      reason,
    };
    await appendLine(this.path, JSON.stringify(entry));
    this.lastPromptFingerprint = fingerprint;
    return true;
  }

  async appendMessage(message: StoredMessage): Promise<void> {
    const entry: SessionEntry = {
      type: "message",
      ts: new Date().toISOString(),
      message,
    };
    await appendLine(this.path, JSON.stringify(entry));
  }

  async appendReflection(summary: string): Promise<void> {
    const entry: SessionEntry = {
      type: "reflection",
      ts: new Date().toISOString(),
      summary,
    };
    await appendLine(this.path, JSON.stringify(entry));
  }

  /**
   * The newest durable reflection. Reflections are appended, so the answer is
   * almost always inside the last few KB — read a bounded tail first and only
   * fall back to a streamed full scan when the tail didn't cover the file and
   * held no reflection (T-5).
   */
  async readLatestReflection(): Promise<string | undefined> {
    const summaryOf = (line: string): string | undefined => {
      try {
        const entry = JSON.parse(line) as Partial<SessionEntry>;
        if (entry.type === "reflection" && "summary" in entry && typeof entry.summary === "string") {
          return entry.summary;
        }
      } catch {
        // Skip a corrupt line and keep searching older durable reflections.
      }
      return undefined;
    };

    let tail: { lines: string[]; complete: boolean };
    try {
      tail = await tailLines(this.path);
    } catch {
      return undefined;
    }
    for (let i = tail.lines.length - 1; i >= 0; i--) {
      // The header is line 0 only when the tail covers the whole file; it can
      // never parse as a reflection, so no special-casing is needed.
      const found = summaryOf(tail.lines[i]!);
      if (found !== undefined) return found;
    }
    if (tail.complete) return undefined;

    let latest: string | undefined;
    for await (const line of jsonlLines(this.path)) {
      const found = summaryOf(line);
      if (found !== undefined) latest = found;
    }
    return latest;
  }

  /**
   * Read a page of message entries (newest-first within the page).
   * page=0 = latest PAGE_SIZE messages, page=1 = older ones, etc.
   */
  async readMessagePage(
    page: number,
    pageSize = 20,
  ): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
    // Streamed with a bounded ring (T-5). The page is taken from the END, so
    // only the newest (page+1)*pageSize message lines can ever be needed:
    // keep exactly that many and drop the rest as we go, instead of building
    // an array of every line in the file and slicing it.
    const keep = Math.max(0, (page + 1) * pageSize);
    if (keep === 0) return { messages: [], hasMore: false };
    const ring: StoredMessage[] = [];
    let total = 0;
    let first = true;
    for await (const line of jsonlLines(this.path)) {
      if (first) {
        first = false;
        continue; // header
      }
      let entry: { type?: string; message?: StoredMessage };
      try {
        entry = JSON.parse(line) as { type?: string; message?: StoredMessage };
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      total++;
      ring.push(entry.message);
      if (ring.length > keep) ring.shift();
    }
    const end = total - page * pageSize;
    if (end <= 0) return { messages: [], hasMore: false };
    const start = Math.max(0, end - pageSize);
    // `ring` holds the last `keep` messages, i.e. indices [total-ring.length, total).
    const base = total - ring.length;
    return { messages: ring.slice(start - base, end - base), hasMore: start > 0 };
  }
}

/** Last `prompt` entry's fingerprint in an already-read session file, if any. */
function lastPromptFingerprintIn(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 1; index--) {
    try {
      const entry = JSON.parse(lines[index]!) as Partial<SessionEntry>;
      if (entry.type === "prompt" && "fingerprint" in entry) {
        return entry.fingerprint;
      }
    } catch {
      // Skip a corrupt line and keep scanning backwards.
    }
  }
  return undefined;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

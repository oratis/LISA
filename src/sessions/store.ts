import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../paths.js";
import { appendLine, ensureDir } from "../fs-utils.js";
import { resolveSandboxMode, type SandboxMode } from "../sandbox/mode.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";

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

  static async open(id: string): Promise<SessionStore> {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error(`session ${id} is empty`);
    const header = JSON.parse(lines[0]!) as SessionHeader;
    return new SessionStore(id, file, header, lastPromptFingerprintIn(lines));
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

  async readLatestReflection(): Promise<string | undefined> {
    const raw = await fs.readFile(this.path, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(1);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const entry = JSON.parse(lines[index]!) as Partial<SessionEntry>;
        if (
          entry.type === "reflection" &&
          "summary" in entry &&
          typeof entry.summary === "string"
        ) {
          return entry.summary;
        }
      } catch {
        // Skip a corrupt line and keep searching older durable reflections.
      }
    }
    return undefined;
  }

  /**
   * Read a page of message entries (newest-first within the page).
   * page=0 = latest PAGE_SIZE messages, page=1 = older ones, etc.
   */
  async readMessagePage(
    page: number,
    pageSize = 20,
  ): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
    const raw = await fs.readFile(this.path, "utf8");
    const lines = raw.split("\n").filter(Boolean).slice(1); // skip header
    const msgLines = lines.filter((l) => {
      try { return JSON.parse(l).type === "message"; } catch { return false; }
    });
    const total = msgLines.length;
    // newest page first: take from the end
    const end = total - page * pageSize;
    const start = Math.max(0, end - pageSize);
    if (end <= 0) return { messages: [], hasMore: false };
    const slice = msgLines.slice(start, end);
    const messages = slice.map((l) => (JSON.parse(l) as { type: "message"; message: StoredMessage }).message);
    return { messages, hasMore: start > 0 };
  }
}

/** Last `prompt` entry's fingerprint in an already-read session file, if any. */
function lastPromptFingerprintIn(lines: string[]): string | undefined {
  for (let index = lines.length - 1; index >= 1; index--) {
    try {
      const entry = JSON.parse(lines[index]!) as Partial<SessionEntry>;
      if (entry.type === "prompt" && "fingerprint" in entry) {
        return entry.fingerprint as string;
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

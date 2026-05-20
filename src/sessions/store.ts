import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { SESSIONS_DIR } from "../paths.js";
import { appendLine, ensureDir } from "../fs-utils.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";

export class SessionStore {
  readonly id: string;
  readonly path: string;
  readonly header: SessionHeader;

  private constructor(id: string, file: string, header: SessionHeader) {
    this.id = id;
    this.path = file;
    this.header = header;
  }

  static async open(id: string): Promise<SessionStore> {
    const file = path.join(SESSIONS_DIR, `${id}.jsonl`);
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error(`session ${id} is empty`);
    const header = JSON.parse(lines[0]!) as SessionHeader;
    return new SessionStore(id, file, header);
  }

  static async create(opts: {
    cwd: string;
    model: string;
  }): Promise<SessionStore> {
    await ensureDir(SESSIONS_DIR);
    const id = `${stamp()}-${crypto.randomBytes(3).toString("hex")}`;
    const file = path.join(SESSIONS_DIR, `${id}.jsonl`);
    const header: SessionHeader = {
      type: "session",
      id,
      version: 1,
      startedAt: new Date().toISOString(),
      cwd: opts.cwd,
      model: opts.model,
    };
    await appendLine(file, JSON.stringify(header));
    return new SessionStore(id, file, header);
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

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

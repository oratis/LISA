import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../paths.js";
import { appendLine, ensureDir } from "../fs-utils.js";
import { resolveSandboxMode, type SandboxMode } from "../sandbox/mode.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";
import {
  resolveExpression,
  expressionText,
  type ExpressionRecord,
  type Expression,
} from "../expressions/catalog.js";
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
          fingerprint = entry.fingerprint;
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
  async appendPrompt(text: string, reason: "initial" | "rebuilt"): Promise<boolean> {
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

  async appendExpression(record: ExpressionRecord): Promise<StoredMessage> {
    const expression = resolveExpression(record);
    if (!expression) throw new Error("Invalid expression");
    const message: StoredMessage = { role: "assistant", content: expressionText(expression) };
    // A single ordinary message record preserves a textual transcript for old
    // clients and model providers; UI metadata never enters provider content.
    await appendLine(
      this.path,
      JSON.stringify({
        type: "message",
        ts: new Date().toISOString(),
        message,
        expression: record,
      }),
    );
    return message;
  }

  /** Cadence only needs three turns. Read the bounded tail first on long chats. */
  async turnsSinceExpression(): Promise<number> {
    const parse = (line: string): SessionEntry | undefined => {
      try {
        return JSON.parse(line) as SessionEntry;
      } catch {
        return;
      }
    };
    const isUser = (message: StoredMessage) =>
      message.role === "user" &&
      (typeof message.content === "string" ||
        (Array.isArray(message.content) && message.content.some((b) => b.type !== "tool_result")));
    const tail = await tailLines(this.path);
    let distance = 0;
    for (const line of tail.lines.reverse()) {
      const entry = parse(line);
      if (entry?.type !== "message" || !entry.message) continue;
      if (resolveExpression(entry.expression)) return distance;
      if (isUser(entry.message) && ++distance >= 3) return 3;
    }
    if (tail.complete) return Infinity;
    // An oversized attachment/tool result can hide the recent expression from
    // the tail. Stream instead of treating that missing evidence as permission.
    distance = Infinity;
    for await (const line of jsonlLines(this.path)) {
      const entry = parse(line);
      if (entry?.type !== "message" || !entry.message) continue;
      if (resolveExpression(entry.expression)) distance = 0;
      else if (isUser(entry.message)) distance++;
    }
    return distance;
  }

  /** Called within the session turn queue and the connector's cross-process lease. */
  async hasConnectorResult(id: string): Promise<boolean> {
    for await (const line of jsonlLines(this.path)) {
      try {
        const entry = JSON.parse(line) as Partial<SessionEntry>;
        if (entry.type === "message" && entry.connectorRequestId === id) return true;
      } catch {
        /* A torn append has no committed result. */
      }
    }
    return false;
  }

  /** Diagnostic transcript, separate from visible chat and never treated as user authorization. */
  async appendConnectorTrace(requestId: string, message: StoredMessage): Promise<void> {
    const entry: SessionEntry = {
      type: "connector_trace",
      ts: new Date().toISOString(),
      requestId,
      message,
    };
    await appendLine(this.path, JSON.stringify(entry));
  }

  async appendConnectorResult(id: string, message: StoredMessage): Promise<boolean> {
    if (await this.hasConnectorResult(id)) return false;
    // One durable JSONL record carries both the visible result and its idempotency key.
    // Prefixing a newline also isolates an interrupted previous append.
    const file = await fs.open(this.path, "a", 0o600);
    try {
      await file.writeFile(
        "\n" +
          JSON.stringify({
            type: "message",
            ts: new Date().toISOString(),
            message,
            connectorRequestId: id,
          }) +
          "\n",
      );
      await file.sync();
    } finally {
      await file.close();
    }
    return true;
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
   *
   * `includeExpressions` asks for the client view (/api/history): resolved
   * expression metadata, and no `reply_expression` tool_use blocks — clients
   * that list tool names (Lisa Pocket 1.3) would otherwise show a chip for an
   * internal tool. The model view (default) is the transcript as stored.
   */
  async readMessagePage(
    page: number,
    pageSize = 20,
    includeExpressions = false,
  ): Promise<{ messages: (StoredMessage & { expression?: Expression })[]; hasMore: boolean }> {
    // Streamed with a bounded ring (T-5). The page is taken from the END, so
    // only the newest (page+1)*pageSize message lines can ever be needed:
    // keep exactly that many and drop the rest as we go, instead of building
    // an array of every line in the file and slicing it.
    const keep = Math.max(0, (page + 1) * pageSize);
    if (keep === 0) return { messages: [], hasMore: false };
    const ring: (StoredMessage & { expression?: Expression })[] = [];
    let total = 0;
    let first = true;
    for await (const line of jsonlLines(this.path)) {
      if (first) {
        first = false;
        continue; // header
      }
      let entry: { type?: string; message?: StoredMessage; expression?: ExpressionRecord };
      try {
        entry = JSON.parse(line) as {
          type?: string;
          message?: StoredMessage;
          expression?: ExpressionRecord;
        };
      } catch {
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      total++;
      if (includeExpressions) {
        const expression = resolveExpression(entry.expression);
        const message = withoutExpressionToolUse(entry.message);
        ring.push(expression ? { ...message, expression } : message);
      } else ring.push(entry.message);
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

function withoutExpressionToolUse(message: StoredMessage): StoredMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
  const content = message.content.filter(
    (block) => !(block.type === "tool_use" && block.name === "reply_expression"),
  );
  return content.length === message.content.length ? message : { ...message, content };
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

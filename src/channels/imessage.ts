import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { registerChannel } from "./registry.js";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
} from "./types.js";

const CHAT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");

export class IMessageChannel implements ChannelAdapter {
  readonly name = "imessage";
  private timer?: NodeJS.Timeout;
  private lastRowId = 0;
  private handler?: (msg: IncomingMessage) => Promise<void>;
  private polling = false;
  private intervalMs: number;

  constructor(opts: { intervalMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 5_000;
  }

  async start(handler: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    try {
      await fs.access(CHAT_DB);
    } catch {
      throw new Error(
        "iMessage chat.db not accessible. Grant Full Disk Access to your terminal in System Settings → Privacy.",
      );
    }
    this.handler = handler;
    this.lastRowId = await this.maxRowId();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const messages = await this.fetchSince(this.lastRowId);
      for (const msg of messages) {
        if (msg.rowId > this.lastRowId) this.lastRowId = msg.rowId;
        if (msg.fromMe) continue;
        await this.handler?.({
          channel: this.name,
          from: msg.handle ?? "unknown",
          text: msg.text,
          threadId: msg.threadId,
          receivedAt: new Date(),
        });
      }
    } catch (err) {
      console.error(`[imessage] poll error: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const recipient = msg.to.replace(/"/g, '\\"');
    const text = msg.text.replace(/"/g, '\\"');
    const script = `tell application "Messages"
  set targetService to first service whose service type = iMessage
  set targetBuddy to buddy "${recipient}" of targetService
  send "${text}" to targetBuddy
end tell`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", script]);
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`osascript exited ${code}: ${stderr.trim()}`)),
      );
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  private async maxRowId(): Promise<number> {
    const out = await this.runSqlite("SELECT MAX(ROWID) FROM message;");
    const n = parseInt(out.trim(), 10);
    return isNaN(n) ? 0 : n;
  }

  private async fetchSince(rowId: number): Promise<
    {
      rowId: number;
      handle: string | null;
      text: string;
      fromMe: boolean;
      threadId: string;
    }[]
  > {
    const sql = `SELECT m.ROWID, h.id, m.text, m.is_from_me, m.cache_roomnames
                 FROM message m
                 LEFT JOIN handle h ON m.handle_id = h.ROWID
                 WHERE m.ROWID > ${rowId} AND m.text IS NOT NULL
                 ORDER BY m.ROWID ASC LIMIT 50;`;
    const out = await this.runSqlite(sql);
    const rows: ReturnType<IMessageChannel["fetchSince"]> extends Promise<infer R>
      ? R
      : never = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length < 5) continue;
      rows.push({
        rowId: parseInt(parts[0]!, 10),
        handle: parts[1] || null,
        text: parts[2] ?? "",
        fromMe: parts[3] === "1",
        threadId: parts[4] ?? "",
      });
    }
    return rows;
  }

  private async runSqlite(sql: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("sqlite3", ["-readonly", CHAT_DB, sql]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b.toString("utf8")));
      child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(stdout)
          : reject(new Error(`sqlite3 exited ${code}: ${stderr.trim()}`)),
      );
    });
  }
}

registerChannel("imessage", (cfg) => {
  const intervalMs = typeof cfg.intervalMs === "number" ? cfg.intervalMs : undefined;
  return new IMessageChannel(intervalMs ? { intervalMs } : {});
});

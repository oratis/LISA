import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { codexSessionsRoot } from "./observation.js";

// Codex appends renames to its index. Keep the last title per thread and
// invalidate on replacement as well as append. Called only for the local
// owner's roster; titles can contain text from a user's first message.
export class CodexTitles {
  private version = "";
  private names = new Map<string, string>();

  async read(home?: string): Promise<ReadonlyMap<string, string>> {
    const file = path.join(codexSessionsRoot(home), "..", "session_index.jsonl");
    try {
      const stat = await fs.stat(file);
      const version = [file, stat.ino, stat.size, stat.mtimeMs].join(":");
      if (version === this.version) return this.names;
      const names = new Map<string, string>();
      const fd = await fs.open(file, "r");
      try {
        const lines = readline.createInterface({
          input: fd.createReadStream({ autoClose: false }),
          crlfDelay: Infinity,
        });
        for await (const line of lines) {
          try {
            const row = JSON.parse(line);
            if (typeof row?.id !== "string" || typeof row.thread_name !== "string") continue;
            const title = row.thread_name.replace(/\s+/gu, " ").trim().slice(0, 160);
            if (title) names.set(row.id, title);
          } catch {
            /* A partially written row is retried on the next append. */
          }
        }
      } finally {
        await fd.close();
      }
      this.version = version;
      this.names = names;
      return names;
    } catch {
      return new Map();
    }
  }
}

export function codexTitleKey(sessionId: string): string {
  return sessionId.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i)?.[0] ?? sessionId;
}

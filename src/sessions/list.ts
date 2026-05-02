import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_DIR } from "../paths.js";
import { ensureDir, pathExists } from "../fs-utils.js";
import type { SessionEntry, SessionHeader, StoredMessage } from "../types.js";

export interface SessionInfo {
  id: string;
  path: string;
  startedAt: string;
  cwd: string;
  model: string;
  messageCount: number;
  lastUserMessage?: string;
}

export async function listSessionsOnDisk(): Promise<SessionInfo[]> {
  await ensureDir(SESSIONS_DIR);
  const files = await fs.readdir(SESSIONS_DIR);
  const out: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const full = path.join(SESSIONS_DIR, file);
    try {
      const info = await summarize(full);
      if (info) out.push(info);
    } catch {
      // skip corrupt sessions
    }
  }
  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

async function summarize(file: string): Promise<SessionInfo | null> {
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  const header = JSON.parse(lines[0]!) as SessionHeader;
  let messageCount = 0;
  let lastUser: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]!) as SessionEntry;
    if (entry.type !== "message") continue;
    messageCount++;
    if (entry.message.role === "user") {
      const text = textOf(entry.message);
      if (text) lastUser = text;
    }
  }
  return {
    id: header.id,
    path: file,
    startedAt: header.startedAt,
    cwd: header.cwd,
    model: header.model,
    messageCount,
    lastUserMessage: lastUser?.slice(0, 80),
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
  const file = path.join(SESSIONS_DIR, `${id}.jsonl`);
  if (!(await pathExists(file))) {
    throw new Error(`session ${id} not found at ${file}`);
  }
  const raw = await fs.readFile(file, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const header = JSON.parse(lines[0]!) as SessionHeader;
  const messages: StoredMessage[] = [];
  for (let i = 1; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]!) as SessionEntry;
    if (entry.type === "message") messages.push(entry.message);
  }
  return { header, messages };
}

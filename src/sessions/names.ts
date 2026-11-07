import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../paths.js";

/** Display names belong to LISA; external agents' transcripts stay untouched. */
export interface SessionName {
  kind: string;
  id: string;
  name: string;
}

export class InvalidSessionNameError extends Error {}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function parseSessionName(value: Record<string, unknown>): SessionName {
  const { kind, id, name } = value;
  if (
    typeof kind !== "string" ||
    !/^(lisa|agent\/[a-z][a-z0-9-]{0,39})$/.test(kind) ||
    typeof id !== "string" ||
    !id ||
    id.length > 256 ||
    hasControlCharacters(id) ||
    (kind === "lisa" && !/^[A-Za-z0-9_-]+$/.test(id)) ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    hasControlCharacters(name)
  )
    throw new InvalidSessionNameError("invalid_session_name");
  return { kind, id, name: name.trim() };
}

export async function listSessionNames(): Promise<SessionName[]> {
  const dir = path.join(sessionsDir(), "names");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names: SessionName[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    try {
      names.push(parseSessionName(JSON.parse(await fs.readFile(path.join(dir, file), "utf8"))));
    } catch {
      /* A damaged name must not hide the other sessions. */
    }
  }
  return names;
}

export async function saveSessionName(value: Record<string, unknown>): Promise<SessionName> {
  const entry = parseSessionName(value);
  if (entry.kind === "lisa") {
    await fs.access(path.join(sessionsDir(), `${entry.id}.jsonl`));
  }
  const dir = path.join(sessionsDir(), "names");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify([entry.kind, entry.id]))
    .digest("hex");
  const file = path.join(dir, `${key}.json`);
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(entry) + "\n", { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return entry;
}

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sessionsDir } from "../paths.js";

/** Display names belong to LISA; external agents' transcripts stay untouched. */
export interface SessionName {
  kind: string;
  id: string;
  name: string;
  /**
   * Milliseconds, strictly increasing per Lisa process. Windows apply a name
   * only when it is newer than the one they show, so a slow POST response
   * cannot undo a later rename that already arrived over the event stream.
   */
  updatedAt: number;
}

export class InvalidSessionNameError extends Error {}
export class SessionNameLimitError extends Error {}

/**
 * Names for external agent sessions are not checked against a transcript, so
 * the count per home is bounded instead (a client could otherwise fill the
 * disk one small file at a time).
 */
export const MAX_SESSION_NAMES = 5000;

function hasControlCharacters(value: string): boolean {
  // C0/DEL, plus the bidirectional embedding/override/isolate controls, which
  // would let a name visually reorder the text displayed after it.
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

export function parseSessionName(value: Record<string, unknown>): Omit<SessionName, "updatedAt"> {
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
      const stored = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
      const updatedAt = Number.isSafeInteger(stored?.updatedAt) ? stored.updatedAt : 0;
      names.push({ ...parseSessionName(stored), updatedAt });
    } catch {
      /* A damaged name must not hide the other sessions. */
    }
  }
  return names;
}

let lastUpdatedAt = 0;
let writes: Promise<unknown> = Promise.resolve();

export async function saveSessionName(value: Record<string, unknown>): Promise<SessionName> {
  const parsed = parseSessionName(value);
  // Resolve the (possibly tenant-scoped) directory now, inside the caller's
  // home scope, then write one name at a time: the order names reach disk
  // is the order their updatedAt values were issued and broadcast.
  const sessions = sessionsDir();
  const run = writes.then(() => writeSessionName(sessions, parsed));
  writes = run.catch(() => undefined);
  return run;
}

async function writeSessionName(
  sessions: string,
  parsed: Omit<SessionName, "updatedAt">,
): Promise<SessionName> {
  if (parsed.kind === "lisa") {
    await fs.access(path.join(sessions, `${parsed.id}.jsonl`));
  }
  const dir = path.join(sessions, "names");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify([parsed.kind, parsed.id]))
    .digest("hex");
  const file = path.join(dir, `${key}.json`);
  const exists = await fs.access(file).then(
    () => true,
    () => false,
  );
  if (!exists) {
    const count = (await fs.readdir(dir)).filter((f) => /^[a-f0-9]{64}\.json$/.test(f)).length;
    if (count >= MAX_SESSION_NAMES) throw new SessionNameLimitError("too_many_session_names");
  }
  lastUpdatedAt = Math.max(Date.now(), lastUpdatedAt + 1);
  const entry: SessionName = { ...parsed, updatedAt: lastUpdatedAt };
  const temp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(entry) + "\n", { mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
  return entry;
}

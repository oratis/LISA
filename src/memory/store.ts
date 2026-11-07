import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../fs-utils.js";
import { assertHomeDirectory, readHomeTextOrEmpty } from "../home-files.js";
import { memoryDir, memoryFile, userFile } from "../paths.js";
import { withFileLock } from "../soul/lock.js";

export type MemoryStore = "memory" | "user";

export const MEMORY_MAX_BYTES: Record<MemoryStore, number> = {
  memory: 4096,
  user: 2048,
};

/** Byte cap of each store (MEMORY.md ≤ 4 KB, USER.md ≤ 2 KB). */
export function memoryMaxBytes(store: MemoryStore): number {
  return MEMORY_MAX_BYTES[store];
}

function fileFor(store: MemoryStore): string {
  if (store !== "memory" && store !== "user") throw new Error("invalid memory store");
  return store === "memory" ? memoryFile() : userFile();
}

/** Absolute path of a store's file in the ACTIVE home (tenant-scoped). */
export function memoryStoreFile(store: MemoryStore): string {
  return fileFor(store);
}

/**
 * The one write-lock for MEMORY.md + USER.md read-modify-writes. The memory
 * tool (append/replace/remove below), the user-facing entries API and
 * "forget" all take it, so a chat turn and a user edit can't interleave and
 * lose an entry. A FUNCTION of the active home (paths.ts doctrine).
 */
export function memoryLockPath(): string {
  return path.join(memoryDir(), ".write.lock");
}

export async function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  await assertHomeDirectory(memoryDir());
  return withFileLock(memoryLockPath(), fn, { timeoutMs: 10_000, staleMs: 30_000 });
}

export async function readMemory(store: MemoryStore): Promise<string> {
  return await readHomeTextOrEmpty(fileFor(store));
}

export class MemoryCapacityError extends RangeError {}

/** Compare against the old byte count so an oversized legacy file can always shrink. */
export function assertMemoryFits(store: MemoryStore, content: string, previousBytes = 0): void {
  fileFor(store);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MEMORY_MAX_BYTES[store] && bytes > previousBytes) {
    throw new MemoryCapacityError(
      `memory "${store}" exceeds ${MEMORY_MAX_BYTES[store]} bytes. Trim or split entries.`,
    );
  }
}

export function normalizeMemory(store: MemoryStore, content: string, previousBytes = 0): string {
  const normalized = content.replace(/\s+$/g, "") + "\n";
  assertMemoryFits(store, normalized, previousBytes);
  return normalized;
}

/** Callers hold the shared lock, including direct entry edits, import and reviewed writes. */
export async function writeMemoryUnlocked(
  store: MemoryStore,
  content: string,
  format: "edit" | "snapshot" = "edit",
): Promise<void> {
  const file = fileFor(store);
  await assertHomeDirectory(path.dirname(file));
  const stat = await fs.lstat(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return null;
  });
  if (stat && !stat.isFile()) throw new Error("unsafe memory file");
  if (format === "snapshot") {
    assertMemoryFits(store, content);
    await atomicWrite(file, content);
  } else {
    await atomicWrite(file, normalizeMemory(store, content, stat?.size ?? 0));
  }
}

export async function writeMemory(store: MemoryStore, content: string): Promise<void> {
  await withMemoryLock(() => writeMemoryUnlocked(store, content));
}

export async function mutateMemory(
  store: MemoryStore,
  update: (before: string) => string | Promise<string>,
): Promise<void> {
  await withMemoryLock(async () => {
    const before = await readMemory(store);
    const next = await update(before);
    if (next !== before) await writeMemoryUnlocked(store, next);
  });
}

export async function appendMemory(store: MemoryStore, entry: string): Promise<void> {
  if (!entry.trim()) throw new Error("memory entry must not be empty");
  await mutateMemory(store, (current) => {
    const text = entry.trim();
    const bullet = text.startsWith("- ") ? text : `- ${text}`;
    if (current.split(/\r?\n/).some((line) => line.trim() === bullet)) return current;
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    return `${current}${sep}${bullet}`;
  });
}

export async function replaceInMemory(
  store: MemoryStore,
  oldString: string,
  newString: string,
): Promise<void> {
  if (!oldString) throw new Error("old_string must not be empty");
  await mutateMemory(store, (current) => {
    if (!current.includes(oldString)) {
      throw new Error(`old_string not found in ${store} memory`);
    }
    const occurrences = current.split(oldString).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `old_string matches ${occurrences} places in ${store} memory. Add more context.`,
      );
    }
    // A replacement callback preserves literal $&, $` and $' in model output.
    return current.replace(oldString, () => newString);
  });
}

export async function removeFromMemory(store: MemoryStore, fragment: string): Promise<void> {
  if (!fragment.trim()) throw new Error("fragment must not be empty");
  await mutateMemory(store, (current) => {
    const lines = current.split(/\r?\n/);
    const kept = lines.filter((line) => !line.includes(fragment));
    if (kept.length === lines.length) {
      throw new Error(`fragment not found in ${store} memory`);
    }
    return kept.join("\n");
  });
}

/** Manual/legacy files can exceed write limits; bound the injected layer too. */
export function memoryForPrompt(store: MemoryStore, text: string): string {
  const limit = MEMORY_MAX_BYTES[store];
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  const suffix = "\n… (truncated — use memory read)";
  let result = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const char of text) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > limit) break;
    result += char;
  }
  return result + suffix;
}

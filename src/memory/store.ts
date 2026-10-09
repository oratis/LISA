import path from "node:path";
import { atomicWrite, ensureDir, readTextOrEmpty } from "../fs-utils.js";
import { memoryDir, memoryFile, userFile } from "../paths.js";
import { withFileLock } from "../soul/lock.js";

export type MemoryStore = "memory" | "user";

const MAX_BYTES: Record<MemoryStore, number> = {
  memory: 4096,
  user: 2048,
};

/** Byte cap of each store (MEMORY.md ≤ 4 KB, USER.md ≤ 2 KB). */
export function memoryMaxBytes(store: MemoryStore): number {
  return MAX_BYTES[store];
}

function fileFor(store: MemoryStore): string {
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

export function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFileLock(memoryLockPath(), fn, { timeoutMs: 10_000, staleMs: 30_000 });
}

export async function readMemory(store: MemoryStore): Promise<string> {
  return await readTextOrEmpty(fileFor(store));
}

export async function writeMemory(
  store: MemoryStore,
  content: string,
): Promise<void> {
  await ensureDir(memoryDir());
  const trimmed = content.replace(/\s+$/g, "") + "\n";
  if (Buffer.byteLength(trimmed, "utf8") > MAX_BYTES[store]) {
    throw new Error(
      `memory "${store}" exceeds ${MAX_BYTES[store]} bytes. Trim or split entries.`,
    );
  }
  await atomicWrite(fileFor(store), trimmed);
}

export async function appendMemory(
  store: MemoryStore,
  entry: string,
): Promise<void> {
  await withMemoryLock(async () => {
    const current = await readMemory(store);
    const sep = current && !current.endsWith("\n") ? "\n" : "";
    await writeMemory(store, `${current}${sep}- ${entry.trim()}`);
  });
}

export async function replaceInMemory(
  store: MemoryStore,
  oldString: string,
  newString: string,
): Promise<void> {
  await withMemoryLock(() => replaceInMemoryUnlocked(store, oldString, newString));
}

async function replaceInMemoryUnlocked(
  store: MemoryStore,
  oldString: string,
  newString: string,
): Promise<void> {
  const current = await readMemory(store);
  if (!current.includes(oldString)) {
    throw new Error(`old_string not found in ${store} memory`);
  }
  const occurrences = current.split(oldString).length - 1;
  if (occurrences > 1) {
    throw new Error(
      `old_string matches ${occurrences} places in ${store} memory. Add more context.`,
    );
  }
  await writeMemory(store, current.replace(oldString, newString));
}

export async function removeFromMemory(
  store: MemoryStore,
  fragment: string,
): Promise<void> {
  await withMemoryLock(() => removeFromMemoryUnlocked(store, fragment));
}

async function removeFromMemoryUnlocked(store: MemoryStore, fragment: string): Promise<void> {
  const current = await readMemory(store);
  const lines = current.split(/\r?\n/);
  const kept = lines.filter((line) => !line.includes(fragment));
  if (kept.length === lines.length) {
    throw new Error(`fragment not found in ${store} memory`);
  }
  await writeMemory(store, kept.join("\n"));
}

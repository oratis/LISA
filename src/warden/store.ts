/**
 * Shared persistence helpers for Warden state under `<home>/warden/`.
 *
 * `home` is always passed explicitly. `lisaHome()` is AsyncLocalStorage-scoped
 * to the request (src/paths.ts), and Warden also runs from timers (approval
 * expiry) that fire outside any request scope — capturing the home when the
 * session or inbox item is created is what keeps a tenant's state in that
 * tenant's subtree.
 */
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { lisaHome } from "../paths.js";
import { logWarn } from "../log.js";

export function wardenDir(home: string = lisaHome()): string {
  return path.join(home, "warden");
}

export type ReadState<T> =
  { state: "missing" } | { state: "ok"; value: T } | { state: "corrupt"; error: string };

/**
 * Read and validate a JSON state file. Only ENOENT is "missing"; an unreadable,
 * unparseable or schema-invalid file is "corrupt" and the caller decides the
 * fail-closed fallback. It is never silently treated as empty-and-fine.
 */
export async function readJsonState<T>(
  file: string,
  validate: (value: unknown) => T | null,
): Promise<ReadState<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "corrupt", error: (err as Error).message };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "corrupt", error: `invalid JSON: ${(err as Error).message}` };
  }
  const value = validate(parsed);
  if (value === null) return { state: "corrupt", error: "schema validation failed" };
  return { state: "ok", value };
}

/** Atomic, owner-only write (tmp file + rename). */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Set a corrupt file aside so the next write does not destroy the evidence. */
export async function quarantineCorrupt(file: string, error: string): Promise<void> {
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    await fs.rename(file, aside);
    logWarn(
      `[warden] ${path.basename(file)} is corrupt (${error}); moved to ${path.basename(aside)}`,
    );
  } catch {
    logWarn(`[warden] ${path.basename(file)} is corrupt (${error}); could not move it aside`);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

const digestKeys = new Map<string, Promise<Buffer>>();

/**
 * The per-home key the payload digest is an HMAC under, at
 * `<home>/warden/digest.key` (0600). Created on first use. If the key cannot
 * be read or created this REJECTS — the caller then has no digest and must not
 * decide anything.
 */
export function loadDigestKey(home?: string): Promise<Buffer> {
  const file = path.join(wardenDir(home), "digest.key");
  let pending = digestKeys.get(file);
  if (!pending) {
    pending = readOrCreateDigestKey(file);
    digestKeys.set(file, pending);
    pending.catch(() => digestKeys.delete(file));
  }
  return pending;
}

function parseDigestKey(raw: string): Buffer {
  const text = raw.trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error("warden digest key is malformed");
  return Buffer.from(text, "hex");
}

/**
 * The same key, for a check that must not create anything (verifying a task
 * confirmation on load, which also runs for a home that is being deleted):
 * null when there is no key yet. Rejects on an unreadable or malformed file.
 */
export async function readDigestKey(home?: string): Promise<Buffer | null> {
  const file = path.join(wardenDir(home), "digest.key");
  const pending = digestKeys.get(file);
  if (pending) return await pending;
  try {
    return parseDigestKey(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function readOrCreateDigestKey(file: string): Promise<Buffer> {
  const parse = parseDigestKey;
  try {
    return parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32);
  try {
    // "wx": never overwrite a key another process created in the meantime.
    await fs.writeFile(file, key.toString("hex") + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return parse(await fs.readFile(file, "utf8"));
  }
}

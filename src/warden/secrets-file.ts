/**
 * Encrypted-file `SecretStore` — the backend for Linux / Keychain-less local
 * installs and for the cloud edition (one file per tenant).
 *
 * On disk: `{ version: 1, secrets: { <name>: { iv, tag, data, createdAt, updatedAt } } }`.
 * Every entry is AES-256-GCM with a fresh 96-bit IV and AAD bound to the store's
 * scope and to the secret's NAME, so a ciphertext cannot be moved to another
 * name or another tenant and still decrypt.
 *
 * FAIL CLOSED (.codex/INVARIANTS — only "file does not exist" initializes as
 * empty): a store file that does not parse, an entry that fails authentication,
 * or a missing/short key is `corrupt`. Nothing is ever overwritten to "repair"
 * it — `set` on a corrupt store throws and leaves the bytes alone.
 *
 * Where the key comes from decides what the encryption is worth:
 *  - local (`localKeyFile`): a random key in a 0600 file NEXT TO the ciphertext.
 *    That keeps values out of backups, greps and accidental `cat`s, and makes
 *    the two files separately revocable; it does not stop a process that can
 *    read both files. The Keychain backend is the stronger local option.
 *  - cloud (`tenantKey`): HKDF over the server's persistent session secret with
 *    the uid as `info` — the same root `src/web/apple-authorization.ts` uses,
 *    with its own domain separation. Losing or rotating that secret makes every
 *    tenant's stored secrets undecryptable (they fail closed, they do not leak).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SecretStoreError,
  assertSecretName,
  assertSecretValue,
  isValidSecretName,
  settle,
  sortMeta,
  type SecretMeta,
  type SecretStore,
} from "./secrets.js";

const FILE_VERSION = 1;
const AAD_DOMAIN = "lisa:warden:secret:v1";
const HKDF_SALT = "lisa:warden:secrets:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE_PREFIX = "v1.";

interface StoredEntry {
  iv: string;
  tag: string;
  data: string;
  createdAt: number;
  updatedAt: number;
}

export interface KeyProvider {
  /**
   * The 32-byte key. `create` is true only while the store holds no entries —
   * the one moment minting a fresh key cannot orphan existing ciphertext.
   */
  load(opts: { create: boolean }): Buffer;
}

export interface EncryptedFileSecretStoreOptions {
  backend: "file" | "cloud";
  /** Path of the encrypted store file. */
  file: string;
  keys: KeyProvider;
  /** Bound into every entry's AAD, e.g. `local` or `uid:<uid>`. */
  scope: string;
  now?: () => number;
}

function corrupt(what: string): SecretStoreError {
  return new SecretStoreError("corrupt", what);
}

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
}

/** Write `data` to `file` atomically, owner-only. */
function writeFileAtomic(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    throw new SecretStoreError("backend_failed", "cannot write the secret store file");
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort — non-POSIX filesystems (and GCS FUSE) may reject chmod
  }
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.iv === "string" &&
    typeof e.tag === "string" &&
    typeof e.data === "string" &&
    typeof e.createdAt === "number" &&
    Number.isFinite(e.createdAt) &&
    typeof e.updatedAt === "number" &&
    Number.isFinite(e.updatedAt)
  );
}

export class EncryptedFileSecretStore implements SecretStore {
  readonly backend: "file" | "cloud";
  private readonly file: string;
  private readonly keys: KeyProvider;
  private readonly scope: string;
  private readonly now: () => number;

  constructor(opts: EncryptedFileSecretStoreOptions) {
    this.backend = opts.backend;
    this.file = opts.file;
    this.keys = opts.keys;
    this.scope = opts.scope;
    this.now = opts.now ?? Date.now;
  }

  private read(): Map<string, StoredEntry> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return new Map();
      throw new SecretStoreError("backend_failed", "cannot read the secret store file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corrupt("the secret store file is not valid JSON");
    }
    const doc = parsed as { version?: unknown; secrets?: unknown } | null;
    if (
      !doc ||
      typeof doc !== "object" ||
      doc.version !== FILE_VERSION ||
      !doc.secrets ||
      typeof doc.secrets !== "object" ||
      Array.isArray(doc.secrets)
    ) {
      throw corrupt("the secret store file has an unknown shape or version");
    }
    const out = new Map<string, StoredEntry>();
    for (const [name, entry] of Object.entries(doc.secrets)) {
      if (!isValidSecretName(name) || !isStoredEntry(entry)) {
        throw corrupt("the secret store file contains a malformed entry");
      }
      out.set(name, entry);
    }
    return out;
  }

  private write(entries: Map<string, StoredEntry>): void {
    const secrets: Record<string, StoredEntry> = {};
    for (const name of [...entries.keys()].sort()) secrets[name] = entries.get(name)!;
    writeFileAtomic(this.file, JSON.stringify({ version: FILE_VERSION, secrets }, null, 2) + "\n");
  }

  private aad(name: string): Buffer {
    return Buffer.from(`${AAD_DOMAIN}\n${this.scope}\n${name}`, "utf8");
  }

  private key(create: boolean): Buffer {
    const key = this.keys.load({ create });
    if (key.length !== KEY_BYTES) throw corrupt("the secret store key has the wrong length");
    return key;
  }

  set(name: string, value: string): Promise<void> {
    return settle(() => {
      assertSecretName(name);
      assertSecretValue(value);
      const entries = this.read();
      const key = this.key(entries.size === 0);
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(this.aad(name));
      const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const at = this.now();
      entries.set(name, {
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        data: data.toString("base64url"),
        createdAt: entries.get(name)?.createdAt ?? at,
        updatedAt: at,
      });
      this.write(entries);
    });
  }

  get(name: string): Promise<string | null> {
    return settle(() => {
      assertSecretName(name);
      const entry = this.read().get(name);
      if (!entry) return null;
      const key = this.key(false);
      const iv = Buffer.from(entry.iv, "base64url");
      const tag = Buffer.from(entry.tag, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw corrupt(`secret://${name} failed its integrity check`);
      }
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(this.aad(name));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(Buffer.from(entry.data, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // Never surface the crypto error: it says nothing useful and the less
        // an attacker learns about why authentication failed, the better.
        throw corrupt(`secret://${name} failed its integrity check`);
      }
    });
  }

  has(name: string): Promise<boolean> {
    return settle(() => {
      assertSecretName(name);
      return this.read().has(name);
    });
  }

  list(): Promise<SecretMeta[]> {
    return settle(() =>
      sortMeta(
        [...this.read()].map(([name, e]) => ({
          name,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
        })),
      ),
    );
  }

  remove(name: string): Promise<boolean> {
    return settle(() => {
      assertSecretName(name);
      const entries = this.read();
      if (!entries.delete(name)) return false;
      this.write(entries);
      return true;
    });
  }
}

/**
 * A random 256-bit key in a 0600 file. Created on first use — but only while
 * the store is empty; if the key file disappears while ciphertext exists, that
 * is `corrupt`, not a cue to mint a new key over the old entries.
 */
export function localKeyFile(file: string): KeyProvider {
  const parse = (raw: string): Buffer => {
    const text = raw.trim();
    if (!text.startsWith(KEY_FILE_PREFIX)) throw corrupt("the secret store key file is malformed");
    const key = Buffer.from(text.slice(KEY_FILE_PREFIX.length), "base64url");
    if (key.length !== KEY_BYTES) throw corrupt("the secret store key file is malformed");
    return key;
  };
  const readExisting = (): Buffer | null => {
    try {
      return parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return null;
      if (err instanceof SecretStoreError) throw err;
      throw new SecretStoreError("backend_failed", "cannot read the secret store key file");
    }
  };
  return {
    load({ create }) {
      const existing = readExisting();
      if (existing) return existing;
      if (!create) {
        throw corrupt("the secret store key file is missing; stored secrets cannot be decrypted");
      }
      const key = crypto.randomBytes(KEY_BYTES);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        // "wx": never clobber a key another process created in the meantime.
        fs.writeFileSync(file, KEY_FILE_PREFIX + key.toString("base64url") + "\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch (err) {
        if (errnoCode(err) === "EEXIST") {
          const raced = readExisting();
          if (raced) return raced;
        }
        throw new SecretStoreError("backend_failed", "cannot create the secret store key file");
      }
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // best effort — see writeFileAtomic
      }
      return key;
    },
  };
}

/**
 * Per-tenant key for the cloud edition: HKDF-SHA256 over the server's
 * persistent session secret, salted for this module, with the uid as `info`.
 * Tenant A's key says nothing about tenant B's, and neither is ever stored.
 */
export function tenantKey(sessionSecret: () => string, uid: string): KeyProvider {
  return {
    load() {
      const secret = sessionSecret();
      if (typeof secret !== "string" || secret.length < 16) {
        throw new SecretStoreError("unavailable", "the server session secret is not available");
      }
      return Buffer.from(
        crypto.hkdfSync(
          "sha256",
          Buffer.from(secret, "utf8"),
          Buffer.from(HKDF_SALT, "utf8"),
          Buffer.from(`uid:${uid}`, "utf8"),
          KEY_BYTES,
        ),
      );
    },
  };
}

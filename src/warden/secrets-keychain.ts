/**
 * macOS Keychain `SecretStore`, via `/usr/bin/security`.
 *
 * Each secret is one generic-password item: service `ai.lisa.secrets`, account
 * = the secret's name. Items are created by `security` itself, so `security`
 * is the trusted application on their ACL and later reads through it do not
 * raise a permission dialog.
 *
 * HOW THE VALUE REACHES `security` — the part that matters:
 *
 *  `add-generic-password -w <value>` would put the value in the process's
 *  argument list, where any local user can read it with `ps`. Instead the
 *  command is written to the STDIN of `security -i` (its interactive mode,
 *  which reads one command per line). The argv of the process we spawn is only
 *  ever `["-i"]`; reads and deletes carry no value and use plain argv.
 *
 *  Two properties of `security -i`, both measured on macOS 26 (Darwin 25.6)
 *  with the harmless `help` command, shape the rest:
 *
 *   1. It reads lines through a 4096-byte buffer. A longer line is SPLIT, and
 *      the remainder is run as a second command — which fails and is echoed to
 *      stderr. So the whole command line is kept under `MAX_COMMAND_LINE`, which
 *      caps a Keychain-backed value at `KEYCHAIN_VALUE_MAX_BYTES`. Larger values
 *      (a 4096-bit PEM key, say) are refused with a pointer to the file backend.
 *   2. Its exit status after several lines is not a reliable verdict on the one
 *      that mattered. So every write is VERIFIED by reading the item back and
 *      comparing; the exit status is not trusted.
 *
 *  Because a failing `security -i` can echo fragments of its input, stderr is
 *  never captured (the default runner sends it to /dev/null) and no error from
 *  this module carries process output — only the exit status.
 *
 *  The value is stored as `v1.<base64url(utf8)>`: pure `[A-Za-z0-9_.-]`, so the
 *  interactive parser's quoting rules never come into play, a leading `-` can
 *  never be mistaken for a flag, and `find-generic-password -w` prints it back
 *  verbatim (it hex-dumps anything it considers non-printable). The cost is
 *  that Keychain Access shows the encoded form rather than the raw secret.
 *
 * The Keychain cannot cheaply enumerate "our" items, so names and timestamps
 * are kept in a small index file (`<lisaHome>/warden/secrets.index.json`, 0600,
 * no values). The Keychain is the source of truth for values; the index is the
 * source of truth for `list()`.
 *
 * TESTING: this backend is exercised only through an injected `SecurityRunner`.
 * The default runner refuses to run under `node --test`, so no test — here or
 * anywhere else in the suite — can reach the real Keychain by accident.
 */
import { spawn } from "node:child_process";
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

export const KEYCHAIN_SERVICE = "ai.lisa.secrets";
export const SECURITY_BIN = "/usr/bin/security";
/** Largest value the Keychain backend accepts (UTF-8 bytes). See the header. */
export const KEYCHAIN_VALUE_MAX_BYTES = 2560;
/** Hard ceiling for one `security -i` command line, newline included. */
const MAX_COMMAND_LINE = 3900;
const ENCODING_PREFIX = "v1.";
/** `security` exits 44 for errSecItemNotFound. */
const EXIT_NOT_FOUND = 44;
const RUN_TIMEOUT_MS = 15_000;
const INDEX_VERSION = 1;

export interface SecurityCommandResult {
  /** Exit status, or `null` when the process was killed (timeout). */
  code: number | null;
  stdout: string;
}

/**
 * Runs `/usr/bin/security <args>`, optionally feeding `stdin`. The seam the
 * tests use; implementations must never put `stdin` anywhere but the child's
 * standard input, and must not capture stderr.
 */
export type SecurityRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>;

/** The real runner. Refuses to run under `node --test`. */
export const defaultSecurityRunner: SecurityRunner = (args, stdin) => {
  if (process.env.NODE_TEST_CONTEXT) {
    return Promise.reject(
      new SecretStoreError(
        "unavailable",
        "the Keychain is never touched from tests; inject a SecurityRunner",
      ),
    );
  }
  return new Promise<SecurityCommandResult>((resolve, reject) => {
    const child = spawn(SECURITY_BIN, [...args], {
      // stderr → /dev/null: a failing `security -i` can echo its input.
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new SecretStoreError("unavailable", `${SECURITY_BIN} could not be started`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    // A child that exits before reading its stdin raises EPIPE here; the close
    // handler above already reports the outcome.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });
};

function encodeValue(value: string): string {
  return ENCODING_PREFIX + Buffer.from(value, "utf8").toString("base64url");
}

function decodeValue(stored: string, name: string): string {
  const body = stored.slice(ENCODING_PREFIX.length);
  if (!stored.startsWith(ENCODING_PREFIX) || !/^[A-Za-z0-9_-]+$/.test(body)) {
    throw new SecretStoreError("corrupt", `secret://${name} is not in the expected encoding`);
  }
  const bytes = Buffer.from(body, "base64url");
  // Reject anything that does not round-trip: a truncated or edited item.
  if (bytes.toString("base64url") !== body) {
    throw new SecretStoreError("corrupt", `secret://${name} is not in the expected encoding`);
  }
  return bytes.toString("utf8");
}

function failed(action: string, code: number | null): SecretStoreError {
  return new SecretStoreError(
    "backend_failed",
    code === null
      ? `the Keychain did not answer in time while ${action} (is it locked, or waiting on a dialog?)`
      : `the Keychain refused ${action} (security exited with status ${code})`,
  );
}

interface IndexEntry {
  createdAt: number;
  updatedAt: number;
}

export interface KeychainSecretStoreOptions {
  /** Path of the names-only index file. */
  indexFile: string;
  runner?: SecurityRunner;
  now?: () => number;
  /** Keychain service name; override only to namespace a non-default install. */
  service?: string;
}

export class KeychainSecretStore implements SecretStore {
  readonly backend = "keychain" as const;
  private readonly indexFile: string;
  private readonly run: SecurityRunner;
  private readonly now: () => number;
  private readonly service: string;

  constructor(opts: KeychainSecretStoreOptions) {
    this.indexFile = opts.indexFile;
    this.run = opts.runner ?? defaultSecurityRunner;
    this.now = opts.now ?? Date.now;
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(this.service)) {
      throw new SecretStoreError("unavailable", "invalid Keychain service name");
    }
  }

  // ── index (names + timestamps, no values) ──

  private readIndex(): Map<string, IndexEntry> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.indexFile, "utf8");
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        return new Map();
      }
      throw new SecretStoreError("backend_failed", "cannot read the secret index file");
    }
    const bad = new SecretStoreError("corrupt", "the secret index file is malformed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw bad;
    }
    const doc = parsed as { version?: unknown; names?: unknown } | null;
    if (
      !doc ||
      typeof doc !== "object" ||
      doc.version !== INDEX_VERSION ||
      !doc.names ||
      typeof doc.names !== "object" ||
      Array.isArray(doc.names)
    ) {
      throw bad;
    }
    const out = new Map<string, IndexEntry>();
    for (const [name, entry] of Object.entries(doc.names as Record<string, unknown>)) {
      const e = entry as Partial<IndexEntry> | null;
      if (
        !isValidSecretName(name) ||
        !e ||
        typeof e.createdAt !== "number" ||
        typeof e.updatedAt !== "number" ||
        !Number.isFinite(e.createdAt) ||
        !Number.isFinite(e.updatedAt)
      ) {
        throw bad;
      }
      out.set(name, { createdAt: e.createdAt, updatedAt: e.updatedAt });
    }
    return out;
  }

  private writeIndex(index: Map<string, IndexEntry>): void {
    const names: Record<string, IndexEntry> = {};
    for (const name of [...index.keys()].sort()) names[name] = index.get(name)!;
    const dir = path.dirname(this.indexFile);
    const tmp = `${this.indexFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: INDEX_VERSION, names }, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tmp, this.indexFile);
    } catch {
      fs.rmSync(tmp, { force: true });
      throw new SecretStoreError("backend_failed", "cannot write the secret index file");
    }
  }

  // ── Keychain ──

  /** The stored (still encoded) item, or `null` when the Keychain has none. */
  private async readItem(name: string): Promise<string | null> {
    const res = await this.run(["find-generic-password", "-s", this.service, "-a", name, "-w"]);
    if (res.code === EXIT_NOT_FOUND) return null;
    if (res.code !== 0) throw failed(`reading secret://${name}`, res.code);
    return res.stdout.replace(/\r?\n$/, "");
  }

  async set(name: string, value: string): Promise<void> {
    assertSecretName(name);
    assertSecretValue(value);
    if (Buffer.byteLength(value, "utf8") > KEYCHAIN_VALUE_MAX_BYTES) {
      throw new SecretStoreError(
        "invalid_value",
        `the Keychain backend stores values up to ${KEYCHAIN_VALUE_MAX_BYTES} bytes; ` +
          "set LISA_SECRETS_BACKEND=file for larger ones",
      );
    }
    // Read the index first: a corrupt index must stop us BEFORE the Keychain changes.
    const index = this.readIndex();
    const encoded = encodeValue(value);
    // Every token below is [A-Za-z0-9._/-] — nothing the interactive parser
    // could quote, split or treat as a flag — and the line fits one buffer.
    const line =
      `add-generic-password -U -s ${this.service} -a ${name} ` +
      `-l ${this.service}/${name} -w ${encoded}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_COMMAND_LINE) {
      throw new SecretStoreError("invalid_value", "secret value is too large for the Keychain");
    }
    // The exit status of `security -i` is not trusted (see the header); the
    // read-back below is the verdict. A timeout still means "do not continue".
    const res = await this.run(["-i"], line);
    if (res.code === null) throw failed(`storing secret://${name}`, null);
    const stored = await this.readItem(name);
    if (stored !== encoded) {
      throw new SecretStoreError(
        "backend_failed",
        `the Keychain did not store secret://${name} (is it locked, or was access denied?)`,
      );
    }
    const at = this.now();
    index.set(name, { createdAt: index.get(name)?.createdAt ?? at, updatedAt: at });
    this.writeIndex(index);
  }

  async get(name: string): Promise<string | null> {
    assertSecretName(name);
    const stored = await this.readItem(name);
    return stored === null ? null : decodeValue(stored, name);
  }

  /** Asks the Keychain for the item's attributes only — the value is not read. */
  async has(name: string): Promise<boolean> {
    assertSecretName(name);
    const res = await this.run(["find-generic-password", "-s", this.service, "-a", name]);
    if (res.code === EXIT_NOT_FOUND) return false;
    if (res.code !== 0) throw failed(`looking up secret://${name}`, res.code);
    return true;
  }

  list(): Promise<SecretMeta[]> {
    return settle(() => sortMeta([...this.readIndex()].map(([name, e]) => ({ name, ...e }))));
  }

  async remove(name: string): Promise<boolean> {
    assertSecretName(name);
    const index = this.readIndex();
    const res = await this.run(["delete-generic-password", "-s", this.service, "-a", name]);
    if (res.code !== 0 && res.code !== EXIT_NOT_FOUND) {
      throw failed(`removing secret://${name}`, res.code);
    }
    const indexed = index.delete(name);
    if (indexed) this.writeIndex(index);
    return res.code === 0 || indexed;
  }
}

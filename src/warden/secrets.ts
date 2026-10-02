/**
 * Warden credential broker — secret handles (plan W2b, "凭据代理").
 *
 * The model only ever sees a HANDLE, `secret://<name>`. The real value lives in
 * a `SecretStore` (macOS Keychain, an encrypted file, or a per-tenant encrypted
 * file on the cloud edition) and is substituted in by a tool executor at the
 * execution boundary, via `resolveSecretRefs`. Whatever comes back out of the
 * tool is passed through `redactKnownSecrets` before it can reach a transcript,
 * a log line or the model.
 *
 * Nothing in this module logs, and no error it throws carries a secret value:
 * errors name the handle (which is not secret) and a stable code, nothing else.
 */

/** URL-ish scheme that marks a secret handle in tool arguments. */
export const SECRET_REF_SCHEME = "secret://";

/** What `redactKnownSecrets` leaves in place of a value. */
export const SECRET_REDACTION = "[redacted: secret]";

/** Largest value a store accepts, in UTF-8 bytes. Keys and tokens are far smaller. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;

const NAME_SEGMENT = "[a-z0-9][a-z0-9._-]{0,63}";
/** One segment, or two joined by a single `/` (a namespace, e.g. `gmail/work`). */
const NAME_RE = new RegExp(`^${NAME_SEGMENT}(?:/${NAME_SEGMENT})?$`);

export type SecretErrorCode =
  /** The name does not match the handle grammar. */
  | "invalid_name"
  /** The value is empty, too large, or not a string. */
  | "invalid_value"
  /** No secret is stored under that name. */
  | "not_found"
  /** The store's data failed an integrity / decryption / parse check. Fail closed. */
  | "corrupt"
  /** The backend cannot be used here (no Keychain, no tenant scope, …). */
  | "unavailable"
  /** `resolveSecretRefs` was given an `allow` gate and it refused this handle. */
  | "not_allowed"
  /** The backend reported a failure. */
  | "backend_failed";

/** The only error this module throws. `message` never contains a secret value. */
export class SecretStoreError extends Error {
  constructor(
    public readonly code: SecretErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/** What `list()` returns — names and timestamps, never values. */
export interface SecretMeta {
  name: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms. */
  updatedAt: number;
}

export interface SecretStore {
  /** Which backend this is, for `lisa secret list` and diagnostics. */
  readonly backend: "keychain" | "file" | "cloud" | "memory";
  /** Create or replace. */
  set(name: string, value: string): Promise<void>;
  /** The value, or `null` when nothing is stored under `name`. */
  get(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
  /** Names + timestamps, sorted by name. Never values. */
  list(): Promise<SecretMeta[]>;
  /** True when something was removed. */
  remove(name: string): Promise<boolean>;
}

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name);
}

/** Throws `invalid_name` unless `name` matches the handle grammar. */
export function assertSecretName(name: unknown): asserts name is string {
  if (!isValidSecretName(name)) {
    throw new SecretStoreError(
      "invalid_name",
      "secret name must be lowercase [a-z0-9._-], start with a letter or digit, be at most " +
        "64 characters per segment, and contain at most one '/'",
    );
  }
}

/** Throws `invalid_value` unless `value` is a non-empty string within the size cap. */
export function assertSecretValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretStoreError("invalid_value", "secret value must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > SECRET_VALUE_MAX_BYTES) {
    throw new SecretStoreError(
      "invalid_value",
      `secret value exceeds ${SECRET_VALUE_MAX_BYTES} bytes`,
    );
  }
}

/** `gmail/work` → `secret://gmail/work`. */
export function formatSecretRef(name: string): string {
  assertSecretName(name);
  return SECRET_REF_SCHEME + name;
}

/** `secret://gmail/work` → `gmail/work`; `null` when `ref` is not exactly one handle. */
export function parseSecretRef(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.startsWith(SECRET_REF_SCHEME)) return null;
  const name = ref.slice(SECRET_REF_SCHEME.length);
  return isValidSecretName(name) ? name : null;
}

// ── in-memory store (tests, and executors that are handed a fixed set) ──

/** A `SecretStore` that lives and dies with the process. Never persisted. */
export class MemorySecretStore implements SecretStore {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, { value: string; meta: SecretMeta }>();

  constructor(private readonly now: () => number = Date.now) {}

  set(name: string, value: string): Promise<void> {
    return settle(() => {
      assertSecretName(name);
      assertSecretValue(value);
      const at = this.now();
      const createdAt = this.entries.get(name)?.meta.createdAt ?? at;
      this.entries.set(name, { value, meta: { name, createdAt, updatedAt: at } });
    });
  }

  get(name: string): Promise<string | null> {
    return settle(() => {
      assertSecretName(name);
      return this.entries.get(name)?.value ?? null;
    });
  }

  has(name: string): Promise<boolean> {
    return settle(() => {
      assertSecretName(name);
      return this.entries.has(name);
    });
  }

  list(): Promise<SecretMeta[]> {
    return settle(() => sortMeta([...this.entries.values()].map((e) => ({ ...e.meta }))));
  }

  remove(name: string): Promise<boolean> {
    return settle(() => {
      assertSecretName(name);
      return this.entries.delete(name);
    });
  }
}

/**
 * Run a synchronous store operation and hand back a promise, so a validation
 * failure surfaces as a rejection — the same way it does on an async backend —
 * instead of a synchronous throw the caller's `.catch` would miss.
 */
export function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Sort for `list()`: by name, byte order, so output is stable across backends. */
export function sortMeta(metas: SecretMeta[]): SecretMeta[] {
  return metas.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── resolution at the execution boundary ──

/** Matches a handle anywhere in a string. Longest match; validated again below. */
const EMBEDDED_REF_RE = new RegExp(`secret://(${NAME_SEGMENT}(?:/${NAME_SEGMENT})?)`, "g");
/** A character that would make a matched handle a prefix of something longer. */
const NAME_CONTINUATION_RE = /[A-Za-z0-9._/-]/;
/** Nesting bound for tool arguments; deeper input is refused rather than walked. */
const MAX_RESOLVE_DEPTH = 64;

export interface ResolveSecretOptions {
  /**
   * Gate consulted for every handle before the store is read. Return false to
   * refuse it (`not_allowed`). The Warden policy layer supplies this; without
   * it every handle in the store is resolvable by the caller.
   */
  allow?: (name: string) => boolean;
}

export interface ResolvedSecrets<T> {
  /** A deep copy of the input with every handle replaced by its value. */
  value: T;
  /** The handles that were substituted — unique, sorted. Safe to log. */
  names: string[];
  /**
   * `redactKnownSecrets` bound to exactly the values substituted above. Run every
   * string that comes back out of the tool through it. The values themselves are
   * deliberately not exposed as a property, so everything on this object other
   * than `value` can be logged or serialized without leaking anything.
   */
  redact(text: string): string;
}

/**
 * Deep-replace `secret://<name>` handles with their values — at execution time,
 * inside a tool executor, and nowhere else. The model never sees the result.
 *
 * - A string that is exactly a handle becomes the value; a handle embedded in a
 *   longer string (`"Bearer secret://github/token"`) is substituted in place.
 * - Arrays and plain objects are copied and walked; object KEYS are left alone;
 *   anything else (numbers, Dates, Buffers, class instances) passes through.
 * - Fails closed: an unknown handle, a malformed one, or one the `allow` gate
 *   refuses throws `SecretStoreError` and nothing is returned — a tool must
 *   never run with a literal `secret://…` where a credential was meant to be.
 */
export async function resolveSecretRefs<T>(
  value: T,
  store: SecretStore,
  opts: ResolveSecretOptions = {},
): Promise<ResolvedSecrets<T>> {
  const cache = new Map<string, string>();

  const lookup = async (name: string): Promise<string | null> => {
    const hit = cache.get(name);
    if (hit !== undefined) return hit;
    if (opts.allow && !opts.allow(name)) {
      throw new SecretStoreError("not_allowed", `secret://${name} is not granted to this call`);
    }
    const found = await store.get(name);
    if (found !== null) cache.set(name, found);
    return found;
  };

  const resolveString = async (text: string): Promise<string> => {
    if (!text.includes(SECRET_REF_SCHEME)) return text;
    const matches = [...text.matchAll(EMBEDDED_REF_RE)];
    // "secret://" is present but nothing after it parses as a name.
    const schemeCount = text.split(SECRET_REF_SCHEME).length - 1;
    if (matches.length !== schemeCount) {
      throw new SecretStoreError("invalid_name", "malformed secret handle in tool arguments");
    }
    let out = "";
    let last = 0;
    for (const m of matches) {
      const start = m.index;
      const full = m[1]!;
      // The grammar allows a trailing '.', '-' or '_', and so does prose
      // ("use secret://github/token."). Prefer the longest name that exists;
      // `has` settles that without reading a value or consulting the gate.
      let name = full;
      while (/[._-]$/.test(name) && !cache.has(name) && !(await store.has(name))) {
        name = name.slice(0, -1);
      }
      const found = await lookup(name);
      if (found === null) {
        throw new SecretStoreError("not_found", `no secret is stored as secret://${full}`);
      }
      const end = start + SECRET_REF_SCHEME.length + name.length;
      const next = text[end];
      // "secret://tokenX" or "secret://a/b/c": the handle would be a prefix of
      // a longer run. Substituting a prefix silently is worse than refusing.
      if (name === full && next !== undefined && NAME_CONTINUATION_RE.test(next)) {
        throw new SecretStoreError("invalid_name", "malformed secret handle in tool arguments");
      }
      out += text.slice(last, start) + found;
      last = end;
    }
    return out + text.slice(last);
  };

  const seen = new WeakMap<object, unknown>();
  const walk = async (node: unknown, depth: number): Promise<unknown> => {
    if (typeof node === "string") return resolveString(node);
    if (node === null || typeof node !== "object") return node;
    if (depth > MAX_RESOLVE_DEPTH) {
      throw new SecretStoreError("invalid_value", "tool arguments are nested too deeply");
    }
    const prior = seen.get(node);
    if (prior !== undefined) return prior;
    if (Array.isArray(node)) {
      const copy: unknown[] = [];
      seen.set(node, copy);
      for (const item of node) copy.push(await walk(item, depth + 1));
      return copy;
    }
    const proto: unknown = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return node;
    const copy = (proto === null ? Object.create(null) : {}) as Record<string, unknown>;
    seen.set(node, copy);
    for (const [key, child] of Object.entries(node)) {
      copy[key] = await walk(child, depth + 1);
    }
    return copy;
  };

  const resolved = (await walk(value, 0)) as T;
  const values = [...cache.values()];
  return {
    value: resolved,
    names: [...cache.keys()].sort(),
    redact: (text: string) => redactKnownSecrets(text, values),
  };
}

/** True when `value` contains a `secret://` handle anywhere (strings, arrays, plain objects). */
export function containsSecretRef(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return value.includes(SECRET_REF_SCHEME);
  if (value === null || typeof value !== "object" || depth > MAX_RESOLVE_DEPTH) return false;
  if (Array.isArray(value)) return value.some((v) => containsSecretRef(v, depth + 1));
  return Object.values(value).some((v) => containsSecretRef(v, depth + 1));
}

// ── redaction of outputs and logs ──

/**
 * Values shorter than this are not redacted: replacing every occurrence of a
 * 1–3 character string would shred the output while hiding nothing.
 */
export const SECRET_REDACT_MIN_LENGTH = 4;

/** The spellings of one value that are worth catching in echoed output. */
function redactionVariants(value: string): string[] {
  const out = new Set<string>([value]);
  try {
    out.add(encodeURIComponent(value));
  } catch {
    // lone surrogate — no URI form exists; the raw value is still covered
  }
  out.add(JSON.stringify(value).slice(1, -1));
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length >= 6) {
    const b64 = bytes.toString("base64");
    out.add(b64);
    out.add(b64.replace(/=+$/, ""));
    out.add(bytes.toString("base64url"));
    out.add(bytes.toString("hex"));
  }
  return [...out].filter((v) => v.length >= SECRET_REDACT_MIN_LENGTH);
}

/**
 * Replace every occurrence of each known secret value in `text` with
 * `[redacted: secret]`. Also catches the value URL-encoded, JSON-escaped,
 * base64 / base64url-encoded and hex-encoded. It cannot catch a value that was
 * transformed together with other data (e.g. `base64("user:" + value)`), which
 * is why tool inputs are never logged in the first place.
 */
export function redactKnownSecrets(text: string, values: Iterable<string>): string {
  if (!text) return text;
  const needles = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || v.length < SECRET_REDACT_MIN_LENGTH) continue;
    for (const variant of redactionVariants(v)) needles.add(variant);
  }
  // Longest first, so a value that contains another is removed whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of ordered) {
    if (out.includes(needle)) out = out.split(needle).join(SECRET_REDACTION);
  }
  return out;
}

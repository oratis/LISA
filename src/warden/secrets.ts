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

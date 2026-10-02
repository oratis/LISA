/**
 * Payload digest, previews and data-class detection.
 *
 * Two renderings of a tool input exist, for two different readers:
 *
 *  - `redactedPreview` — short (≤240 chars). Goes to the audit log, the durable
 *    pending file and SSE. It shows values only for a fixed list of structural
 *    keys; every other key appears as its name and length. Raw inputs routinely
 *    carry message bodies, file contents and credentials, and those places are
 *    not allowed to hold them (INVARIANTS §权限与工具 5).
 *  - `displayPayload` — the WHOLE payload, for the approval card, in an order
 *    the classifier chose. It lives only in server memory and is served only
 *    to a caller who may approve. A person approving a digest must have been
 *    able to read everything that digest covers.
 *
 * Every regex here runs on model-supplied text and is bounded (a lookbehind
 * plus a bounded quantifier) so that no input makes it quadratic.
 */
import { createHash, createHmac } from "node:crypto";
import type { DataClass, PayloadField } from "./types.js";

export const PREVIEW_MAX = 240;
/** How much text the detectors and the short preview will look at. */
const SCAN_LIMIT = 64 * 1024;

/** JSON with object keys sorted, so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "undefined" || typeof v === "function" || typeof v === "symbol") {
        return null;
      }
      return v;
    }
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Array<[string, unknown]> = [];
    for (const key of Object.keys(v).sort()) {
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out.push([key, walk(child)]);
    }
    return Object.fromEntries(out);
  };
  return JSON.stringify(walk(value)) ?? "null";
}

/**
 * Digest over the canonical JSON of `{tool,input}` — binds an approval to the
 * exact payload. With a `key` it is an HMAC (what Warden stores and shows):
 * a bare hash of a small payload, such as a 6-digit code, could be reversed by
 * anyone who can read the audit log. Without a key it is a plain sha256, for
 * callers that only compare digests in memory.
 */
export function payloadDigest(tool: string, input: unknown, key?: Buffer | string): string {
  const body = canonicalJson({ tool, input });
  if (key !== undefined) return createHmac("sha256", key).update(body).digest("hex");
  return createHash("sha256").update(body).digest("hex");
}

const VALUE = `("[^"\\n]{0,512}"|'[^'\\n]{0,512}'|[^\\s"'&;,]{1,512})`;
const NOT_LENGTH = "(?!<\\d{1,9} (?:chars|items)>)";

/**
 * Secret-shaped substrings. Deliberately over-eager: a false positive costs a
 * few masked characters in a preview, a false negative leaks a credential into
 * an audit file.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  /(?<![A-Za-z0-9_-])(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,256}/g,
  /(?<![A-Za-z0-9_])sk_(?:live|test)_[A-Za-z0-9]{16,256}/g,
  /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,256}/g,
  /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,256}/g,
  /(?<![A-Za-z0-9-])xox[abposr]-[A-Za-z0-9-]{10,256}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,256}/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}/g,
  /(?<![A-Za-z0-9])(?:Bearer|Basic)[ \t]{1,8}[A-Za-z0-9._~+/=-]{12,4096}/gi,
  // NAME=value / name: value where the name says it is a credential. No \b on
  // the left: `AWS_SECRET_ACCESS_KEY`, `DB_PASSWORD`, `X-Api-Key` all count.
  new RegExp(
    "(?<![A-Za-z0-9])[A-Za-z0-9_-]{0,40}" +
      "(?:password|passwd|passphrase|passcode|secret|token(?!s|_count|_limit|iz)|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|authorization|otp|verification[_ -]?code)" +
      `[A-Za-z0-9_-]{0,40}["']?[ \\t]{0,4}[=:][ \\t]{0,4}${NOT_LENGTH}${VALUE}`,
    "gi",
  ),
  // --password x, --token=x, --api-key x …
  new RegExp(
    "(?<![A-Za-z0-9-])--?(?:password|passwd|passphrase|pass|token|secret|api[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token|authorization)" +
      `(?:=|[ \\t]{1,4})${VALUE}`,
    "gi",
  ),
  // scheme://user:pass@host
  /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,24}:\/\/[^\s/:@'"]{1,128}:[^\s/@'"]{1,256}@/g,
];

/**
 * Masked in previews but NOT counted as a detected secret: long hex is usually
 * a commit SHA or a digest, and `-p…` is far more often a flag than a MySQL
 * password. Flagging them would make ordinary commands look like exfiltration.
 */
const REDACT_ONLY_PATTERNS: RegExp[] = [
  /(?<![A-Fa-f0-9])[A-Fa-f0-9]{40,512}(?![A-Fa-f0-9])/g,
  /(?<=\b(?:mysql|mariadb|mysqldump|mysqladmin|mysqlimport)\b[^\n|;&]{0,200}\s)-p[^\s]{1,256}/g,
  // curl -u user:pass / --user user:pass (also `docker run -u uid:gid`, hence not "detected")
  /(?<![A-Za-z0-9-])(?:-u|--user)(?:=|[ \t]{1,4})[^\s:'"]{1,128}:[^\s'"]{1,256}/g,
];

const EMAIL_SOURCE =
  "(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\\.[A-Za-z0-9-]{1,63}){1,8}";
const EMAIL_RE = new RegExp(EMAIL_SOURCE);
const EMAIL_ALL_RE = new RegExp(EMAIL_SOURCE, "g");
const PHONE_RE = /(?<![\w.+-])\+?\d[\d\s().-]{7,24}\d(?![\w-])/g;
const CARD_RE = /(?<![\d -])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const IBAN_RE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Za-z0-9])/;

function replaceAll(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const re of patterns) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/** Mask secret-shaped substrings. */
export function redactSecrets(text: string): string {
  return replaceAll(text, [...SECRET_PATTERNS, ...REDACT_ONLY_PATTERNS]);
}

export function containsSecret(text: string): boolean {
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function containsCardNumber(text: string): boolean {
  CARD_RE.lastIndex = 0;
  for (const match of text.matchAll(CARD_RE)) {
    const digits = match[0].replace(/[^\d]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

function isPhoneShaped(candidate: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) return false;
  const digits = candidate.replace(/[^\d]/g, "").length;
  return candidate.startsWith("+") ? digits >= 8 && digits <= 15 : digits >= 10 && digits <= 15;
}

/** Phone-shaped, excluding ISO dates/timestamps that share the digit-and-dash shape. */
function containsPhone(text: string): boolean {
  PHONE_RE.lastIndex = 0;
  for (const match of text.matchAll(PHONE_RE)) {
    if (isPhoneShaped(match[0])) return true;
  }
  return false;
}

/** Flatten every string in a value (bounded) so detectors see nested fields. */
function collectStrings(value: unknown, out: string[], budget = { left: SCAN_LIMIT }): void {
  if (budget.left <= 0) return;
  if (typeof value === "string") {
    const piece = value.slice(0, budget.left);
    budget.left -= piece.length;
    out.push(piece);
    return;
  }
  if (typeof value === "number") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, budget);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" || typeof child === "number") {
        // Keep "key: value" adjacency so `password: hunter2` is detectable.
        const piece = `${key}: ${String(child)}`.slice(0, Math.max(0, budget.left));
        budget.left -= piece.length;
        out.push(piece);
      } else {
        collectStrings(child, out, budget);
      }
    }
  }
}

/**
 * Deterministic data-class detection over a tool input.
 *
 * Detects "secret" (credential shapes), "pii" (email / phone) and "financial"
 * (Luhn-valid card numbers, IBANs). "health" and "private-message" cannot be
 * inferred from a payload; they arrive as hints from a connector manifest.
 */
export function detectDataClasses(input: unknown, hints: DataClass[] = []): DataClass[] {
  const strings: string[] = [];
  collectStrings(input, strings);
  const text = strings.join("\n");
  const found = new Set<DataClass>(hints);
  if (containsSecret(text)) found.add("secret");
  if (EMAIL_RE.test(text) || containsPhone(text)) found.add("pii");
  if (containsCardNumber(text) || IBAN_RE.test(text)) found.add("financial");
  return [...found].sort();
}

/**
 * Keys whose VALUES may appear in the short preview: they say what the call
 * does and to what. Everything else — bodies, subjects, queries, free text,
 * numbers under unknown names — is shown as a name and a length only.
 */
const SHOWN_KEYS = new Set([
  "command",
  "path",
  "file_path",
  "url",
  "uri",
  "repo",
  "repository",
  "action",
  "method",
  "number",
  "branch",
  "base",
  "ref",
  "agent",
  "slug",
  "cwd",
  "to",
  "cc",
  "bcc",
  "recipient",
  "recipients",
  "channel",
  "host",
  "domain",
  "target",
  "pr",
  "since",
  "state",
  "merge_method",
  "package",
  "type",
  "scope",
]);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}

function shape(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `<${value.length} chars>`;
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `<${value.length} items>`;
  return "{…}";
}

function shown(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(clip(redactSecrets(value.slice(0, 4096)), 80));
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    const items = (value as string[]).slice(0, 3).map((item) => shown(item));
    return `[${items.join(", ")}${value.length > 3 ? `, +${value.length - 3}` : ""}]`;
  }
  return shape(value);
}

/** Keys in card order: the classifier's primary keys first, then the rest, sorted. */
function orderedKeys(input: Record<string, unknown>, primaryKeys: readonly string[]): string[] {
  const primary = primaryKeys.filter((key) => Object.hasOwn(input, key));
  const rest = Object.keys(input)
    .filter((key) => !primary.includes(key))
    .sort();
  return [...primary, ...rest];
}

/**
 * A redacted, ≤240-char rendering of a tool input, for the audit log, the
 * pending file and SSE. Keys come in the classifier's order (never the
 * model's), so padding keys cannot push the command out of view; values are
 * shown only for structural keys.
 */
export function redactedPreview(
  tool: string,
  input: unknown,
  primaryKeys: readonly string[] = [],
): string {
  let body: string;
  if (input === null || input === undefined) body = "";
  else if (typeof input !== "object" || Array.isArray(input)) body = shape(input);
  else {
    const record = input as Record<string, unknown>;
    body = orderedKeys(record, primaryKeys)
      .slice(0, 40)
      .map((key) => {
        const value = record[key];
        const safeKey = clip(key, 40);
        return `${safeKey}=${SHOWN_KEYS.has(key.toLowerCase()) ? shown(value) : shape(value)}`;
      })
      .join(" ");
  }
  return clip(redactSecrets(`${clip(tool, 80)}(${body})`), PREVIEW_MAX);
}

/** Largest payload (canonical JSON) a person can be asked to review. */
export const MAX_REVIEWABLE_BYTES = 2 * 1024 * 1024;

function fieldText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

/**
 * The whole payload an approval covers, one field per input key, in the
 * classifier's order. Values are never clipped; secret-shaped substrings are
 * masked (the digest still covers the real value).
 */
export function displayPayload(input: unknown, primaryKeys: readonly string[] = []): PayloadField[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== "object" || Array.isArray(input)) {
    return [{ key: "input", value: redactSecrets(fieldText(input)), primary: true }];
  }
  const record = input as Record<string, unknown>;
  const primary = new Set(primaryKeys.filter((key) => Object.hasOwn(record, key)));
  return orderedKeys(record, primaryKeys).map((key) => ({
    key,
    value: redactSecrets(fieldText(record[key])),
    primary: primary.has(key),
  }));
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8);
}

/** Recipients are PII: keep the domain (or the last two digits), hash the rest. */
export function maskRecipient(target: string): string {
  const at = target.lastIndexOf("@");
  if (at > 0 && at < target.length - 1) {
    return `${shortHash(target.slice(0, at).toLowerCase())}@${target.slice(at + 1)}`;
  }
  const trimmed = target.trim();
  if (/^\+?[\d\s().-]{8,32}$/.test(trimmed) && isPhoneShaped(trimmed)) {
    const digits = trimmed.replace(/[^\d]/g, "");
    return `tel:${shortHash(digits)}…${digits.slice(-2)}`;
  }
  return target;
}

/** Mask every email address and phone number inside free text (audit previews, notes). */
export function maskEmails(text: string): string {
  EMAIL_ALL_RE.lastIndex = 0;
  PHONE_RE.lastIndex = 0;
  return text
    .slice(0, SCAN_LIMIT)
    .replace(EMAIL_ALL_RE, (email) => maskRecipient(email))
    .replace(PHONE_RE, (phone) => (isPhoneShaped(phone) ? maskRecipient(phone) : phone));
}

/** Targets as they may appear in the audit log: recipients masked, long values clipped. */
export function auditTargets(targets: string[]): string[] {
  return targets.slice(0, 16).map((target) => clip(redactSecrets(maskRecipient(target)), 160));
}

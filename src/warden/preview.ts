/**
 * Payload digest, redacted preview and data-class detection.
 *
 * Everything here is deterministic string work. The preview is the ONLY
 * rendering of a tool input that Warden shows in a card or writes to the audit
 * log (INVARIANTS §权限与工具 5): raw inputs routinely carry file contents,
 * message bodies and credentials.
 */
import { createHash } from "node:crypto";
import type { DataClass } from "./types.js";

export const PREVIEW_MAX = 240;

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
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      const child = (v as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = walk(child);
    }
    return out;
  };
  return JSON.stringify(walk(value)) ?? "null";
}

/** sha256 over the canonical JSON of `{tool,input}` — binds an approval to the exact payload. */
export function payloadDigest(tool: string, input: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool, input })).digest("hex");
}

/**
 * Secret-shaped substrings. Deliberately over-eager: a false positive costs a
 * few masked characters in a preview, a false negative leaks a credential into
 * an audit file.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth|otp|passcode|verification[_ -]?code)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^\s"'&;,]+)/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RE = /(?<![\w.-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/;

/** Mask secret-shaped substrings. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[REDACTED]");
  }
  return out;
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

/** Phone-shaped, excluding ISO dates/timestamps that share the digit-and-dash shape. */
function containsPhone(text: string): boolean {
  PHONE_RE.lastIndex = 0;
  for (const match of text.matchAll(PHONE_RE)) {
    const candidate = match[0];
    if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) continue;
    const digits = candidate.replace(/[^\d]/g, "").length;
    if (candidate.startsWith("+") ? digits >= 8 && digits <= 15 : digits >= 10 && digits <= 15) {
      return true;
    }
  }
  return false;
}

/** Flatten every string in a value (bounded) so detectors see nested fields. */
function collectStrings(value: unknown, out: string[], budget = { left: 200_000 }): void {
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

/** Input keys whose values are bodies or credentials: shown as a length, never as text. */
const OPAQUE_KEYS =
  /^(content|contents|body|text|message|html|markdown|data|payload|patch|patches|diff|new_string|old_string|password|passwd|secret|token|api_?key|apikey|otp|code|authorization|cookie|file|files|attachment|attachments|prompt)$/i;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "…";
}

function describeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (OPAQUE_KEYS.test(key)) return `<${value.length} chars>`;
    return JSON.stringify(clip(redactSecrets(value), 80));
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (OPAQUE_KEYS.test(key)) return `<${value.length} items>`;
    const shown = value
      .slice(0, 3)
      .map((item) => describeValue(key, item))
      .join(", ");
    return `[${shown}${value.length > 3 ? `, +${value.length - 3}` : ""}]`;
  }
  return "{…}";
}

/**
 * A redacted, ≤240-char rendering of a tool input. Bodies and credentials are
 * replaced by their length; remaining strings are secret-masked and clipped.
 */
export function redactedPreview(tool: string, input: unknown): string {
  let body: string;
  if (input === null || input === undefined) body = "";
  else if (typeof input !== "object" || Array.isArray(input)) body = describeValue("", input);
  else {
    body = Object.entries(input as Record<string, unknown>)
      .map(([key, value]) => `${key}=${describeValue(key, value)}`)
      .join(" ");
  }
  return clip(redactSecrets(`${tool}(${body})`), PREVIEW_MAX);
}

/** Recipients are PII: keep the domain, hash the local part. */
export function maskRecipient(target: string): string {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return target;
  const local = target.slice(0, at);
  const hash = createHash("sha256").update(local.toLowerCase()).digest("hex").slice(0, 8);
  return `${hash}@${target.slice(at + 1)}`;
}

/** Targets as they may appear in the audit log: recipients masked, long values clipped. */
export function auditTargets(targets: string[]): string[] {
  return targets.slice(0, 16).map((target) => clip(redactSecrets(maskRecipient(target)), 160));
}

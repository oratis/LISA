/**
 * Consent blacklists (FOUNDATIONS §1) — the "never capture this" filters that
 * sit UNDER consent: even a granted source must skip blacklisted apps, paths,
 * and PII. Pure functions (no I/O) so they're exhaustively testable and can run
 * on the hot path of every capture frame.
 *
 * These are conservative DEFAULTS; a source merges user-configured extras on top
 * (never replacing the defaults). Matching is deliberately broad — a false
 * "blacklisted" (skip a frame) is harmless; a false "allowed" leaks.
 */

/** Foreground apps whose presence means "capture nothing this frame". */
export const DEFAULT_APP_BLACKLIST: string[] = [
  "1password",
  "keychain access",
  "bitwarden",
  "lastpass",
  "dashlane",
  "nordpass",
  "proton pass",
  "authy",
  // banking / finance surfaces (substring match catches "… Banking", etc.)
  "bank",
  "venmo",
  "paypal",
  "coinbase",
  "robinhood",
  "wallet",
];

/** Path/title patterns for sensitive files (secrets, keys, credentials). */
// Word-boundary (not just path-anchored) so these also catch a secret named in
// free text — e.g. a voice transcript "open my .env file", not only a path.
export const DEFAULT_PATH_BLACKLIST: RegExp[] = [
  /(^|[\s./])\.env\b/i,
  /\.(key|pem|p12|pfx|keystore)\b/i,
  /id_(rsa|ed25519|ecdsa)\b/i,
  /\bsecrets?\b/i,
  /\bcredentials?\b/i,
  /\.ssh\//i,
  /\.aws\//i,
];

/** PII patterns we redact from any captured text before it's distilled/stored. */
export const PII_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // 13–19 digit runs (optionally space/dash grouped) — credit-card-ish.
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g },
];

/** Is `appName` a blacklisted foreground app? Case-insensitive substring. */
export function isBlacklistedApp(appName: string | undefined, extra: string[] = []): boolean {
  if (!appName) return false;
  const n = appName.toLowerCase();
  return [...DEFAULT_APP_BLACKLIST, ...extra].some((b) => b && n.includes(b.toLowerCase()));
}

/** Is `p` a blacklisted path / window title (secrets, keys, credentials)? */
export function isBlacklistedPath(p: string | undefined, extra: RegExp[] = []): boolean {
  if (!p) return false;
  return [...DEFAULT_PATH_BLACKLIST, ...extra].some((re) => re.test(p));
}

/** Does `text` contain any PII pattern? */
export function containsPII(text: string): boolean {
  if (!text) return false;
  // `.test` on a /g regex advances lastIndex; build fresh each call to stay pure.
  return PII_PATTERNS.some(({ re }) => new RegExp(re.source, re.flags).test(text));
}

/** Replace every PII match with a typed placeholder, e.g. "[email]". Pure. */
export function redactPII(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { name, re } of PII_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), `[${name}]`);
  }
  return out;
}

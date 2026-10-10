/**
 * What a Lisa export carries — and, just as important, what it never does.
 * Shared by export (what to write) and import (what to accept), so a crafted
 * archive can't plant anything an honest export would not contain.
 *
 * Inclusion is an ALLOWLIST of top-level areas of a home; everything else in a
 * home (config.env, accounts, devices, billing, warden/, mail credentials,
 * push/relay/channel config, the session secret, logs, caches…) is never even
 * visited. Inside the allowed areas a DENYLIST strips infrastructure state and
 * anything secret-shaped. Both apply on export and again on import.
 */

/** Top-level areas of a home that an export may carry. */
export const EXPORT_ROOTS = ["soul", "memory", "kb", "skills", "sessions", "tasks"] as const;
export type ExportRoot = (typeof EXPORT_ROOTS)[number];

/** `memory/` holds caches and locks too; only the two stores are user data. */
const MEMORY_FILES = new Set(["MEMORY.md", "USER.md"]);

/**
 * Human-readable statement of the exclusions, written into every manifest so
 * the person holding an archive can see what it deliberately lacks.
 */
export const EXPORT_EXCLUSIONS: readonly string[] = [
  "everything outside soul/, memory/MEMORY.md, memory/USER.md, kb/, skills/, sessions/ (opt-in) and tasks/",
  "config.env, accounts, devices, billing, session secret, OTPs, push/relay/channel config, mail credentials",
  "warden/ (encrypted secrets and key, grants, rules, digest key, taint records, approval audit, pending approvals)",
  "tasks/.leases/, tasks/**/.locks/, tasks/outbox/",
  "executable-skill approvals (skills/**/approved.json) — re-approve tool.js after import",
  "git metadata (.git/), lock files (*.lock), temp files (*.tmp)",
  "reserved names are matched in any letter case and Unicode spelling",
  "secret-shaped files anywhere (.env, *.env, secrets*.json, *.key, *.pem, *.p8, *.p12)",
  "symlinks, hard links, devices, sockets and FIFOs",
];

const SECRET_BASENAME =
  /^(?:\.env|.*\.env|secrets?(?:\..*)?\.json|.*\.(?:key|pem|p8|p12)|session-secret|devices\.json|accounts\.json|otp\.json)$/i;

/** Code points filesystems drop or ignore when comparing names (HFS+ ignores ZWJ/ZWNJ, bidi marks and the BOM). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * The name a filesystem might take `seg` to be. Used for every comparison
 * against a reserved name and for collision checks, on export and on import.
 * It over-approximates every filesystem a home can live on: compatibility
 * normalisation (APFS is normalisation-insensitive; NFKC also folds
 * full-width and other look-alike forms), ignorable code points removed,
 * full case folding (APFS and HFS+ are case-insensitive by default; the
 * upper-then-lower round trip also folds ß, ſ and the Kelvin sign), and
 * trailing dots and spaces stripped (FAT, exFAT and SMB drop them).
 */
export function foldSegment(seg: string): string {
  return seg
    .normalize("NFKC")
    .replace(IGNORABLE, "")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[. ]+$/u, "");
}

/** `foldSegment` applied to every segment of a POSIX path. */
export function foldPath(p: string): string {
  return p.split("/").map(foldSegment).join("/");
}

/**
 * Why an (export-root-relative, POSIX) path is excluded, or null when it may
 * be carried. `rel` includes the root segment, e.g. `tasks/.leases/x.lease`.
 *
 * Allowlisted names (the roots, memory's two stores) must match exactly, so a
 * case variant of one is refused. Reserved names (`.git`, locks, the outbox,
 * skill approvals, secrets…) are compared after `foldSegment`, so no spelling
 * of one gets through on a case- or normalisation-insensitive filesystem.
 */
export function exclusionReason(rel: string): string | null {
  const segs = rel.split("/");
  const root = segs[0]!;
  if (!(EXPORT_ROOTS as readonly string[]).includes(root)) return "outside export areas";
  const folded = segs.map(foldSegment);
  const base = folded[folded.length - 1]!;
  if (folded.includes(".git")) return "git metadata";
  if (root === "tasks") {
    if (folded.includes(".leases")) return "task lease";
    if (folded.includes(".locks")) return "task lock";
    if (folded[1] === "outbox") return "task outbox";
  }
  if (folded.includes(".locks") || folded.includes(".leases")) return "lock";
  // An executable skill's approval pins the sha256 of its tool.js. It is a
  // local trust decision: carried in an archive, a crafted import could ship
  // tool.js together with its own "approval" and have it loaded at startup.
  if (root === "skills" && base === "approved.json") return "skill approval";
  if (root === "memory" && segs.length > 1 && !(segs.length === 2 && MEMORY_FILES.has(segs[1]!))) {
    return "memory internals";
  }
  if (base.endsWith(".lock")) return "lock file";
  if (base.endsWith(".tmp")) return "temp file";
  if (SECRET_BASENAME.test(base) || SECRET_BASENAME.test(segs[segs.length - 1]!)) {
    return "secret material";
  }
  return null;
}

export const MANIFEST_PATH = "manifest.json";

/**
 * Structural validity of an archive path (both directions): relative POSIX,
 * no `.`/`..`/empty segments, no backslashes, NUL or control characters, no
 * drive letters, bounded length. Returns a reason or null.
 */
export function archivePathProblem(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) return "empty path";
  if (Buffer.byteLength(p) > 1024) return "path too long";
  if (p.startsWith("/")) return "absolute path";
  if (/^[a-zA-Z]:/.test(p)) return "drive-letter path";
  if (p.includes("\\")) return "backslash in path";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "control character in path";
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "") return "empty path segment";
    if (s === "." || s === "..") return "path traversal";
    if (Buffer.byteLength(s) > 255) return "path segment too long";
  }
  return null;
}

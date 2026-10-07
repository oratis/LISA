/**
 * Path resolution for Warden decisions.
 *
 * "Is this path inside the workspace?" and "is this path Warden's own state?"
 * must be answered about the file the call will actually touch, not about the
 * string the model wrote. So paths are resolved through symlinks — including a
 * final component that does not exist yet — before they are compared.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The real path of `p`: every existing ancestor resolved through symlinks, with
 * the not-yet-existing tail appended. Never throws.
 */
export function realPath(p: string): string {
  const absolute = path.resolve(p);
  let current = absolute;
  const tail: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
  return absolute;
}

function relativeInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when `child` resolves to `parent` or something under it. */
export function isInsideReal(parent: string, child: string): boolean {
  return relativeInside(realPath(parent), realPath(child));
}

/**
 * Containment for PROTECTED locations: resolved through symlinks AND compared
 * without regard to case. On a case-insensitive volume `~/.lisa/Warden` is the
 * warden directory; treating a differently-cased path as protected on a
 * case-sensitive one costs nothing.
 */
export function isInsideProtected(parent: string, child: string): boolean {
  const realParent = realPath(parent).toLowerCase();
  const realChild = realPath(child).toLowerCase();
  if (relativeInside(realParent, realChild)) return true;
  // Also compare the unresolved spellings, so a protected directory that does
  // not exist yet is still recognised.
  return relativeInside(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
}

/** Credential locations under a home directory: reading them always asks. */
const CREDENTIAL_PATHS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".password-store",
  ".config/gh",
  ".config/gcloud",
  ".config/op",
  "Library/Keychains",
  "Library/Application Support/1Password",
];

/** Absolute credential locations for `home` (defaults to the OS home). */
export function credentialPaths(home: string = os.homedir()): string[] {
  return CREDENTIAL_PATHS.map((rel) => path.join(home, rel));
}

/** Is `p` a credential location, or one of the caller's extra sensitive paths? */
export function isSensitivePath(p: string, extra: readonly string[] = [], home?: string): boolean {
  for (const root of [...credentialPaths(home), ...extra]) {
    if (isInsideProtected(root, p)) return true;
  }
  return false;
}

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
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
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

/**
 * A workspace root that confines nothing worth the name: the filesystem root,
 * the user's home directory or anything above it, or a directory that
 * contains a Lisa home (whose task files and settings a "confined" write could
 * then rewrite). Under Lisa.app or launchd a server's cwd is `/`; from a shell
 * it is often `$HOME`. Nothing that writes under such a root counts as
 * sandboxed (classify.ts), on any surface (#422 review H2).
 */
export function isBroadWorkspace(
  root: string,
  opts: { homeDir?: string; lisaHomes?: readonly string[] } = {},
): boolean {
  if (!root || !path.isAbsolute(root)) return true;
  const real = realPath(root);
  if (real === path.parse(real).root) return true;
  const home = opts.homeDir ?? os.homedir();
  // The root is the user's home, or one of its ancestors.
  if (home && isInsideReal(real, home)) return true;
  return (opts.lisaHomes ?? []).some((lisa) => isInsideReal(real, lisa));
}

export interface ChatWorkspaceResolution {
  workspaceRoot: string;
  /** False when no non-broad workspace could be resolved (Warden fails closed). */
  confined: boolean;
}

/**
 * Resolve a safe workspace root for interactive chat turns.
 *
 * When a server launches under launchd or Lisa.app, `process.cwd()` is `/` or
 * `$HOME` (a broad workspace that confines nothing). If `cwd` is broad, an
 * explicit `configuredRoot` (or `LISA_CHAT_WORKSPACE`) is used ONLY when it is
 * absolute, not broad itself, and outside every Lisa home. Otherwise we return
 * the resolved `cwd` with `confined: false`, keeping Warden fail-closed.
 */
export function resolveChatWorkspaceRoot(
  cwd: string,
  opts: {
    configuredRoot?: string;
    homeDir?: string;
    lisaHomes?: readonly string[];
  } = {},
): ChatWorkspaceResolution {
  const broadOpts = { homeDir: opts.homeDir, lisaHomes: opts.lisaHomes };
  if (!isBroadWorkspace(cwd, broadOpts)) {
    return { workspaceRoot: realPath(cwd), confined: true };
  }
  const candidate = opts.configuredRoot ?? process.env.LISA_CHAT_WORKSPACE;
  if (
    candidate &&
    path.isAbsolute(candidate) &&
    !isBroadWorkspace(candidate, broadOpts) &&
    !(opts.lisaHomes ?? []).some((lisa) => isInsideProtected(lisa, candidate))
  ) {
    return { workspaceRoot: realPath(candidate), confined: true };
  }
  return { workspaceRoot: cwd ? realPath(cwd) : path.sep, confined: false };
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

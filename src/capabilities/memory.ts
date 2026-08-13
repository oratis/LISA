/**
 * In-memory provider — proof that the seam is real, and a test fixture.
 *
 * Its value is not that tests get faster; it is that a second provider exists
 * at all. If the fs/shell tools can run unmodified against a filesystem that is
 * a `Map`, they can run against a container or a remote host, which is what
 * Dispatch and Cloud need from H1. Every tool test that uses this instead of a
 * tmpdir is also a test that the tool did not smuggle in a direct `node:fs`
 * call behind the seam's back.
 *
 * The shell here refuses to run anything: an in-memory world has no processes.
 * Refusing is deliberate — a stub that silently returned success would let a
 * test pass while the real path was broken.
 */

import path from "node:path";
import type {
  Capabilities,
  ExecOptions,
  ExecResult,
  FsCapability,
  FsDirEntry,
  FsStat,
  ShellCapability,
} from "./types.js";

export interface MemoryFsOptions {
  /** Seed files, keyed by absolute path. */
  files?: Record<string, string>;
  /**
   * Bound the world to this prefix. Paths resolving outside it throw — the
   * same contract H2's sandboxed provider will implement against the OS.
   */
  root?: string;
}

export interface MemoryFs extends FsCapability {
  /** Current contents, keyed by absolute path — for assertions. */
  snapshot(): Record<string, string>;
}

export function createMemoryFs(opts: MemoryFsOptions = {}): MemoryFs {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const root = opts.root;

  const dirsOf = (): Set<string> => {
    const dirs = new Set<string>();
    for (const file of files.keys()) {
      let dir = path.dirname(file);
      while (dir && dir !== path.dirname(dir)) {
        dirs.add(dir);
        dir = path.dirname(dir);
      }
    }
    return dirs;
  };

  const mustExist = (abs: string): string => {
    const content = files.get(abs);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${abs}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    return content;
  };

  return {
    resolvePath(cwd: string, p: string): string {
      const abs = path.resolve(cwd, p);
      if (root && abs !== root && !abs.startsWith(root + path.sep)) {
        throw new Error(`path escapes the workspace root: ${abs} (root ${root})`);
      }
      return abs;
    },
    async stat(abs: string): Promise<FsStat> {
      const content = files.get(abs);
      if (content !== undefined) {
        return {
          isFile: true,
          isDirectory: false,
          size: Buffer.byteLength(content, "utf8"),
        };
      }
      if (dirsOf().has(abs)) {
        return { isFile: false, isDirectory: true, size: 0 };
      }
      const err = new Error(`ENOENT: no such file or directory, stat '${abs}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    },
    async exists(abs: string): Promise<boolean> {
      return files.has(abs) || dirsOf().has(abs);
    },
    async readFile(abs: string): Promise<string> {
      return mustExist(abs);
    },
    async writeFile(abs: string, content: string): Promise<void> {
      files.set(abs, content);
    },
    async readdir(abs: string): Promise<FsDirEntry[]> {
      const prefix = abs.endsWith(path.sep) ? abs : abs + path.sep;
      const seen = new Map<string, FsDirEntry>();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const head = rest.split(path.sep)[0]!;
        const isFile = !rest.includes(path.sep);
        seen.set(head, { name: head, isFile, isDirectory: !isFile });
      }
      if (seen.size === 0 && !dirsOf().has(abs)) {
        const err = new Error(`ENOENT: no such file or directory, scandir '${abs}'`);
        (err as NodeJS.ErrnoException).code = "ENOENT";
        throw err;
      }
      return [...seen.values()];
    },
    async unlink(abs: string): Promise<void> {
      mustExist(abs);
      files.delete(abs);
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(files);
    },
  };
}

/** A shell that has no processes to run, and says so instead of pretending. */
export const refusingShell: ShellCapability = {
  async run(_command: string, _opts: ExecOptions): Promise<ExecResult> {
    throw new Error("shell is unavailable in this execution world");
  },
  async exec(_file: string, _args: string[], _opts: ExecOptions): Promise<ExecResult> {
    throw new Error("shell is unavailable in this execution world");
  },
};

export function createMemoryCapabilities(
  opts: MemoryFsOptions = {},
): Capabilities & { fs: MemoryFs } {
  return { fs: createMemoryFs(opts), shell: refusingShell };
}

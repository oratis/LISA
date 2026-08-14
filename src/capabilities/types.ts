/**
 * Capability seams — the execution world a tool acts on (H1, see
 * docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §2).
 *
 * Before this, every filesystem/shell tool reached straight for `node:fs` and
 * `node:child_process`. That made "where does this tool actually operate" an
 * un-swappable fact baked into fourteen call sites, with three consequences the
 * roadmap keeps running into:
 *
 *  - Dispatch cannot move execution into a container or a remote host without a
 *    second implementation of every tool;
 *  - Cloud multi-tenancy has to delete `read`/`write`/`bash` from the registry
 *    outright (`cloudSafeSubset`) because there is no way to bound them — a
 *    deny-by-omission list is a patch, a bounded execution world is the fix;
 *  - tests can only exercise these tools against the real disk.
 *
 * The shape follows dsh's seam model: a capability is an *interface* (this
 * file), one or more *providers* (`local.ts`, `memory.ts`, and later a sandboxed
 * one), and *consumers* (the tools). Swapping the provider swaps the execution
 * world for every consumer at once, with no change to tool code.
 *
 * `resolvePath` is deliberately part of the fs seam rather than something each
 * tool does with `path.resolve`. It is the single choke point where a policy can
 * reject an escape, which is what makes H2's sandbox a provider swap instead of
 * a check bolted onto seven tools — and what guarantees fs and shell cannot end
 * up bounded to different roots.
 */

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface FsDirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface FsCapability {
  /**
   * Resolve a model-supplied path against the execution world. Providers that
   * bound the world reject escapes here by throwing, so callers can treat the
   * returned path as permitted.
   */
  resolvePath(cwd: string, p: string): string;
  stat(abs: string): Promise<FsStat>;
  exists(abs: string): Promise<boolean>;
  readFile(abs: string): Promise<string>;
  /** Atomic (temp sibling + rename) and creates missing parent directories. */
  writeFile(abs: string, content: string): Promise<void>;
  readdir(abs: string): Promise<FsDirEntry[]>;
  unlink(abs: string): Promise<void>;
}

export interface ExecOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Truncate each of stdout/stderr at this many bytes. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  /** True when stdout or stderr hit `maxOutputBytes`. */
  truncated: boolean;
}

export interface ShellCapability {
  /** Run a shell command string (the `bash` tool's world). */
  run(command: string, opts: ExecOptions): Promise<ExecResult>;
  /**
   * Spawn a program with an argv array — no shell, so no quoting hazard.
   *
   * dsh splits this into a separate `ctx.subprocess` seam. At LISA's size one
   * seam with two operations is enough, but they must stay separate methods:
   * routing an argv array through a shell string is how command injection gets
   * introduced, and `grep` passes a model-supplied pattern.
   */
  exec(file: string, args: string[], opts: ExecOptions): Promise<ExecResult>;
}

/** The execution world handed to tools through `ToolContext.caps`. */
export interface Capabilities {
  fs: FsCapability;
  shell: ShellCapability;
}

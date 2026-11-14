import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RestoreTarget } from "./restore.js";
import { digest, FleetError, uuid } from "./types.js";

export interface Snapshot {
  status: "ready" | "unavailable";
  at: number;
  commit?: string;
  head?: string;
  index?: string;
  changed?: boolean;
  reason?: string;
}
const MAX_FILES = 2000,
  MAX_BYTES = 16 * 1024 * 1024,
  MAX_DIFF = 64 * 1024;
// Do not inherit caller-supplied Git directories, filters, credentials or tracing.
const env = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "LISA",
  GIT_AUTHOR_EMAIL: "fleet@localhost",
  GIT_COMMITTER_NAME: "LISA",
  GIT_COMMITTER_EMAIL: "fleet@localhost",
});
function git(
  cwd: string,
  args: string[],
  input?: string | Buffer,
  extra = {},
  maxBuffer = 4 * 1024 * 1024,
) {
  return execFileSync(
    "git",
    [
      "--literal-pathspecs",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd,
      env: { ...env(), ...extra },
      input,
      timeout: 8000,
      maxBuffer,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}
export function repositoryIdentity(root: string) {
  const top = git(root, ["rev-parse", "--show-toplevel"]).toString().trim();
  if (fs.realpathSync.native(top) !== root) throw new FleetError(400, "git_root_required");
  const dir = git(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  const st = fs.statSync(dir, { bigint: true });
  return `${fs.realpathSync.native(dir)}:${st.dev}:${st.ino}`;
}
/** Only the local owner can create one. A detached checkout starts at the current commit. */
export function createCheckpointWorkspace(source: string) {
  repositoryIdentity(source);
  const root = path.join(path.dirname(source), "lisa-fleet-" + crypto.randomUUID());
  // Worktree checkout otherwise runs user-configured smudge filters. Disable each driver.
  let filters = "";
  try {
    filters = git(source, [
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ]).toString();
  } catch (e) {
    // Exit 1 means no matches. A failed/oversized config read must not enable filters.
    if ((e as { status?: number }).status !== 1) throw e;
  }
  const flags = filters
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((key) => ["-c", key + (key.endsWith(".required") ? "=false" : "=")]);
  git(source, [...flags, "worktree", "add", "--detach", root, "HEAD"]);
  return { root: fs.realpathSync.native(root), gitIdentity: repositoryIdentity(root) };
}

/** Git objects and refs are private to a task, under the agent-denied LISA home.
 * Separate config + temporary indexes avoid hooks, filters and the user's staging area. */
export class FleetCheckpoints {
  constructor(private readonly home: string) {}
  private directory(run: string) {
    return path.join(this.home, "fleet", "checkpoints", uuid(run));
  }
  private command(
    run: string,
    args: string[],
    input?: string | Buffer,
    extra = {},
    maxBuffer?: number,
  ) {
    const dir = this.directory(run);
    return git(dir, ["--git-dir=" + dir, ...args], input, extra, maxBuffer);
  }
  capture(
    run: string,
    turn: number,
    side: "before" | "after",
    root: string,
    expected: string,
    maxStorageBytes = Number.POSITIVE_INFINITY,
  ): Snapshot {
    const at = Date.now();
    let index: string | undefined;
    try {
      if (turn > 100) return { status: "unavailable", at, reason: "checkpoint_limit" };
      if (this.usage() >= maxStorageBytes)
        return { status: "unavailable", at, reason: "checkpoint_quota" };
      if (repositoryIdentity(root) !== expected) throw new Error("workspace_changed");
      const head = () => git(root, ["rev-parse", "HEAD"]).toString().trim();
      const stage = () => digest(git(root, ["ls-files", "--stage", "-z"]).toString());
      const beforeHead = head(),
        beforeIndex = stage();
      const names = [
        ...new Set(
          git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .toString()
            .split("\0")
            .filter(Boolean),
        ),
      ];
      if (names.length > MAX_FILES) return { status: "unavailable", at, reason: "snapshot_limit" };
      const files: string[] = [];
      let bytes = 0;
      for (const name of names) {
        if (path.isAbsolute(name) || name.split("/").some((p) => p === ".." || p === ".git"))
          throw new Error("invalid_path");
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(path.join(root, name));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        // Never traverse a symlinked ancestor or capture submodule contents.
        let part = root;
        for (const component of name.split("/").slice(0, -1)) {
          part = path.join(part, component);
          if (fs.lstatSync(part).isSymbolicLink()) throw new Error("symlink_parent");
        }
        if (stat.isDirectory()) throw new Error("submodule_unsupported");
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("special_file");
        bytes += stat.size;
        if (bytes > MAX_BYTES) return { status: "unavailable", at, reason: "snapshot_limit" };
        files.push(name);
      }
      const dir = this.directory(run);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        git(dir, ["init", "--bare", "--template=", dir]);
        fs.mkdirSync(path.join(dir, "info"), { recursive: true });
        // info/attributes outranks project attributes. Store literal file bytes.
        fs.writeFileSync(
          path.join(dir, "info", "attributes"),
          "* -filter -text -ident -working-tree-encoding\n",
        );
      }
      index = path.join(dir, "index-" + crypto.randomUUID());
      const opts = { GIT_INDEX_FILE: index };
      this.command(run, ["read-tree", "--empty"], undefined, opts);
      if (files.length)
        this.command(
          run,
          [
            "--work-tree=" + root,
            "add",
            "--force",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          files.join("\0") + "\0",
          opts,
        );
      const tree = this.command(run, ["write-tree"], undefined, opts).toString().trim();
      const commit = this.command(run, ["commit-tree", tree], `Fleet turn ${turn} ${side}\n`)
        .toString()
        .trim();
      const ref = `refs/lisa/turns/${turn}/${side}`;
      let previous: string | undefined;
      try {
        previous = this.command(run, ["rev-parse", "--verify", ref]).toString().trim();
      } catch {
        /* new boundary */
      }
      this.command(run, ["update-ref", ref, commit]);
      fs.rmSync(index, { force: true });
      index = undefined;
      if (this.usage() > maxStorageBytes) {
        if (previous) this.command(run, ["update-ref", ref, previous]);
        else this.command(run, ["update-ref", "-d", ref]);
        this.command(run, ["prune", "--expire=now"]);
        return { status: "unavailable", at, reason: "checkpoint_quota" };
      }
      // A changed HEAD/index is evidence of another actor, even if its commit hid the diff.
      return {
        status: "ready",
        at,
        commit,
        head: beforeHead,
        index: beforeIndex,
        changed: beforeHead !== head() || beforeIndex !== stage(),
      };
    } catch {
      return { status: "unavailable", at, reason: "snapshot_unavailable" };
    } finally {
      if (index) {
        try {
          fs.rmSync(index, { force: true });
          fs.rmSync(index + ".lock", { force: true });
        } catch {
          /* Task cleanup removes leftover private temporary indexes. */
        }
      }
    }
  }
  diff(run: string, before: Snapshot, after: Snapshot, file?: number) {
    if (before.status !== "ready" || after.status !== "ready" || !before.commit || !after.commit)
      throw new FleetError(409, "checkpoint_unavailable");
    const revisions = [before.commit, after.commit];
    try {
      const raw = this.command(run, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-status",
        "-z",
        ...revisions,
        "--",
      ])
        .toString()
        .split("\0");
      const files: { id: number; path: string; status: string }[] = [];
      for (let i = 0; i + 1 < raw.length; i += 2)
        files.push({ id: files.length, status: raw[i]!, path: raw[i + 1]! });
      const concurrent =
        before.changed ||
        after.changed ||
        before.head !== after.head ||
        before.index !== after.index;
      if (file === undefined) return { files, concurrent: !!concurrent };
      const selected = files[file];
      if (!selected) throw new FleetError(404, "file_not_found");
      let output: Buffer,
        truncated = false;
      try {
        output = this.command(run, [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--no-color",
          "--unified=3",
          ...revisions,
          "--",
          selected.path,
        ]);
      } catch (e) {
        const err = e as { code?: string; stdout?: Buffer };
        if (err.code !== "ENOBUFS" || !err.stdout) throw e;
        output = err.stdout;
        truncated = true;
      }
      return {
        file: selected,
        patch: output.subarray(0, MAX_DIFF).toString("utf8"),
        truncated: truncated || output.length > MAX_DIFF,
        concurrent: !!concurrent,
      };
    } catch (e) {
      if (e instanceof FleetError) throw e;
      throw new FleetError(409, "checkpoint_unavailable");
    }
  }
  restoreTarget(run: string, before: Snapshot, after: Snapshot, file: number): RestoreTarget {
    const list = this.diff(run, before, after);
    if (!list.files) throw new FleetError(409, "checkpoint_unavailable");
    const selected = list.files[file];
    if (!selected) throw new FleetError(404, "file_not_found");
    const row = this.command(run, [
      "ls-tree",
      "-z",
      before.commit!,
      "--",
      selected.path,
    ]).toString();
    if (!row) return { path: selected.path, exists: false, content: Buffer.alloc(0), mode: 0 };
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(row);
    if (!match) throw new FleetError(409, "restore_regular_file_required");
    const content = this.command(
      run,
      ["cat-file", "blob", match[2]!],
      undefined,
      {},
      MAX_BYTES + 1,
    );
    if (content.length > MAX_BYTES) throw new FleetError(409, "restore_file_limit");
    return {
      path: selected.path,
      exists: true,
      content,
      mode: match[1] === "100755" ? 0o755 : 0o644,
    };
  }
  /** Private Git storage only; do not follow links when accounting for quota. */
  usage() {
    const directory = path.join(this.home, "fleet", "checkpoints");
    const size = (entry: string): number => {
      const st = fs.lstatSync(entry);
      if (st.isSymbolicLink()) throw new FleetError(409, "checkpoint_storage_changed");
      if (st.isDirectory())
        return fs.readdirSync(entry).reduce((n, child) => n + size(path.join(entry, child)), 0);
      if (!st.isFile()) throw new FleetError(409, "checkpoint_storage_changed");
      return Math.max(st.size, Number.isFinite(st.blocks) ? st.blocks * 512 : st.size);
    };
    try {
      return size(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }
  clearAll() {
    fs.rmSync(path.join(this.home, "fleet", "checkpoints"), { recursive: true, force: true });
  }
  clear(run: string) {
    fs.rmSync(this.directory(run), { recursive: true, force: true });
  }
}

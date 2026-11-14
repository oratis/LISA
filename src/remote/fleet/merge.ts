import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FleetCheckpoints, fleetGit, repositoryIdentity, type Snapshot } from "./checkpoints.js";
import { digest, FleetError } from "./types.js";

export interface MergeOrigin {
  root: string;
  identity: string;
  base: string;
  branch: string;
}
function flags(root: string) {
  let keys = "";
  try {
    keys = fleetGit(root, [
      "config",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ]).toString();
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
  return [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "merge.autostash=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    ...keys
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((key) => ["-c", key + (key.endsWith(".required") ? "=false" : "=")]),
  ];
}
/** Refuse hidden index entries and every tracked/untracked working change. */
export function sourceState(origin: MergeOrigin) {
  const { root } = origin;
  if (
    repositoryIdentity(root) !== origin.identity ||
    fleetGit(root, ["rev-parse", "HEAD"]).toString().trim() !== origin.base ||
    fleetGit(root, ["symbolic-ref", "HEAD"]).toString().trim() !== origin.branch
  )
    throw new FleetError(409, "merge_source_changed");
  const safe = flags(root);
  const entries = fleetGit(root, ["ls-files", "-v", "-z"]).toString().split("\0").filter(Boolean);
  if (entries.some((e) => e[0] !== "H")) throw new FleetError(409, "merge_hidden_index");
  if (
    fleetGit(root, [
      ...safe,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ]).length
  )
    throw new FleetError(409, "merge_source_dirty");
  return digest(
    Buffer.concat([
      fleetGit(root, ["config", "--null", "--list"]),
      fleetGit(root, ["ls-files", "--stage", "-z"]),
    ]),
  );
}

/** Build a candidate using immutable snapshot bytes, private index and private objects.
 * The original repository is read-only until execute() is called after a durable receipt. */
export function prepareMerge(
  home: string,
  checkpoints: FleetCheckpoints,
  run: string,
  snapshot: Snapshot,
  origin: MergeOrigin,
) {
  const initial = sourceState(origin);
  const parent = path.join(home, "fleet", "merges");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(parent, "merge-"));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    const treeRoot = path.join(directory, "tree"),
      objects = path.join(directory, "objects");
    fs.mkdirSync(treeRoot);
    fs.mkdirSync(path.join(objects, "info"), { recursive: true });
    const gitDir = fleetGit(origin.root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
    const objectDir = fs.realpathSync.native(
      path.resolve(
        origin.root,
        fleetGit(origin.root, ["rev-parse", "--git-path", "objects"]).toString().trim(),
      ),
    );
    if (/[\r\n]/.test(objectDir)) throw new FleetError(409, "merge_file_unsupported");
    fs.writeFileSync(path.join(objects, "info", "alternates"), objectDir + "\n");
    const names = checkpoints.materialize(run, snapshot, treeRoot);
    const safe = flags(origin.root);
    const command = (args: string[], input?: string | Buffer) =>
      fleetGit(
        origin.root,
        [...safe, "--git-dir=" + gitDir, "--work-tree=" + treeRoot, ...args],
        input,
        { GIT_INDEX_FILE: path.join(directory, "index"), GIT_OBJECT_DIRECTORY: objects },
        20 * 1024 * 1024,
      );
    command(["read-tree", "--empty"]);
    if (names.length)
      command(
        ["add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
        names.join("\0") + "\0",
      );
    const tree = command(["write-tree"]).toString().trim();
    const rows = command([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-status",
      "-z",
      origin.base,
      tree,
      "--",
    ])
      .toString()
      .split("\0")
      .filter(Boolean);
    const files: { status: string; path: string }[] = [];
    for (let i = 0; i < rows.length; i += 2) files.push({ status: rows[i]!, path: rows[i + 1]! });
    if (!files.length) throw new FleetError(409, "merge_no_changes");
    // Git can overwrite ignored files during checkout. Refuse collisions, including
    // symlinked or non-directory ancestors, before offering the preview.
    for (const file of files.filter((f) => f.status === "A")) {
      let location = origin.root;
      for (const [i, component] of file.path.split("/").entries()) {
        location = path.join(location, component);
        try {
          const st = fs.lstatSync(location);
          if (i === file.path.split("/").length - 1 || !st.isDirectory() || st.isSymbolicLink())
            throw new FleetError(409, "merge_path_collision");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    }
    const patch = command([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      origin.base,
      tree,
      "--",
    ]);
    if (sourceState(origin) !== initial) throw new FleetError(409, "merge_source_changed");
    return {
      tree,
      fingerprint: initial,
      files,
      patch: patch.subarray(0, 64 * 1024).toString(),
      truncated: patch.length > 64 * 1024,
      dispose,
      execute(beforeCheckout: (commit: string) => void) {
        if (sourceState(origin) !== initial) throw new FleetError(409, "merge_source_changed");
        const commit = command(["commit-tree", tree, "-p", origin.base], `Fleet task ${run}\n`)
          .toString()
          .trim();
        // Import only new loose objects. A final object name is installed atomically;
        // an existing object is never overwritten, and packs/alternates are not copied.
        for (const prefix of fs.readdirSync(objects).filter((p) => /^[a-f0-9]{2}$/.test(p))) {
          const destination = path.join(objectDir, prefix);
          fs.mkdirSync(destination, { recursive: true });
          for (const name of fs.readdirSync(path.join(objects, prefix))) {
            if (!/^[a-f0-9]{38,62}$/.test(name)) throw new FleetError(409, "merge_objects_changed");
            const temp = path.join(destination, ".lisa-" + crypto.randomUUID());
            try {
              fs.copyFileSync(path.join(objects, prefix, name), temp, fs.constants.COPYFILE_EXCL);
              const fd = fs.openSync(temp, "r");
              try {
                fs.fsyncSync(fd);
              } finally {
                fs.closeSync(fd);
              }
              try {
                fs.linkSync(temp, path.join(destination, name));
              } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
              }
            } finally {
              fs.rmSync(temp, { force: true });
            }
          }
        }
        beforeCheckout(commit);
        if (sourceState(origin) !== initial) throw new FleetError(409, "merge_source_changed");
        fleetGit(origin.root, [...safe, "merge", "--ff-only", "--no-edit", "--no-verify", commit]);
        if (
          fleetGit(origin.root, ["rev-parse", "HEAD"]).toString().trim() !== commit ||
          fleetGit(origin.root, ["symbolic-ref", "HEAD"]).toString().trim() !== origin.branch
        )
          throw new FleetError(409, "merge_source_changed");
        return commit;
      },
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

export function cleanupOwnedWorktree(source: string, root: string) {
  // Untracked ignored content was intentionally excluded from snapshots; never erase it.
  if (fleetGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).length)
    throw new FleetError(409, "worktree_contains_ignored_files");
  fleetGit(source, [...flags(source), "worktree", "remove", "--force", root]);
}

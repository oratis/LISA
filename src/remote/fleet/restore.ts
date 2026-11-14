import fs from "node:fs";
import path from "node:path";
import { digest, FleetError } from "./types.js";

const MAX_BYTES = 16 * 1024 * 1024;
export interface FileState {
  exists: boolean;
  content: Buffer;
  mode: number;
  fingerprint: string;
}
export interface RestoreTarget {
  path: string;
  exists: boolean;
  content: Buffer;
  mode: number;
}

function parents(root: string, name: string) {
  const parts = name.split("/");
  if (
    !name ||
    path.isAbsolute(name) ||
    name.includes("\\") ||
    parts.some((p) => !p || [".", "..", ".git"].includes(p.toLowerCase()))
  )
    throw new FleetError(409, "unsafe_restore_path");
  const identities: string[] = [];
  let current = root;
  for (const part of ["", ...parts.slice(0, -1)]) {
    current = path.join(current, part);
    const st = fs.lstatSync(current, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) throw new FleetError(409, "unsafe_restore_path");
    identities.push(`${st.dev}:${st.ino}`);
  }
  return identities.join("/");
}
function identity(st: fs.BigIntStats) {
  return [st.dev, st.ino, st.mode, st.nlink, st.size, st.mtimeNs, st.ctimeNs].join(":");
}
function readOpen(fd: number) {
  const before = fs.fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new FleetError(409, "unsafe_restore_path");
  if (before.size > MAX_BYTES) throw new FleetError(409, "restore_file_limit");
  const data = Buffer.alloc(Number(before.size) + 1);
  let count = 0;
  while (count < data.length) {
    const n = fs.readSync(fd, data, count, data.length - count, count);
    if (!n) break;
    count += n;
  }
  const after = fs.fstatSync(fd, { bigint: true });
  if (identity(before) !== identity(after) || count !== Number(before.size))
    throw new FleetError(409, "restore_file_changed");
  return { content: data.subarray(0, count), stat: after };
}

/** Read literal bytes, never a symlink, hardlink, special file or symlinked parent. */
export function restoreState(root: string, name: string): FileState {
  let fd: number | undefined;
  try {
    const ancestry = parents(root, name),
      file = path.join(root, name);
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return {
        exists: false,
        content: Buffer.alloc(0),
        mode: 0,
        fingerprint: digest(ancestry + ":absent"),
      };
    }
    const { content, stat } = readOpen(fd);
    if (
      parents(root, name) !== ancestry ||
      identity(fs.lstatSync(file, { bigint: true })) !== identity(stat)
    )
      throw new FleetError(409, "restore_file_changed");
    return {
      exists: true,
      content,
      mode: Number(stat.mode & 0o777n),
      fingerprint: digest(JSON.stringify([ancestry, identity(stat), digest(content)])),
    };
  } catch (err) {
    if (err instanceof FleetError) throw err;
    throw new FleetError(409, "unsafe_restore_path");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The caller records an unknown receipt before entering this side effect. */
export function restoreFile(root: string, target: RestoreTarget, expected: string) {
  const current = restoreState(root, target.path);
  if (current.fingerprint !== expected) throw new FleetError(409, "restore_file_changed");
  const file = path.join(root, target.path),
    ancestry = parents(root, target.path);
  let fd: number | undefined;
  try {
    if (!target.exists) {
      if (current.exists) {
        // Recheck immediately before unlink; no asynchronous work intervenes.
        if (restoreState(root, target.path).fingerprint !== expected)
          throw new FleetError(409, "restore_file_changed");
        fs.unlinkSync(file);
      }
      return;
    }
    if (target.content.length > MAX_BYTES) throw new FleetError(409, "restore_file_limit");
    if (!current.exists) {
      fd = fs.openSync(
        file,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        target.mode,
      );
    } else {
      fd = fs.openSync(
        file,
        fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      const opened = readOpen(fd);
      const fingerprint = digest(
        JSON.stringify([ancestry, identity(opened.stat), digest(opened.content)]),
      );
      if (fingerprint !== expected) throw new FleetError(409, "restore_file_changed");
    }
    if (parents(root, target.path) !== ancestry) throw new FleetError(409, "restore_file_changed");
    // Work through the validated descriptor; never reopen a path with truncation.
    let written = 0;
    while (written < target.content.length) {
      const n = fs.writeSync(fd, target.content, written, target.content.length - written, written);
      if (!n) throw new FleetError(503, "restore_write_failed");
      written += n;
    }
    fs.ftruncateSync(fd, target.content.length);
    fs.fchmodSync(fd, target.mode);
    fs.fsyncSync(fd);
    const result = restoreState(root, target.path);
    if (!result.content.equals(target.content) || result.mode !== target.mode)
      throw new FleetError(409, "restore_file_changed");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function fileSummary(file: Pick<FileState, "exists" | "content" | "mode">) {
  const text = file.content.toString("utf8");
  const binary = file.content.includes(0) || !Buffer.from(text).equals(file.content);
  return {
    exists: file.exists,
    bytes: file.content.length,
    mode: file.mode,
    sha256: digest(file.content),
    binary,
    text: binary ? "" : file.content.subarray(0, 64 * 1024).toString("utf8"),
    truncated: !binary && file.content.length > 64 * 1024,
  };
}

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome, lisaHome, scopedUid } from "./paths.js";

/** Validate every existing ancestor under the configured home. The configured
 * local home may itself be a symlink. Hosted account directories may not. */
export async function assertHomeDirectory(dir: string): Promise<void> {
  const home = path.resolve(lisaHome());
  const target = path.resolve(dir);
  const relative = path.relative(home, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("path outside the active home");
  }
  let current = scopedUid() ? path.resolve(lisaGlobalHome()) : home;
  for (const component of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (!(await fs.lstat(current)).isDirectory()) throw new Error("unsafe home directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** Pin the opened regular file so a subsequent rename cannot redirect a read. */
export async function openHomeFile(file: string) {
  await assertHomeDirectory(path.dirname(file));
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error("expected a regular home file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readHomeText(file: string, maxBytes?: number): Promise<string> {
  const handle = await openHomeFile(file);
  try {
    if (maxBytes === undefined) return await handle.readFile("utf8");
    const stats = await handle.stat();
    if (stats.size > maxBytes) throw new Error("home file exceeds read limit");
    // Read at most one byte beyond the recorded size limit, even for a growing file.
    const chunks: Buffer[] = [];
    for await (const chunk of handle.createReadStream({ end: maxBytes, autoClose: false }))
      chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > maxBytes) throw new Error("home file exceeds read limit");
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readHomeTextOrEmpty(file: string, maxBytes?: number): Promise<string> {
  try {
    return await readHomeText(file, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

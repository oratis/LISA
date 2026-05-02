import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextOrEmpty(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export async function atomicWrite(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, p);
}

export async function appendLine(p: string, line: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, line + "\n", "utf8");
}

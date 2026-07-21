import fsp from "node:fs/promises";
import path from "node:path";
import { lisaHome } from "../paths.js";

/**
 * Pointer to the currently-live web session. Written when the web server
 * starts a session (or resumes one), read on next startup so a redeploy
 * (or any restart) keeps the same conversation thread.
 */
function activeWebSessionFile(): string {
  return path.join(lisaHome(), "active-web-session.txt");
}

export async function readActiveWebSession(): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(activeWebSessionFile(), "utf8")).trim();
    return raw || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeActiveWebSession(id: string): Promise<void> {
  await fsp.writeFile(activeWebSessionFile(), id, "utf8");
}

export async function clearActiveWebSession(): Promise<void> {
  try {
    await fsp.unlink(activeWebSessionFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

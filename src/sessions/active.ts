import fsp from "node:fs/promises";
import path from "node:path";
import { LISA_HOME } from "../paths.js";

/**
 * Pointer to the currently-live web session. Written when the web server
 * starts a session (or resumes one), read on next startup so a redeploy
 * (or any restart) keeps the same conversation thread.
 */
const ACTIVE_WEB_SESSION_FILE = path.join(LISA_HOME, "active-web-session.txt");

export async function readActiveWebSession(): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(ACTIVE_WEB_SESSION_FILE, "utf8")).trim();
    return raw || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeActiveWebSession(id: string): Promise<void> {
  await fsp.writeFile(ACTIVE_WEB_SESSION_FILE, id, "utf8");
}

export async function clearActiveWebSession(): Promise<void> {
  try {
    await fsp.unlink(ACTIVE_WEB_SESSION_FILE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

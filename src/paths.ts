import os from "node:os";
import path from "node:path";

export const LISA_HOME =
  process.env.LISA_HOME ?? path.join(os.homedir(), ".lisa");

export const SKILLS_DIR = path.join(LISA_HOME, "skills");
export const MEMORY_DIR = path.join(LISA_HOME, "memory");
export const SESSIONS_DIR = path.join(LISA_HOME, "sessions");
export const REFLECTIONS_DIR = path.join(LISA_HOME, "reflections");

export const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
export const USER_FILE = path.join(MEMORY_DIR, "USER.md");

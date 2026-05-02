import fs from "node:fs";
import path from "node:path";
import { LISA_HOME } from "./paths.js";

export const CONFIG_ENV_PATH = path.join(LISA_HOME, "config.env");

export function loadConfigEnv(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_ENV_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const [key, value] of parseEnv(raw)) {
    const existing = process.env[key];
    if (existing === undefined || existing === "") {
      process.env[key] = value;
    }
  }
}

export function* parseEnv(raw: string): Generator<[string, string]> {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    yield [key, unquote(line.slice(eq + 1).trim())];
  }
}

function stripInlineComment(line: string): string {
  if (line.startsWith("#")) return "";
  if (/^\s*[A-Za-z_]/.test(line)) {
    const eq = line.indexOf("=");
    if (eq < 0) return line;
    const value = line.slice(eq + 1);
    if (value.startsWith('"') || value.startsWith("'")) return line;
    const hash = value.indexOf(" #");
    if (hash < 0) return line;
    return line.slice(0, eq + 1) + value.slice(0, hash);
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === last && (first === '"' || first === "'")) {
      const inner = value.slice(1, -1);
      return first === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, "\n") : inner;
    }
  }
  return value;
}

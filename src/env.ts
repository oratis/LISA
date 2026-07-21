import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { lisaGlobalHome } from "./paths.js";
import { ensureDir } from "./fs-utils.js";

export const CONFIG_ENV_PATH = path.join(lisaGlobalHome(), "config.env");

/**
 * Update or insert keys in ~/.lisa/config.env, preserving other variables,
 * comments, and ordering. Also updates process.env so the running process
 * sees the new values without restart. File mode is 0600.
 */
export async function saveConfigEnv(updates: Record<string, string>): Promise<void> {
  let raw = "";
  try {
    raw = await fsp.readFile(CONFIG_ENV_PATH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const remaining = new Map(Object.entries(updates));
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const line of lines) {
    const stripped = stripInlineComment(line).trim();
    if (!stripped || stripped.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = stripped.slice(0, eq).trim().replace(/^export\s+/, "");
    if (remaining.has(key)) {
      out.push(`${key}=${quoteValue(remaining.get(key)!)}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of remaining) {
    out.push(`${key}=${quoteValue(value)}`);
  }

  let serialized = out.join("\n");
  if (!serialized.endsWith("\n")) serialized += "\n";

  await ensureDir(path.dirname(CONFIG_ENV_PATH));
  await fsp.writeFile(CONFIG_ENV_PATH, serialized, { mode: 0o600 });
  try {
    await fsp.chmod(CONFIG_ENV_PATH, 0o600);
  } catch {
    // best effort — non-POSIX filesystems may reject chmod
  }

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

function quoteValue(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9_\-./:+@]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

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
      // Reverse the escaping done by quoteValue: \\ → \, \" → ", \n → newline.
      // Single-pass via callback so a literal backslash before n (`\\n` in the
      // file) decodes to `\n` (two chars) rather than a newline.
      return first === '"'
        ? inner.replace(/\\(["\\n])/g, (_, c) => (c === "n" ? "\n" : c))
        : inner;
    }
  }
  return value;
}

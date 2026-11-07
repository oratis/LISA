import type { SkillFrontmatter } from "../types.js";

const FENCE = "---";

export interface ParsedFrontmatter {
  frontmatter: SkillFrontmatter;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  if (!raw.startsWith(FENCE)) return null;
  const end = raw.indexOf(`\n${FENCE}`, FENCE.length);
  if (end < 0) return null;
  const yamlBlock = raw.slice(FENCE.length, end).trim();
  const body = raw.slice(end + FENCE.length + 1).replace(/^\n/, "");
  const fm = parseSimpleYaml(yamlBlock);
  if (typeof fm.name !== "string" || typeof fm.description !== "string") {
    return null;
  }
  const frontmatter: SkillFrontmatter = {
    name: fm.name,
    description: fm.description,
    version: typeof fm.version === "string" ? fm.version : undefined,
    tags: Array.isArray(fm.tags)
      ? fm.tags.filter((t): t is string => typeof t === "string")
      : undefined,
  };
  return { frontmatter, body };
}

export function buildFrontmatter(fm: SkillFrontmatter, body: string): string {
  const lines: string[] = [FENCE];
  lines.push(`name: ${escapeScalar(fm.name)}`);
  lines.push(`description: ${escapeScalar(fm.description)}`);
  if (fm.version) lines.push(`version: ${escapeScalar(fm.version)}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(escapeScalar).join(", ")}]`);
  }
  lines.push(FENCE, "");
  return lines.join("\n") + body.replace(/^\n+/, "");
}

function escapeScalar(s: string): string {
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trimEnd();
    // Only top-level metadata belongs to the skill. Nested keys must not
    // replace its name or description. A "#" is a comment only at the start
    // of a line: descriptions such as "Fix PR #12" or "Build C# apps" keep it.
    if (!line || /^[\s#]/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const valueRaw = line.slice(colon + 1).trim();
    if (/^[>|][-+]?$/.test(valueRaw)) {
      const content: string[] = [];
      while (
        index + 1 < lines.length &&
        (!lines[index + 1]!.trim() || /^\s/.test(lines[index + 1]!))
      ) {
        content.push(lines[++index]!);
      }
      const indents = content
        .filter((part) => part.trim())
        .map((part) => part.match(/^ */)![0].length);
      const indent = Math.min(...indents);
      const parts = content.map((part) => (part.trim() ? part.slice(indent) : ""));
      // Literal (|) keeps every line break. Folded (>) joins adjacent text
      // lines with a space; each blank line becomes one line break, and
      // more-indented lines keep theirs.
      const folded = valueRaw.startsWith(">");
      let text = "";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i > 0) {
          const previous = parts[i - 1]!;
          if (!folded || !part || /^\s/.test(part) || /^\s/.test(previous)) text += "\n";
          else if (previous) text += " ";
        }
        text += part;
      }
      out[key] = text.trimEnd();
    } else out[key] = parseYamlValue(valueRaw);
  }
  return out;
}

function parseYamlValue(raw: string): unknown {
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseYamlValue(part.trim()));
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    try {
      return raw.startsWith("'") ? raw.slice(1, -1).replaceAll("''", "'") : JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

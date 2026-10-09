import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { coverageOf, HOME_ENTRIES } from "./coverage.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "assets") sourceFiles(p, out);
    } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** An expression that evaluates to a home directory. */
const HOME_CALL = String.raw`(?:lisaHome|lisaGlobalHome)\(\)|homeForUid\([^()]*\)|process\.env\.LISA_HOME\s*\?\?\s*path\.join\(os\.homedir\(\),\s*"\.lisa"\)`;

/**
 * Top-level names the code creates under a home: `join(<home>, "name", …)`
 * and `${<home>}/name`, where <home> is a home call or a variable / default
 * parameter assigned from one in the same file.
 */
function homeEntriesInSource(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (name: string, file: string) => {
    const list = found.get(name) ?? [];
    list.push(path.relative(SRC, file));
    found.set(name, list);
  };
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, "utf8");
    const vars = new Set<string>();
    for (const m of src.matchAll(
      new RegExp(String.raw`(\w+)\s*(?::\s*string)?\s*=\s*(?:${HOME_CALL})`, "g"),
    )) {
      vars.add(m[1]!);
    }
    const home = [HOME_CALL, ...[...vars].map((v) => String.raw`\b${v}\b`)].join("|");
    for (const m of src.matchAll(
      new RegExp(String.raw`join\(\s*(?:${home})\s*,\s*(["'\x60])([^"'\x60$]+?)\1`, "g"),
    )) {
      add(m[2]!.split("/")[0]!, file);
    }
    for (const m of src.matchAll(new RegExp(String.raw`\$\{(?:${home})\}/([^/"'\x60$]+)`, "g"))) {
      add(m[1]!, file);
    }
  }
  return found;
}

describe("forget coverage", () => {
  test("every top-level home entry in the code is classified for forget", () => {
    const found = homeEntriesInSource();
    // The scan itself must keep working: these are created by well-known modules.
    for (const known of ["soul", "memory", "kb", "sessions", "tasks", "mail", "sense", "warden"]) {
      assert.ok(found.has(known), `source scan no longer finds ${known}/`);
    }
    const missing = [...found]
      .filter(([name]) => !coverageOf(name))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    assert.deepEqual(
      missing,
      [],
      "new home entries must be classified in src/sovereignty/coverage.ts (scanned, not_scanned, no_user_text or other)",
    );
  });

  test("the scanned areas are the ones forget handles", () => {
    assert.deepEqual(
      Object.entries(HOME_ENTRIES)
        .filter(([, v]) => v.forget === "scanned")
        .map(([k]) => k)
        .sort(),
      ["embeddings", "kb", "memory", "reflections", "sessions", "soul", "tasks"],
    );
  });
});

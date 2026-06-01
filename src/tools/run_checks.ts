/**
 * run_checks (vibe-coding) — the quality gate. Auto-detects the repo's own
 * checks (typecheck / lint / test / build from package.json scripts) and runs
 * them, reporting pass/fail + the tail of any failure. "Lisa, does the agent's
 * work pass?" before you commit or merge.
 *
 * Runs the project's OWN scripts (npm/pnpm/yarn run <script>) — same trust as
 * running them yourself; capped per-check by a timeout.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { runIn, isDir, gitRoot } from "./exec-util.js";

interface RunChecksInput {
  cwd?: string;
  /** Subset to run, e.g. ["test","typecheck"]. Omit = all detected. */
  only?: string[];
}

/** Preferred order — fast/cheap signals first, slow build last. */
const CHECK_PRIORITY = ["typecheck", "lint", "test", "build"] as const;
/** Script-name aliases mapped onto a canonical check. */
const ALIASES: Record<string, string> = {
  typecheck: "typecheck",
  tsc: "typecheck",
  "type-check": "typecheck",
  lint: "lint",
  eslint: "lint",
  test: "test",
  tests: "test",
  build: "build",
  check: "lint",
};

export interface DetectedCheck {
  name: string; // canonical (typecheck/lint/test/build)
  script: string; // the package.json script key to run
}

/** Pure: pick which checks to run from a scripts map. Exported for tests. */
export function detectChecks(scripts: Record<string, string>, only?: string[]): DetectedCheck[] {
  const onlySet = only && only.length ? new Set(only.map((s) => s.toLowerCase())) : null;
  const byCanon = new Map<string, string>(); // canonical → script key (first wins)
  for (const key of Object.keys(scripts)) {
    const canon = ALIASES[key.toLowerCase()];
    if (!canon) continue;
    if (!byCanon.has(canon)) byCanon.set(canon, key);
  }
  const out: DetectedCheck[] = [];
  for (const canon of CHECK_PRIORITY) {
    if (!byCanon.has(canon)) continue;
    if (onlySet && !onlySet.has(canon)) continue;
    out.push({ name: canon, script: byCanon.get(canon)! });
  }
  return out;
}

function tail(s: string, n: number): string {
  const lines = s.split("\n").filter((l) => l.length);
  return lines.slice(-n).join("\n");
}

export const runChecksTool: ToolDefinition<RunChecksInput, string> = {
  name: "run_checks",
  description:
    "Run a repo's own quality checks (typecheck, lint, test, build — auto-detected from package.json " +
    "scripts) and report pass/fail with the tail of any failure. Use to verify an agent's work before " +
    "committing/merging, or when the user asks 'does it pass / are tests green'. Runs the project's own " +
    "npm/pnpm/yarn scripts (capped by a per-check timeout). Narrow with only:['test'] etc.",
  inputSchema: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Absolute path inside the repo. Defaults to the current directory." },
      only: { type: "array", items: { type: "string" }, description: "Subset: any of typecheck/lint/test/build. Omit to run all detected." },
    },
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cwd = input.cwd && input.cwd.startsWith("/") ? input.cwd : ctx.cwd;
    if (!(await isDir(cwd))) return `(not a directory: ${cwd})`;
    const root = (await gitRoot(cwd, ctx.signal)) ?? cwd;

    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
      scripts = (pkg.scripts as Record<string, string>) ?? {};
    } catch {
      return "(no package.json with scripts found — run_checks currently supports Node/npm projects)";
    }
    const checks = detectChecks(scripts, input.only);
    if (checks.length === 0) {
      return `(no recognised check scripts in package.json; available: ${Object.keys(scripts).join(", ") || "none"})`;
    }

    // Pick the package manager from the lockfile.
    const has = async (f: string) => isDir(root).then(() => readFile(path.join(root, f)).then(() => true).catch(() => false));
    let pm = "npm";
    if (await has("pnpm-lock.yaml")) pm = "pnpm";
    else if (await has("yarn.lock")) pm = "yarn";
    else if (await has("bun.lockb")) pm = "bun";

    const results: string[] = [];
    const failures: string[] = [];
    for (const c of checks) {
      const r = await runIn(root, pm, ["run", c.script], { timeoutMs: 240_000, signal: ctx.signal, maxBytes: 200_000 });
      if (r.spawnError) {
        results.push(`✗ ${c.name} (couldn't run ${pm})`);
        continue;
      }
      if (r.timedOut) {
        results.push(`⏱ ${c.name} (timed out at 240s)`);
        continue;
      }
      if (r.code === 0) {
        results.push(`✓ ${c.name}`);
      } else {
        results.push(`✗ ${c.name} (exit ${r.code})`);
        const out = tail(r.stdout + "\n" + r.stderr, 20);
        failures.push(`── ${c.name} (${pm} run ${c.script}) ──\n${out}`);
      }
    }
    const head = `${root.split("/").pop()}: ${results.join("  ")}`;
    return failures.length ? `${head}\n\n${failures.join("\n\n")}` : head;
  },
};

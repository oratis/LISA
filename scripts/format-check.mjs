// Prettier gate, scoped to what THIS branch changed.
//
// The repo predates Prettier: running `prettier --check .` today reports
// thousands of files, and reformatting them in one commit would collide with
// every in-flight branch and destroy `git blame` on 60k lines. So the gate is
// incremental — only files changed against the merge-base with the trunk have
// to be formatted. Every touched file gets cleaned up as it is edited, and the
// repo converges without a big-bang commit.
//
//   node scripts/format-check.mjs          # check (exit 1 on unformatted)
//   node scripts/format-check.mjs --write  # format them in place
//   node scripts/format-check.mjs --all    # ignore git, use the whole repo
//
// Base ref: $FORMAT_BASE_REF, else origin/<trunk>, else <trunk>, where trunk
// is $GITHUB_BASE_REF (PR builds) or "main".
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const write = args.has("--write") || args.has("--fix");
const all = args.has("--all");

/** Prettier's own parsers, minus the ones .prettierignore excludes anyway. */
const EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".yml",
  ".yaml",
  ".html",
]);

function git(...argv) {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
}

function tryGit(...argv) {
  try {
    return git(...argv);
  } catch {
    return null;
  }
}

/** Merge-base with the trunk, so we diff what this branch added — not what it lags behind. */
function resolveBase() {
  const trunk = process.env.GITHUB_BASE_REF || "main";
  const candidates = [process.env.FORMAT_BASE_REF, `origin/${trunk}`, trunk].filter(Boolean);
  for (const ref of candidates) {
    const sha = tryGit("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    if (!sha) continue;
    const base = tryGit("merge-base", "HEAD", sha);
    if (base) return { ref, base };
  }
  return null;
}

function changedFiles(base) {
  // Committed changes plus the working tree, so `--write` fixes what you are
  // about to commit and the check matches what CI will see.
  const names = new Set();
  for (const out of [
    tryGit("diff", "--name-only", "--diff-filter=ACMR", base, "--"),
    tryGit("diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--"),
    tryGit("ls-files", "--others", "--exclude-standard"),
  ]) {
    for (const line of (out ?? "").split("\n")) if (line) names.add(line);
  }
  return [...names];
}

function allFiles() {
  return git("ls-files").split("\n").filter(Boolean);
}

const base = all ? null : resolveBase();
if (!all && !base) {
  // A shallow clone or a detached checkout with no trunk: don't fail the build
  // over a gate we cannot scope. CI fetches enough history for this to work.
  console.error(
    "format-check: no base ref found (tried FORMAT_BASE_REF, origin/main, main); skipping",
  );
  process.exit(0);
}

const candidates = (all ? allFiles() : changedFiles(base.base))
  .filter((f) => EXTENSIONS.has(path.extname(f)))
  .filter((f) => fs.existsSync(path.join(root, f)))
  .sort();

if (candidates.length === 0) {
  console.log(`format-check: no formattable files changed against ${all ? "(all)" : base.ref}`);
  process.exit(0);
}

const prettier = process.platform === "win32" ? "prettier.cmd" : "prettier";
const bin = path.join(root, "node_modules", ".bin", prettier);
const result = spawnSync(bin, [write ? "--write" : "--check", "--ignore-unknown", ...candidates], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(`format-check: could not run prettier (${result.error.message}); run npm ci`);
  process.exit(1);
}
if (result.status !== 0 && !write) {
  console.error(
    `\nformat-check: ${candidates.length} file(s) changed against ${all ? "(all)" : base.ref} were checked.` +
      `\nRun \`npm run format\` to fix them. Only changed files are gated — the repo is not fully formatted yet.`,
  );
}
process.exit(result.status ?? 1);

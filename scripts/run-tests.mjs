// Runs the node:test suite: `node --import tsx --test <every src/**/*.test.ts>`.
//
// package.json used to pass the glob straight to `node --test`, which only
// works on Node 22+ — Node 20 (the floor in `engines`) prints "Could not find
// 'src/**/*.test.ts'" and exits 1, so the suite silently did not run on the
// oldest runtime we claim to support. Expanding the glob here instead keeps one
// command working across the whole 20/22/24 CI matrix, and does not depend on
// the shell's globbing either (npm runs scripts through sh on POSIX and cmd on
// Windows, which disagree about `**`).
//
// Extra arguments are forwarded to node, so `npm test -- --test-only` and
// `npm test -- --test-name-pattern=soul` work as usual.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOT = path.join(root, "src");
const SKIP_DIRS = new Set(["node_modules", "assets"]);

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const files = collect(SEARCH_ROOT).sort();
if (files.length === 0) {
  console.error("run-tests: no *.test.ts found under src/ — that is never right");
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    ...process.argv.slice(2),
    ...files.map((f) => path.relative(root, f)),
  ],
  { cwd: root, stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

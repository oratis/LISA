// postinstall: give node-pty's macOS spawn-helper back its exec bit.
//
// On macOS node-pty posix_spawn()s its own `spawn-helper`, which then execs the
// CLI. node-pty 1.1.0's npm tarball ships prebuilds/darwin-*/spawn-helper as
// 0644, so on an npm install every PTY agent failed with "posix_spawnp failed."
// (#489). The DMG fixes its own copy in packaging/mac-client/embed-runtime.sh.
//
// Best effort by design — this must never fail an install: node-pty is an
// optionalDependency and may be absent, and the files may be read-only. The
// server repeats the same fix right before a PTY spawn
// (ensureSpawnHelperExecutable in src/agents/pty.ts) for installs that skip
// lifecycle scripts (Homebrew's --ignore-scripts, ignore-scripts=true).
//
// package.json runs this through `node -e "import(...).catch(...)"` so an
// install that has package.json but not scripts/ yet (deploy/Dockerfile copies
// the manifest first to cache `npm ci`) does not fail either.
//
// Usage: node scripts/fix-node-pty-perms.mjs [node-pty-dir]
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function findNodePty() {
  try {
    return path.dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch {
    return null;
  }
}

/** Every spawn-helper node-pty could load: a source build, then the macOS prebuilds. */
function helpers(ptyDir) {
  const out = [
    path.join(ptyDir, "build", "Release", "spawn-helper"),
    path.join(ptyDir, "build", "Debug", "spawn-helper"),
  ];
  let prebuilds = [];
  try {
    prebuilds = fs.readdirSync(path.join(ptyDir, "prebuilds"));
  } catch {
    /* no prebuilds (a source build) */
  }
  for (const dir of prebuilds) {
    if (dir.startsWith("darwin-")) out.push(path.join(ptyDir, "prebuilds", dir, "spawn-helper"));
  }
  return out;
}

function main() {
  // chmod is meaningless on Windows, and node-pty uses no spawn-helper there.
  if (process.platform === "win32") return;
  const ptyDir = process.argv[2] || findNodePty();
  if (!ptyDir) return;
  for (const helper of helpers(ptyDir)) {
    try {
      const { mode } = fs.statSync(helper);
      if ((mode & 0o111) === 0o111) continue;
      fs.chmodSync(helper, mode | 0o111);
      console.log(`lisa: made ${path.relative(ptyDir, helper)} in node-pty executable`);
    } catch {
      /* absent or read-only — the server reports it at spawn time */
    }
  }
}

try {
  main();
} catch {
  /* never fail an install */
}

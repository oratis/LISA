import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

for (const buildFails of [false, true]) {
  test(
    buildFails
      ? "Mac packaging stops on a failed build without replacing the bundled backend"
      : "Mac packaging rebuilds an existing dist before staging dependencies",
    { skip: process.platform === "win32" },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-embed-"));
      try {
        const script = path.join(root, "packaging/mac-client/embed-runtime.sh");
        const bundled = path.join(root, "Lisa.app/Contents/Resources/backend/marker");
        const bin = path.join(root, "bin");
        await Promise.all([
          fs.mkdir(path.dirname(script), { recursive: true }),
          fs.mkdir(path.dirname(bundled), { recursive: true }),
          fs.mkdir(path.join(root, "dist")),
          fs.mkdir(bin),
        ]);
        await fs.copyFile(
          new URL("../packaging/mac-client/embed-runtime.sh", import.meta.url),
          script,
        );
        await fs.writeFile(bundled, "installed backend");
        await fs.writeFile(path.join(root, "dist/cli.js"), "stale backend");
        await fs.writeFile(path.join(root, "dist/removed.js"), "deleted source");
        await fs.writeFile(path.join(root, "current-source"), "current backend");
        await fs.writeFile(path.join(root, "package.json"), "{}");
        await fs.writeFile(path.join(root, "package-lock.json"), "{}");
        // Keep the test offline and stop before platform-specific signing.
        await fs.writeFile(
          path.join(bin, "npm"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$EMBED_TEST_ROOT/npm-calls"
if [ "$*" = "run build" ]; then
  if [ "$EMBED_TEST_FAIL" = "1" ]; then exit 17; fi
  mkdir -p "$EMBED_TEST_ROOT/dist"
  cp "$EMBED_TEST_ROOT/current-source" "$EMBED_TEST_ROOT/dist/cli.js"
  exit 0
fi
exit 29
`,
          { mode: 0o755 },
        );
        const result = spawnSync("bash", [script, path.join(root, "Lisa.app")], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            LISA_SKIP_EMBED: "0",
            EMBED_TEST_ROOT: root,
            EMBED_TEST_FAIL: buildFails ? "1" : "0",
          },
        });
        assert.equal(result.status, buildFails ? 17 : 29, result.stdout + result.stderr);
        const calls = (await fs.readFile(path.join(root, "npm-calls"), "utf8")).trim().split("\n");
        assert.equal(calls[0], "run build");
        assert.equal(calls.length, buildFails ? 1 : 2);
        await assert.rejects(fs.access(path.join(root, "dist/removed.js")), { code: "ENOENT" });
        if (!buildFails) {
          assert.equal(
            await fs.readFile(path.join(root, "dist/cli.js"), "utf8"),
            "current backend",
          );
        }
        assert.equal(await fs.readFile(bundled, "utf8"), "installed backend");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}

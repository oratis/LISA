import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { homeScope } from "../paths.js";
import { kbGraphFile } from "../kb/paths.js";
import { readKbMaintenanceHints } from "./runner.js";

test("idle sees bounded broken-link and orphan hints independently of the truncated index", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-kb-maintenance-"));
  try {
    await homeScope.run(dir, async () => {
      assert.equal(await readKbMaintenanceHints(), "");
      await fs.mkdir(path.dirname(kbGraphFile()), { recursive: true });
      await fs.writeFile(
        kbGraphFile(),
        JSON.stringify({
          broken: Array.from({ length: 100 }, (_, i) => ({
            from: `wiki/page-${i}`,
            target: `missing-${i}`,
          })),
          orphans: ["wiki/lonely", "wiki/other"],
        }),
      );
      const hints = await readKbMaintenanceHints();
      assert.match(hints, /missing-0/);
      assert.match(hints, /wiki\/lonely/);
      assert.ok(!hints.includes("missing-5"));
      assert.ok(hints.length < 1800);
      await fs.writeFile(kbGraphFile(), "{corrupt");
      assert.equal(await readKbMaintenanceHints(), "");
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

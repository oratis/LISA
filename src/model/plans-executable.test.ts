import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { onPath, detectPlan, verifyPlanLogin } from "./plans.js";
import { launchAgent } from "../tools/dispatch_agent.js";

test("executable validation, login status and dispatch share the explicit binary", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-plan-executable-"));
  const original = { ...process.env };
  try {
    process.env.LISA_HOME = path.join(tmp, "home");
    process.env.CODEX_HOME = path.join(tmp, "codex-home");
    process.env.PATH = "/usr/bin:/bin";
    const binary = path.join(tmp, "custom codex");
    process.env.LISA_PTY_CODEX_CMD = binary;
    await fs.writeFile(
      binary,
      '#!/bin/sh\nif [ "$1" = login ]; then echo "Logged in using ChatGPT"; else printf "CONNECTED:%s" "$2"; fi\n',
      { mode: 0o600 },
    );
    assert.equal(onPath(binary, process.env), false);
    assert.equal(onPath(tmp, process.env), false);
    await fs.chmod(binary, 0o700);
    assert.equal(detectPlan("codex").binary, binary);
    assert.equal((await verifyPlanLogin(detectPlan("codex"))).loggedIn, true);
    const launched = await launchAgent("codex", "fixture", tmp);
    assert.equal(launched.error, undefined);
    assert.equal(launched.cmd, binary);
    assert.ok(launched.logPath);
    assert.match(await fs.readFile(launched.logPath, "utf8"), /CONNECTED:fixture/);
    await fs.writeFile(binary, '#!/bin/sh\necho "Not logged in" >&2\nexit 1\n');
    assert.equal((await verifyPlanLogin(detectPlan("codex"))).loggedIn, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

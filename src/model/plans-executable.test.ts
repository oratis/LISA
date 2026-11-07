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

test("dispatch never runs a binary planted in the task's project via PATH or a relative override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-plan-planted-"));
  const original = { ...process.env };
  try {
    process.env.LISA_HOME = path.join(tmp, "home");
    const project = path.join(tmp, "project");
    const bin = path.join(tmp, "bin");
    await fs.mkdir(path.join(project, "bin"), { recursive: true });
    await fs.mkdir(bin);
    const marker = path.join(tmp, "planted-ran");
    const plant = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`;
    await fs.writeFile(path.join(project, "copilot"), plant, { mode: 0o700 });
    await fs.writeFile(path.join(project, "bin/copilot"), plant, { mode: 0o700 });
    // execvp reads "" (and ".") as the spawn's cwd: the project.
    process.env.PATH = `:${bin}:.`;
    assert.equal(detectPlan("copilot").binary, null);
    const refused = await launchAgent("copilot", "fixture", project);
    assert.match(refused.error ?? "", /No executable found/);

    // A real install elsewhere on PATH is reported (and run) by absolute path.
    const real = path.join(bin, "copilot");
    await fs.writeFile(real, "#!/bin/sh\necho REAL\n", { mode: 0o700 });
    assert.equal(detectPlan("copilot").binary, real);
    const launched = await launchAgent("copilot", "fixture", project);
    assert.equal(launched.cmd, real);

    process.env.LISA_PTY_CODEX_CMD = "bin/copilot";
    assert.equal(detectPlan("codex").binary, null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await fs.stat(marker).then(
        () => true,
        () => false,
      ),
      false,
      "the planted binary never ran",
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

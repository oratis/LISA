import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnv, isClientSecretEnv } from "./child-env.js";
import { localShell } from "./capabilities/local.js";
import { runIn } from "./tools/exec-util.js";
import { runHook } from "./hooks/runner.js";
import { PtyAgent, type PtyModuleLike } from "./agents/pty.js";

const SECRETS = {
  LISA_GOOGLE_CLIENT_SECRET: "google-client-secret-value",
  LISA_NOTION_CLIENT_SECRET: "notion-client-secret-value",
};

/** Sets the secrets in this process for one test, as `~/.lisa/config.env` would. */
function withSecrets(t: import("node:test").TestContext) {
  const saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, SECRETS);
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}
const leaks = (text: string) => Object.values(SECRETS).filter((v) => text.includes(v));

test("childEnv drops connector client secrets and keeps everything else", () => {
  const base = {
    PATH: "/usr/bin",
    LISA_GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    LISA_NOTION_CLIENT_ID: "notion-id",
    LISA_NOTION_REDIRECT_URI: "http://localhost:4860/oauth/notion",
    LISA_FUTURE_CLIENT_SECRET: "x",
    lisa_notion_client_secret: "x",
    ...SECRETS,
  };
  const env = childEnv(base);
  assert.deepEqual(Object.keys(env).sort(), [
    "LISA_GOOGLE_CLIENT_ID",
    "LISA_NOTION_CLIENT_ID",
    "LISA_NOTION_REDIRECT_URI",
    "PATH",
  ]);
  // LISA itself still reads them: the source is never modified.
  assert.equal(base.LISA_NOTION_CLIENT_SECRET, SECRETS.LISA_NOTION_CLIENT_SECRET);
  assert.equal(isClientSecretEnv("LISA_CLIENT_SECRET_FILE"), false);
  assert.equal(isClientSecretEnv("GITHUB_CLIENT_SECRET"), false);
});

test("the shell tool, repo tools and plugin hooks never see client secrets", async (t) => {
  withSecrets(t);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-child-env-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const shell = await localShell.run("env", { cwd, signal: AbortSignal.timeout(10_000) });
  assert.equal(shell.code, 0);
  assert.match(shell.stdout, /^PATH=/m);
  assert.deepEqual(leaks(shell.stdout), []);
  const exec = await localShell.exec("/usr/bin/env", [], {
    cwd,
    signal: AbortSignal.timeout(10_000),
  });
  assert.deepEqual(leaks(exec.stdout), []);
  const repoTool = await runIn(cwd, "/usr/bin/env", [], { timeoutMs: 10_000 });
  assert.equal(repoTool.code, 0);
  assert.deepEqual(leaks(repoTool.stdout), []);
  const hook = await runHook({ event: "PreToolUse", command: "env" }, { TOOL_NAME: "bash" }, cwd);
  assert.match(hook.stdout, /^TOOL_NAME=bash$/m);
  assert.deepEqual(leaks(hook.stdout), []);
});

test("PTY coding agents start without client secrets", async (t) => {
  withSecrets(t);
  const saved = process.env.LISA_PTY_AGENTS;
  process.env.LISA_PTY_AGENTS = "1";
  t.after(() => {
    if (saved === undefined) delete process.env.LISA_PTY_AGENTS;
    else process.env.LISA_PTY_AGENTS = saved;
  });
  let env: Record<string, string | undefined> | undefined;
  const ptyModule: PtyModuleLike = {
    spawn: (_file, _args, opts) => {
      env = opts.env;
      return { onData() {}, onExit() {}, write() {}, kill() {} };
    },
  };
  const agent = await PtyAgent.start({
    agent: "claude",
    task: "x",
    cwd: os.tmpdir(),
    cli: "/usr/bin/true",
    ptyModule,
  });
  agent.cancel();
  assert.ok(env?.PATH);
  assert.equal(env?.LISA_NOTION_CLIENT_SECRET, undefined);
  assert.equal(env?.LISA_GOOGLE_CLIENT_SECRET, undefined);
});

test("dispatch, MCP stdio servers and redeploy builds spawn with childEnv", async () => {
  // These start real external programs, so pin the wiring at the source.
  for (const file of [
    "tools/dispatch_agent.ts",
    "mcp/client.ts",
    "tools/redeploy.ts",
    "capabilities/local.ts",
    "tools/exec-util.ts",
    "hooks/runner.ts",
    "agents/pty.ts",
  ]) {
    const src = await fs.readFile(path.join(import.meta.dirname, file), "utf8");
    assert.match(src, /childEnv\(\)/, file);
    assert.doesNotMatch(src, /env:\s*process\.env\b|\.\.\.process\.env\b/, file);
  }
});

/**
 * Boots a throwaway Lisa for one spec file.
 *
 * Every instance gets its own LISA_HOME *and* HOME under <repo>/.tmp/e2e, so a
 * run can never read or write the developer's real ~/.lisa — and so the
 * claude-code watcher finds an empty ~/.claude instead of the operator's
 * 1,766-file transcript tree.
 *
 * Nothing here calls a model: the API key is a placeholder and
 * ANTHROPIC_BASE_URL points at tests/e2e/helpers/stub-anthropic.ts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startStubAnthropic, type StubMode, type StubServer } from "./stub-anthropic.js";

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const TMP_ROOT = path.join(REPO_ROOT, ".tmp", "e2e");

/** Placeholder that satisfies the key gate and reaches only the stub. */
export const TEST_API_KEY = "sk-ant-test";

export interface StartOptions {
  /** Directory name under .tmp/e2e — also the label in failure output. */
  label: string;
  /** Write a born soul before starting. Default true. */
  soul?: boolean;
  /** Set ANTHROPIC_API_KEY. false leaves the key gate showing. Default true. */
  apiKey?: boolean;
  /** Stub behaviour, or none at all. Default "ok". */
  stub?: StubMode | "none";
}

export interface LisaInstance {
  baseURL: string;
  home: string;
  stub: StubServer | null;
  stop(): Promise<void>;
}

/** Ask the OS for a port, then hand it over. Racy in theory; the window is
 *  microseconds and the alternative is parsing the server's log lines. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(
  baseURL: string,
  child: ChildProcess,
  log: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`lisa exited early (code ${child.exitCode})\n${log()}`);
    }
    try {
      const res = await fetch(`${baseURL}/api/config/status`);
      if (res.ok) {
        await res.json();
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`lisa did not answer /api/config/status within 60s (${lastError})\n${log()}`);
}

export async function startLisa(opts: StartOptions): Promise<LisaInstance> {
  const { label, soul = true, apiKey = true, stub = "ok" } = opts;

  const home = path.join(
    TMP_ROOT,
    `${label}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const fakeUserHome = path.join(home, "user-home");
  await fs.mkdir(fakeUserHome, { recursive: true });

  // Git identity: the soul store commits on every write, and a temp HOME has
  // no ~/.gitconfig, so without these `git commit` fails and the soul is
  // written but never versioned (silent, and different from a real install).
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fakeUserHome,
    USERPROFILE: fakeUserHome,
    LISA_HOME: home,
    GIT_AUTHOR_NAME: "Lisa E2E",
    GIT_AUTHOR_EMAIL: "e2e@localhost",
    GIT_COMMITTER_NAME: "Lisa E2E",
    GIT_COMMITTER_EMAIL: "e2e@localhost",
    GIT_CONFIG_GLOBAL: path.join(fakeUserHome, ".gitconfig-e2e"),
    GIT_CONFIG_SYSTEM: os.devNull,
    // Deterministic UI: no daylight-dependent theming, no locale surprises.
    TZ: "UTC",
    LANG: "en_US.UTF-8",
  };
  delete baseEnv.ANTHROPIC_API_KEY;
  delete baseEnv.ANTHROPIC_AUTH_TOKEN;
  delete baseEnv.ANTHROPIC_BASE_URL;
  delete baseEnv.OPENAI_API_KEY;
  delete baseEnv.LISA_BASE_URL;
  delete baseEnv.LISA_PROVIDER;
  delete baseEnv.LISA_WEB_TOKEN;

  if (soul) {
    await run(
      process.execPath,
      ["--import", "tsx", path.join("tests", "e2e", "helpers", "make-soul.ts")],
      baseEnv,
    );
  }

  const stubServer = stub === "none" ? null : await startStubAnthropic(stub);

  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (apiKey) env.ANTHROPIC_API_KEY = TEST_API_KEY;
  if (stubServer) env.ANTHROPIC_BASE_URL = stubServer.baseURL;

  const child = spawn(
    process.execPath,
    [
      path.join("dist", "cli.js"),
      "serve",
      "--web",
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-idle",
      "--no-reflect",
      "--no-mcp",
      "--no-plugins",
    ],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let output = "";
  const record = (b: Buffer) => {
    output += b.toString("utf8");
    if (output.length > 40_000) output = output.slice(-20_000);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);

  const baseURL = `http://127.0.0.1:${port}`;
  try {
    await waitForReady(baseURL, child, () => output);
  } catch (err) {
    child.kill("SIGKILL");
    await stubServer?.close();
    throw err;
  }

  let stopped = false;
  return {
    baseURL,
    home,
    stub: stubServer,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stubServer?.close();
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        // The server holds SSE connections open; do not wait forever for a
        // graceful close in a test harness.
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        timer.unref();
        await exited;
        clearTimeout(timer);
      }
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out}`)),
    );
  });
}

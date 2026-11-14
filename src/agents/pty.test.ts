import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  stripAnsi,
  derivePtyState,
  ptyEnabled,
  resolveCli,
  normalizeAgentKind,
  PtyAgent,
  PtyRegistry,
  PtyStartError,
  ensureSpawnHelperExecutable,
  type IPtyLike,
  type PtyModuleLike,
} from "./pty.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** A fake node-pty: capture writes/kills, drive data/exit by hand. */
function fakePty() {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number }) => void) | null = null;
  const written: string[] = [];
  let killed = false;
  const proc: IPtyLike = {
    onData(cb) {
      dataCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    write(d) {
      written.push(d);
    },
    kill() {
      killed = true;
    },
  };
  let spawnFile = "";
  let spawnArgs: string[] = [];
  let spawnCount = 0;
  const module: PtyModuleLike = {
    spawn: (file, args) => {
      spawnCount++;
      spawnFile = file;
      spawnArgs = args;
      return proc;
    },
  };
  return {
    module,
    written,
    emitData: (s: string) => dataCb?.(s),
    emitExit: (code: number) => exitCb?.({ exitCode: code }),
    isKilled: () => killed,
    getSpawn: () => ({ file: spawnFile, args: spawnArgs }),
    get spawnCount() {
      return spawnCount;
    },
  };
}

async function withFlag<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.LISA_PTY_AGENTS;
  process.env.LISA_PTY_AGENTS = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LISA_PTY_AGENTS;
    else process.env.LISA_PTY_AGENTS = prev;
  }
}

// ── pure helpers ──

test("stripAnsi removes color, OSC-8 hyperlinks, and bare control bytes", () => {
  const s =
    ESC +
    "[31mred" +
    ESC +
    "[0m " +
    ESC +
    "]8;;http://example.com/x" +
    BEL +
    "link" +
    ESC +
    "]8;;" +
    BEL +
    " done" +
    ESC +
    "[2K";
  assert.equal(stripAnsi(s), "red link done");
  assert.equal(stripAnsi("a\rb\bc"), "abc");
  assert.equal(stripAnsi("plain"), "plain");
});

test("derivePtyState: streaming → working, quiet → waiting", () => {
  assert.equal(derivePtyState(1000, 2000, 4000), "working");
  assert.equal(derivePtyState(1000, 4999, 4000), "working");
  assert.equal(derivePtyState(1000, 5001, 4000), "waiting");
});

test("ptyEnabled reflects LISA_PTY_AGENTS", async () => {
  const prev = process.env.LISA_PTY_AGENTS;
  delete process.env.LISA_PTY_AGENTS;
  assert.equal(ptyEnabled(), false);
  await withFlag(() => assert.equal(ptyEnabled(), true));
  if (prev !== undefined) process.env.LISA_PTY_AGENTS = prev;
});

test("resolveCli + normalizeAgentKind map agent kinds", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-pty-cli-"));
  const saved = {
    PATH: process.env.PATH,
    LISA_PTY_CLAUDE_CMD: process.env.LISA_PTY_CLAUDE_CMD,
    LISA_PTY_CODEX_CMD: process.env.LISA_PTY_CODEX_CMD,
  };
  try {
    const bin = path.join(tmp, "bin");
    await fs.mkdir(bin);
    for (const name of ["claude", "codex"])
      await fs.writeFile(path.join(bin, name), "#!/bin/sh\n", { mode: 0o700 });
    process.env.LISA_PTY_CLAUDE_CMD = path.join(bin, "claude");
    delete process.env.LISA_PTY_CODEX_CMD;
    process.env.PATH = bin;
    assert.equal(resolveCli("claude"), path.join(bin, "claude"));
    assert.equal(resolveCli("claude-code"), path.join(bin, "claude"));
    // A bare PATH hit resolves to the absolute file that was checked.
    assert.equal(resolveCli("codex"), path.join(bin, "codex"));

    // Planted in the task's project: an empty/relative PATH entry or a
    // relative override must never resolve to it.
    const project = path.join(tmp, "project");
    await fs.mkdir(path.join(project, "bin"), { recursive: true });
    await fs.writeFile(path.join(project, "codex"), "#!/bin/sh\n", { mode: 0o700 });
    await fs.writeFile(path.join(project, "bin/codex"), "#!/bin/sh\n", { mode: 0o700 });
    const cwd = process.cwd();
    process.chdir(project);
    try {
      process.env.PATH = ":.:bin";
      // (An installed ChatGPT/Codex app may still be found; never the plant.)
      const viaPath = resolveCli("codex");
      assert.ok(
        viaPath === null || (path.isAbsolute(viaPath) && !viaPath.startsWith(project)),
        String(viaPath),
      );
      process.env.LISA_PTY_CODEX_CMD = "bin/codex";
      assert.equal(resolveCli("codex"), null);
    } finally {
      process.chdir(cwd);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
  assert.equal(normalizeAgentKind("claude"), "claude-code");
  assert.equal(normalizeAgentKind("claude-code"), "claude-code");
  assert.equal(normalizeAgentKind("codex"), "codex");
});

// ── lifecycle (fake pty) ──

test("start is blocked unless the spike flag is on", async () => {
  const prev = process.env.LISA_PTY_AGENTS;
  delete process.env.LISA_PTY_AGENTS;
  await assert.rejects(
    () => PtyAgent.start({ agent: "claude", task: "x", cwd: "/tmp", ptyModule: fakePty().module }),
    /disabled/,
  );
  if (prev !== undefined) process.env.LISA_PTY_AGENTS = prev;
});

test("start types the task; send appends; data drives state; cancel kills", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const clock = { t: 1000 };
    const reg = new PtyRegistry();
    const v = await reg.start({
      agent: "claude",
      task: "do the thing",
      cwd: "/Users/me/myproj",
      cli: "claude", // pin so the assertion doesn't depend on a host claude install
      ptyModule: f.module,
      now: () => clock.t,
    });
    // identity + initial task typed in
    assert.equal(v.agent, "claude-code");
    assert.equal(v.cli, "claude");
    assert.equal(v.project, "myproj");
    assert.equal(f.written[0], "do the thing\r");

    // follow-up
    assert.equal(reg.send(v.id, "also lint"), true);
    assert.equal(f.written[1], "also lint\r");

    // output capture (ANSI-stripped) + working while recent
    clock.t = 2000;
    f.emitData(ESC + "[32mhello" + ESC + "[0m");
    assert.match(reg.output(v.id) ?? "", /hello/);
    clock.t = 2500;
    assert.equal(reg.list()[0].state, "working");
    clock.t = 7000;
    assert.equal(reg.list()[0].state, "waiting");

    // cancel → killed + done; idempotent; no writes after
    assert.equal(reg.cancel(v.id), true);
    assert.equal(f.isKilled(), true);
    const after = reg.list()[0];
    assert.equal(after.state, "done");
    assert.equal(after.stateReason, "cancelled");
    const writes = f.written.length;
    reg.send(v.id, "ignored");
    assert.equal(f.written.length, writes);
    reg.cancel(v.id); // idempotent, no throw
    assert.equal(reg.list()[0].state, "done");
  });
});

test("resumeSessionId adopts an existing session via `--resume <id>`", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    await reg.start({
      agent: "claude",
      task: "", // adopt: continue the conversation, no initial message
      cwd: "/tmp/p",
      resumeSessionId: "abc-123",
      cli: "claude",
      ptyModule: f.module,
    });
    assert.deepEqual(f.getSpawn().args.slice(0, 2), ["--resume", "abc-123"]);
    assert.equal(f.written.length, 0); // empty task ⇒ nothing typed
  });
});

test("resume-adopt is claude-only — codex resume is refused, not silently downgraded", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    // Codex has no liveness signal, so adopting one can't be guarded against
    // transcript corruption. Refusing (vs. silently starting a fresh session)
    // keeps the API honest. See docs/PTY_AGENTS.md.
    await assert.rejects(
      () =>
        reg.start({
          agent: "codex",
          task: "",
          cwd: "/tmp/p",
          resumeSessionId: "abc-123",
          cli: "codex",
          ptyModule: f.module,
        }),
      /only supported for claude/i,
    );
    assert.equal(f.spawnCount, 0); // never spawned anything
  });
});

test("process exit marks the agent done", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    await reg.start({
      agent: "codex",
      task: "go",
      cwd: "/tmp/p",
      cli: "codex",
      ptyModule: f.module,
    });
    f.emitExit(0);
    const view = reg.list()[0];
    assert.equal(view.agent, "codex");
    assert.equal(view.state, "done");
    assert.equal(view.stateReason, "exit 0");
  });
});

test("registry emits 'output' chunks (ANSI-stripped) for the live attach stream", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    const chunks: Array<{ id: string; chunk: string }> = [];
    reg.on("output", (e) => chunks.push(e as { id: string; chunk: string }));
    const v = await reg.start({
      agent: "claude",
      task: "go",
      cwd: "/tmp/p",
      cli: "claude",
      ptyModule: f.module,
    });
    // The initial task is a write (stdin), not output — no chunk yet.
    assert.equal(chunks.length, 0);
    f.emitData(ESC + "[32mhello" + ESC + "[0m world");
    assert.deepEqual(chunks, [{ id: v.id, chunk: "hello world" }]);
  });
});

test("registry actions on an unknown id are no-ops", () => {
  const reg = new PtyRegistry();
  assert.equal(reg.send("nope", "x"), false);
  assert.equal(reg.cancel("nope"), false);
  assert.equal(reg.output("nope"), null);
  assert.deepEqual(reg.list(), []);
});

// ── start errors carry a stable code (#489) ──

test("start errors: pty_disabled / cli_missing / spawn_failed", async () => {
  const prev = process.env.LISA_PTY_AGENTS;
  delete process.env.LISA_PTY_AGENTS;
  try {
    await assert.rejects(
      () =>
        PtyAgent.start({ agent: "claude", task: "x", cwd: "/tmp", ptyModule: fakePty().module }),
      (e: unknown) => e instanceof PtyStartError && e.code === "pty_disabled",
    );
  } finally {
    if (prev !== undefined) process.env.LISA_PTY_AGENTS = prev;
  }

  await withFlag(async () => {
    const saved = process.env.LISA_PTY_CODEX_CMD;
    // A relative override never resolves (see resolveCli), so no codex is found
    // even on a machine that has one installed.
    process.env.LISA_PTY_CODEX_CMD = "not/a/real/codex";
    try {
      const f = fakePty();
      await assert.rejects(
        () => PtyAgent.start({ agent: "codex", task: "x", cwd: "/tmp", ptyModule: f.module }),
        (e: unknown) => e instanceof PtyStartError && e.code === "cli_missing",
      );
      assert.equal(f.spawnCount, 0);
    } finally {
      if (saved === undefined) delete process.env.LISA_PTY_CODEX_CMD;
      else process.env.LISA_PTY_CODEX_CMD = saved;
    }

    const throwing: PtyModuleLike = {
      spawn: () => {
        throw new Error("posix_spawnp failed.");
      },
    };
    await assert.rejects(
      () =>
        PtyAgent.start({
          agent: "claude",
          task: "x",
          cwd: "/tmp",
          cli: "claude",
          ptyModule: throwing,
        }),
      (e: unknown) =>
        e instanceof PtyStartError &&
        e.code === "spawn_failed" &&
        /posix_spawnp failed/.test(e.message),
    );
  });
});

// ── node-pty's macOS spawn-helper ships without its exec bit (#489) ──

/** A node-pty-shaped dir with one prebuild whose spawn-helper is 0644, like the npm tarball. */
async function fakeNodePty(arch = "arm64") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-node-pty-"));
  const pre = path.join(dir, "prebuilds", `darwin-${arch}`);
  await fs.mkdir(pre, { recursive: true });
  await fs.writeFile(path.join(pre, "pty.node"), "");
  await fs.writeFile(path.join(pre, "spawn-helper"), "#!/bin/sh\n", { mode: 0o644 });
  await fs.chmod(path.join(pre, "spawn-helper"), 0o644); // umask-proof
  return { dir, helper: path.join(pre, "spawn-helper") };
}

test("ensureSpawnHelperExecutable adds the missing exec bit to the helper node-pty uses", async () => {
  const { dir, helper } = await fakeNodePty();
  try {
    const first = ensureSpawnHelperExecutable(dir, "darwin", "arm64");
    assert.deepEqual(first, {
      helper: "prebuilds/darwin-arm64/spawn-helper",
      executable: true,
      fixed: true,
    });
    assert.equal((await fs.stat(helper)).mode & 0o777, 0o755);
    // Idempotent once fixed.
    assert.equal(ensureSpawnHelperExecutable(dir, "darwin", "arm64").fixed, false);
    // A source build (build/Release/pty.node) wins over prebuilds, as in node-pty.
    await fs.mkdir(path.join(dir, "build", "Release"), { recursive: true });
    await fs.writeFile(path.join(dir, "build", "Release", "pty.node"), "");
    await fs.writeFile(path.join(dir, "build", "Release", "spawn-helper"), "", { mode: 0o755 });
    assert.equal(
      ensureSpawnHelperExecutable(dir, "darwin", "arm64").helper,
      "build/Release/spawn-helper",
    );
    // Nothing to check off macOS, or without node-pty.
    assert.equal(ensureSpawnHelperExecutable(dir, "linux", "x64").helper, null);
    assert.equal(ensureSpawnHelperExecutable(null, "darwin", "arm64").executable, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("postinstall script fixes the helpers and never fails the install", async () => {
  const { execFileSync } = await import("node:child_process");
  const script = path.resolve("scripts/fix-node-pty-perms.mjs");
  const { dir, helper } = await fakeNodePty("x64");
  try {
    execFileSync(process.execPath, [script, dir], { stdio: "pipe" });
    if (process.platform !== "win32") assert.equal((await fs.stat(helper)).mode & 0o111, 0o111);
    // No node-pty there at all: still exit 0.
    execFileSync(process.execPath, [script, path.join(dir, "missing")], { stdio: "pipe" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── real node-pty round-trip ──

test("real PTY round-trip via `cat` echoes input", async (t) => {
  // `cat` under a PTY echoes typed input back on stdout — proves the real
  // spawn → write → read → kill path without depending on a heavy CLI.
  //
  // This used to skip on ANY error, so "posix_spawnp failed." (node-pty's macOS
  // spawn-helper installed without its exec bit, #489) kept CI green while
  // every npm/Homebrew install was broken. Now only a missing optional dep
  // skips, and not on macOS, where node-pty always ships prebuilds.
  try {
    await import("node-pty");
  } catch (e) {
    if (process.platform === "darwin") throw e;
    t.skip("node-pty is not installed here: " + (e as Error).message);
    return;
  }
  const reg = new PtyRegistry();
  const v = await withFlag(() =>
    reg.start({ agent: "claude", task: "", cwd: process.cwd(), cli: "cat", args: [] }),
  );
  // start() self-heals the helper; it must be executable afterwards.
  const helper = ensureSpawnHelperExecutable();
  assert.equal(helper.executable, true, `node-pty's ${helper.helper} is not executable`);
  reg.send(v.id, "ping-marker-42");
  for (let i = 0; i < 50 && !/ping-marker-42/.test(reg.output(v.id) ?? ""); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(reg.output(v.id) ?? "", /ping-marker-42/);
  reg.cancel(v.id);
  assert.equal(reg.list()[0].state, "done");
});

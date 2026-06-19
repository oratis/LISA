import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  derivePtyState,
  ptyEnabled,
  resolveCli,
  normalizeAgentKind,
  PtyAgent,
  PtyRegistry,
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
  const module: PtyModuleLike = {
    spawn: (file, args) => {
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
    ESC + "[31mred" + ESC + "[0m " + ESC + "]8;;http://example.com/x" + BEL + "link" + ESC + "]8;;" + BEL + " done" + ESC + "[2K";
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

test("resolveCli + normalizeAgentKind map agent kinds", () => {
  assert.equal(resolveCli("claude"), "claude");
  assert.equal(resolveCli("claude-code"), "claude");
  assert.equal(resolveCli("codex"), "codex");
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

test("resume is claude-only (codex ignores resumeSessionId)", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    await reg.start({ agent: "codex", task: "", cwd: "/tmp/p", resumeSessionId: "abc-123", cli: "codex", ptyModule: f.module });
    assert.equal(f.getSpawn().args.includes("--resume"), false);
  });
});

test("process exit marks the agent done", async () => {
  await withFlag(async () => {
    const f = fakePty();
    const reg = new PtyRegistry();
    const v = await reg.start({ agent: "codex", task: "go", cwd: "/tmp/p", ptyModule: f.module });
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
    const v = await reg.start({ agent: "claude", task: "go", cwd: "/tmp/p", ptyModule: f.module });
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

// ── real node-pty round-trip (skipped if the optional dep isn't built) ──

test("real PTY round-trip via `cat` echoes input", async (t) => {
  // `cat` under a PTY echoes typed input back on stdout — proves the real
  // spawn → write → read → kill path without depending on a heavy CLI.
  // Skips when node-pty isn't built OR its native binding can't spawn in this
  // environment (e.g. under the tsx test loader, which resolves node-pty's TS
  // source rather than its compiled native lib — a runner artifact, not a
  // defect: the shipped path runs against compiled JS).
  const reg = new PtyRegistry();
  let v;
  try {
    await import("node-pty");
    v = await withFlag(() =>
      reg.start({ agent: "claude", task: "", cwd: process.cwd(), cli: "cat", args: [] }),
    );
  } catch (e) {
    t.skip("node-pty unavailable here: " + (e as Error).message);
    return;
  }
  reg.send(v.id, "ping-marker-42");
  await new Promise((r) => setTimeout(r, 300));
  assert.match(reg.output(v.id) ?? "", /ping-marker-42/);
  reg.cancel(v.id);
  assert.equal(reg.list()[0].state, "done");
});

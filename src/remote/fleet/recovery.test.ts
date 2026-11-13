import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FleetHostService, type FleetHostOptions } from "./host-service.js";
import type { ClaudeRunner } from "./claude.js";
import { HOST_API } from "./types.js";

// A backend that dies (crash, kill, launchd restart) can leave its detached
// Claude process group running. The next backend must not hold the executor
// for it forever: it frees the slot when the group is gone, and stops the
// group first when it is not.

interface Page {
  run: { state: string };
  events: { type: string; process?: string; outcome?: string }[];
}

/** A detached process group standing in for a Claude agent. */
function agent(script = "exec /bin/sleep 30"): ChildProcess {
  return spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
}
function alive(child: ChildProcess) {
  return child.exitCode === null && child.signalCode === null;
}
function reap(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** One host whose runner reports the given process as the agent it launched. */
function fixture(child?: ChildProcess) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-recovery-"));
  const home = path.join(dir, "lisa"),
    root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "project-")));
  let starts = 0;
  const runner: ClaudeRunner = {
    reason: () => null,
    start(_, e) {
      starts++;
      return {
        pid: starts === 1 ? child?.pid : undefined,
        send() {},
        decide() {},
        cancel() {
          e.exit("");
        },
      };
    },
  };
  const services: FleetHostService[] = [];
  const open = (options?: FleetHostOptions) => {
    const svc = new FleetHostService(home, runner, options);
    services.push(svc);
    return svc;
  };
  const first = open();
  const ws = first.register("Project", root);
  const peer = {
    hostId: "e".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [ws.id],
    control: true,
  };
  const start = (svc: FleetHostService) => {
    const body = {
      operationId: crypto.randomUUID(),
      hostId: peer.hostId,
      workspaceId: ws.id,
      text: "Work",
    };
    svc.mutate(peer, HOST_API + "/runs", body);
    return body.operationId;
  };
  return {
    home,
    first,
    open,
    start,
    page: (svc: FleetHostService, id: string) =>
      svc.read(peer, HOST_API + "/runs/" + id + "/events") as Page,
    ledger: (sql: string, ...args: (string | number)[]) => {
      const db = new DatabaseSync(path.join(home, "fleet", "runs.sqlite"));
      try {
        db.prepare(sql).run(...args);
      } finally {
        db.close();
      }
    },
    close() {
      for (const s of services) void s.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a restarted backend frees the slot of an agent that already exited", async () => {
  const child = agent();
  const f = fixture(child);
  try {
    const id = f.start(f.first);
    // The injected check says the group is gone, so nothing may be signalled.
    const restarted = f.open({ exists: () => false });
    const page = f.page(restarted, id);
    assert.deepEqual(
      page.events.map((e) => [e.type, e.process]),
      [
        ["turn_started", undefined],
        ["outcome_unknown", undefined],
        ["orphan_released", "exited"],
      ],
    );
    assert.equal(page.run.state, "unknown");
    await restarted.recovered;
    assert.ok(alive(child), "an agent believed gone must not be signalled");
    // The executor takes new work, and the old run is never relaunched.
    f.start(restarted);
    assert.equal(restarted.ownerRuns().length, 1);
  } finally {
    reap(child);
    f.close();
  }
});

test("a restarted backend stops an agent that is still running, then frees its slot", async () => {
  const child = agent();
  const f = fixture(child);
  try {
    const id = f.start(f.first);
    const exited = once(child, "exit");
    const restarted = f.open();
    // The slot stays taken until the agent is gone.
    assert.throws(() => f.start(restarted), /host_busy/);
    await restarted.recovered;
    const [, signal] = await exited;
    assert.equal(signal, "SIGTERM");
    const page = f.page(restarted, id);
    assert.deepEqual(
      page.events.slice(-2).map((e) => [e.type, e.process]),
      [
        ["outcome_unknown", undefined],
        ["orphan_released", "stopped"],
      ],
    );
    assert.equal(page.run.state, "unknown");
    f.start(restarted);
  } finally {
    reap(child);
    f.close();
  }
});

test("an agent that ignores SIGTERM is killed once the grace period ends", async () => {
  // An ignored signal stays ignored across exec, so the sleeping agent ignores it too.
  const child = spawn("/bin/sh", ["-c", "trap '' TERM; echo ready; exec /bin/sleep 30"], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  await once(child.stdout, "data");
  const f = fixture(child);
  try {
    const id = f.start(f.first);
    const exited = once(child, "exit");
    const restarted = f.open({ stopGraceMs: 200 });
    await restarted.recovered;
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    assert.equal(f.page(restarted, id).events.at(-1)!.process, "stopped");
  } finally {
    reap(child);
    f.close();
  }
});

test("a group id that predates a reboot, or a run another live backend owns, is left alone", async () => {
  const child = agent(),
    sibling = agent();
  const f = fixture(child);
  try {
    const rebooted = f.start(f.first);
    // Launched before this boot: whatever holds the id now is not the agent.
    f.ledger("UPDATE runs SET started=0 WHERE id=?", rebooted);
    const restarted = f.open();
    const last = f.page(restarted, rebooted).events.at(-1)!;
    assert.deepEqual([last.type, last.process], ["orphan_released", "exited"]);
    await restarted.recovered;
    assert.ok(alive(child), "a reused id must not be signalled");

    // Another backend process that is still running owns this run.
    const owned = f.start(restarted);
    f.ledger(
      "UPDATE runs SET pgid=?,started=?,backend=? WHERE id=?",
      child.pid!,
      Date.now(),
      sibling.pid!,
      owned,
    );
    const third = f.open();
    await third.recovered;
    assert.ok(alive(child), "another live backend's agent must not be stopped");
    assert.equal(f.page(third, owned).run.state, "unknown");
    assert.throws(() => f.start(third), /host_busy/);
  } finally {
    reap(child);
    reap(sibling);
    f.close();
  }
});

test("a ledger from before process tracking opens, and its runs still wait for the owner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-recovery-old-"));
  const home = path.join(dir, "lisa"),
    root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "project-")));
  try {
    fs.mkdirSync(path.join(home, "fleet"), { recursive: true });
    const old = new DatabaseSync(path.join(home, "fleet", "runs.sqlite"));
    old.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,root TEXT UNIQUE,inode TEXT);
      CREATE TABLE runs(id TEXT PRIMARY KEY,host TEXT,device TEXT,workspace TEXT,epoch TEXT,state TEXT,result TEXT,pending TEXT,created INTEGER);`);
    const st = fs.statSync(root, { bigint: true });
    const ws = crypto.randomUUID(),
      run = crypto.randomUUID();
    old
      .prepare("INSERT INTO workspaces VALUES(?,?,?,?)")
      .run(ws, "Project", root, st.dev + ":" + st.ino);
    old
      .prepare("INSERT INTO runs VALUES(?,?,?,?,?,'running','',NULL,?)")
      .run(run, "e".repeat(32), "b".repeat(32), ws, "earlier", Date.now());
    old.close();
    const runner: ClaudeRunner = {
      reason: () => null,
      start: (_, e) => ({ send() {}, decide() {}, cancel: () => e.exit("") }),
    };
    const svc = new FleetHostService(home, runner, {
      exists: () => assert.fail("a run without a process group must not be probed"),
    });
    try {
      const peer = {
        hostId: "e".repeat(32),
        deviceId: "b".repeat(32),
        workspaces: [ws],
        control: true,
      };
      assert.deepEqual(svc.ownerRuns(), [{ id: run, workspaceId: ws, state: "unknown" }]);
      const body = {
        operationId: crypto.randomUUID(),
        hostId: peer.hostId,
        workspaceId: ws,
        text: "x",
      };
      assert.throws(() => svc.mutate(peer, HOST_API + "/runs", body), /host_busy/);
      svc.ownerStop(run, true);
      svc.mutate(peer, HOST_API + "/runs", body);
    } finally {
      void svc.shutdown();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shutdown settles only after the agents it stopped have exited", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-recovery-stop-"));
  const home = path.join(dir, "lisa"),
    root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "project-")));
  let exited = false;
  const runner: ClaudeRunner = {
    reason: () => null,
    start: (_, e) => ({
      send() {},
      decide() {},
      // A real process takes a moment to go after SIGTERM.
      cancel: () =>
        setTimeout(() => {
          exited = true;
          e.exit("");
        }, 50),
    }),
  };
  const svc = new FleetHostService(home, runner);
  try {
    const ws = svc.register("Project", root);
    const peer = {
      hostId: "e".repeat(32),
      deviceId: "b".repeat(32),
      workspaces: [ws.id],
      control: true,
    };
    svc.mutate(peer, HOST_API + "/runs", {
      operationId: crypto.randomUUID(),
      hostId: peer.hostId,
      workspaceId: ws.id,
      text: "Work",
    });
    await svc.shutdown();
    assert.equal(exited, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

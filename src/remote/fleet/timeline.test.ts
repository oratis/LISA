import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FleetHostService } from "./host-service.js";
import type { ClaudeEvents, ClaudeRunner } from "./claude.js";
import { fleetRoute, FleetError, HOST_API } from "./types.js";

interface Entry {
  seq: number;
  at: number;
  type: string;
  [field: string]: unknown;
}
interface Page {
  run: { state: string; lastSeq: number; updatedAt: number; createdAt: number; approval: unknown };
  events: Entry[];
  firstSeq: number;
  lastSeq: number;
  gap: boolean;
  reset: boolean;
  more: boolean;
}

/** A host with one registered project and a runner the test drives by hand. */
function fixture(start?: ClaudeRunner["start"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-timeline-"));
  const home = path.join(dir, "lisa"),
    root = fs.realpathSync(fs.mkdtempSync(path.join(dir, "project-")));
  const state = { starts: 0, events: undefined as ClaudeEvents | undefined };
  const runner: ClaudeRunner = {
    reason: () => null,
    start:
      start ??
      ((_, e) => {
        state.starts++;
        state.events = e;
        return {
          send() {},
          decide(id, allow) {
            e.approval(null, { id, outcome: allow ? "allowed" : "denied" });
          },
          cancel() {
            e.exit("");
          },
        };
      }),
  };
  const services: FleetHostService[] = [];
  const open = () => {
    const svc = new FleetHostService(home, runner);
    services.push(svc);
    return svc;
  };
  const svc = open();
  const ws = svc.register("Project", root);
  const peer = {
    hostId: "e".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [ws.id],
    control: true,
  };
  const body = (extra: object = {}) => ({
    operationId: crypto.randomUUID(),
    hostId: peer.hostId,
    workspaceId: ws.id,
    ...extra,
  });
  return {
    home,
    root,
    svc,
    open,
    peer,
    body,
    state,
    page: (id: string, query = "", from = svc, as = peer) =>
      from.read(as, HOST_API + "/runs/" + id + "/events" + query) as Page,
    close() {
      for (const s of services) void s.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const request = (root: string, file = "notes.txt") => ({
  id: crypto.randomUUID(),
  tool: "Write",
  input: { file_path: path.join(root, file), content: "private file body" },
  expiresAt: Date.now() + 300_000,
});

test("a task's timeline records each step once, in order, and pages by cursor", () => {
  const f = fixture();
  try {
    const first = f.body({ text: "Write the notes" });
    f.svc.mutate(f.peer, HOST_API + "/runs", first);
    // A retried start returns the receipt. It neither launches nor logs a second start.
    f.svc.mutate(f.peer, HOST_API + "/runs", first);
    const id = first.operationId,
      events = f.state.events!;
    assert.equal(f.state.starts, 1);

    const approval = request(f.root);
    events.approval(approval);
    f.svc.mutate(
      f.peer,
      HOST_API + "/runs/" + id + "/decisions",
      f.body({ approvalId: approval.id, allow: true }),
    );
    events.blocked!("Write", "/etc/passwd");
    events.result("first result", false);

    f.svc.mutate(f.peer, HOST_API + "/runs/" + id + "/messages", f.body({ text: "Go on" }));
    events.result("x".repeat(5000), false);
    f.svc.mutate(f.peer, HOST_API + "/runs/" + id + "/cancel", f.body());

    const all = f.page(id);
    assert.deepEqual(
      all.events.map((e) => e.type),
      [
        "turn_started",
        "approval_requested",
        "approval_resolved",
        "tool_blocked",
        "turn_completed",
        "turn_started",
        "turn_completed",
        "cancel_requested",
        "run_ended",
      ],
    );
    assert.deepEqual(
      all.events.map((e) => e.seq),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    const [started, asked, answered, blocked, done, second, long, cancel, ended] = all.events;
    assert.deepEqual([started!.turn, started!.prompt], [1, "Write the notes"]);
    // The card names the tool and a workspace-relative target. File contents stay out.
    assert.deepEqual(
      [asked!.tool, asked!.target, asked!.approvalId],
      ["Write", "notes.txt", approval.id],
    );
    assert.equal(JSON.stringify(all.events).includes("private file body"), false);
    assert.deepEqual([answered!.approvalId, answered!.outcome], [approval.id, "allowed"]);
    assert.equal(blocked!.target, "/etc/passwd");
    assert.deepEqual([done!.turn, done!.result, done!.blocked], [1, "first result", 1]);
    assert.deepEqual([second!.turn, second!.prompt], [2, "Go on"]);
    assert.deepEqual(
      [long!.turn, String(long!.result).length, long!.truncated, long!.blocked],
      [2, 4000, true, undefined],
    );
    assert.equal(cancel!.by, "controller");
    assert.deepEqual([ended!.state, ended!.reason], ["cancelled", undefined]);
    assert.deepEqual(
      [all.firstSeq, all.lastSeq, all.gap, all.reset, all.more],
      [1, 9, false, false, false],
    );
    assert.deepEqual([all.run.state, all.run.lastSeq], ["cancelled", 9]);
    assert.ok(all.run.updatedAt >= all.run.createdAt);

    // Catching up: read from the last entry the client has, in bounded pages.
    const head = f.page(id, "?after=0&limit=2");
    assert.deepEqual([head.events.map((e) => e.seq), head.more], [[1, 2], true]);
    const tail = f.page(id, "?after=2");
    assert.deepEqual([tail.events[0]!.seq, tail.events.length, tail.more], [3, 7, false]);
    assert.deepEqual([f.page(id, "?after=9").events, f.page(id, "?after=9").more], [[], false]);

    // Every read checks the grant again. Another device or a withdrawn workspace sees nothing.
    assert.throws(
      () => f.page(id, "", f.svc, { ...f.peer, deviceId: "c".repeat(32) }),
      /run_not_found/,
    );
    assert.throws(() => f.page(id, "", f.svc, { ...f.peer, workspaces: [] }), /run_not_found/);
    const listed = f.svc.read(f.peer, HOST_API + "/runs") as { runs: { lastSeq: number }[] };
    assert.equal(listed.runs[0]!.lastSeq, 9);
    const caps = f.svc.read(f.peer, HOST_API + "/capabilities") as { features: string[] };
    assert.ok(caps.features.includes("run-events"));
  } finally {
    f.close();
  }
});

test("a request that nobody answered records how it ended", () => {
  const f = fixture();
  try {
    const start = f.body({ text: "Edit" });
    f.svc.mutate(f.peer, HOST_API + "/runs", start);
    const id = start.operationId,
      events = f.state.events!;
    const expired = request(f.root, "a.txt"),
      withdrawn = request(f.root, "b.txt"),
      open = request(f.root, "c.txt");
    events.approval(expired);
    events.approval(null, { id: expired.id, outcome: "expired" });
    events.approval(withdrawn);
    events.approval(null, { id: withdrawn.id, outcome: "withdrawn" });
    events.approval(open);
    f.svc.mutate(f.peer, HOST_API + "/runs/" + id + "/cancel", f.body());
    const resolved = f
      .page(id)
      .events.filter((e) => e.type === "approval_resolved")
      .map((e) => [e.approvalId, e.outcome]);
    assert.deepEqual(resolved, [
      [expired.id, "expired"],
      [withdrawn.id, "withdrawn"],
      [open.id, "cancelled"],
    ]);
    // A decision that arrives after the run stopped changes nothing and logs nothing.
    assert.throws(
      () =>
        f.svc.mutate(
          f.peer,
          HOST_API + "/runs/" + id + "/decisions",
          f.body({ approvalId: open.id, allow: true }),
        ),
      /run_not_active/,
    );
    assert.equal(f.page(id).events.at(-1)!.type, "run_ended");
  } finally {
    f.close();
  }
});

test("a restarted backend marks the outcome unknown once and keeps the earlier history", () => {
  const f = fixture();
  try {
    const start = f.body({ text: "Long task" });
    f.svc.mutate(f.peer, HOST_API + "/runs", start);
    const id = start.operationId,
      pending = request(f.root);
    f.state.events!.approval(pending);

    const restarted = f.open();
    const again = f.open();
    for (const svc of [restarted, again]) {
      const page = f.page(id, "", svc);
      assert.deepEqual(
        page.events.map((e) => e.type),
        ["turn_started", "approval_requested", "outcome_unknown"],
      );
      assert.deepEqual([page.run.state, page.run.approval], ["unknown", null]);
    }
    // Reading or retrying after the restart never launches the task again.
    restarted.mutate(f.peer, HOST_API + "/runs", start);
    assert.equal(f.state.starts, 1);

    restarted.ownerStop(id, true);
    const released = f.page(id, "?after=3", restarted);
    assert.deepEqual(
      released.events.map((e) => [e.type, e.outcome]),
      [
        ["approval_resolved", "cancelled"],
        ["owner_released", undefined],
      ],
    );
    assert.equal(released.run.state, "unknown");
  } finally {
    f.close();
  }
});

test("a long task drops its oldest entries and tells the reader about the gap", () => {
  const f = fixture();
  try {
    const start = f.body({ text: "Many edits" });
    f.svc.mutate(f.peer, HOST_API + "/runs", start);
    const id = start.operationId;
    for (let i = 0; i < 300; i++) {
      const a = request(f.root, "file-" + i + ".txt");
      f.state.events!.approval(a);
      f.state.events!.approval(null, { id: a.id, outcome: "denied" });
    }
    // 1 start + 600 approval entries, of which the newest 500 are kept.
    const stale = f.page(id, "?after=40");
    assert.deepEqual(
      [
        stale.firstSeq,
        stale.lastSeq,
        stale.gap,
        stale.events[0]!.seq,
        stale.events.length,
        stale.more,
      ],
      [102, 601, true, 102, 100, true],
    );
    assert.equal(stale.run.state, "running");
    const current = f.page(id, "?after=101");
    assert.deepEqual([current.gap, current.events[0]!.seq], [false, 102]);
    // A cursor ahead of this ledger belongs to another history. The reader starts over.
    const ahead = f.page(id, "?after=9000");
    assert.deepEqual([ahead.reset, ahead.events[0]!.seq], [true, 102]);
  } finally {
    f.close();
  }
});

test("a task recorded before the timeline existed starts from its verifiable state", () => {
  const f = fixture();
  try {
    const start = f.body({ text: "Earlier release" });
    f.svc.mutate(f.peer, HOST_API + "/runs", start);
    f.svc.mutate(f.peer, HOST_API + "/runs/" + start.operationId + "/cancel", f.body());
    const ledger = new DatabaseSync(path.join(f.home, "fleet", "runs.sqlite"));
    ledger.exec("DROP TABLE events");
    ledger.close();
    const page = f.page(start.operationId, "", f.open());
    assert.deepEqual(
      page.events.map((e) => [e.seq, e.type, e.state]),
      [[1, "history_started", "cancelled"]],
    );
    assert.equal(page.run.state, "cancelled");
  } finally {
    f.close();
  }
});

test("a launch that fails closes the task in its timeline", () => {
  const f = fixture(() => {
    throw new FleetError(503, "claude_not_installed");
  });
  try {
    const start = f.body({ text: "Never runs" });
    assert.throws(() => f.svc.mutate(f.peer, HOST_API + "/runs", start), /claude_not_installed/);
    const page = f.page(start.operationId);
    assert.deepEqual(
      page.events.map((e) => [e.type, e.state, e.reason]),
      [
        ["turn_started", undefined, undefined],
        ["run_ended", "failed", "claude_launch_failed"],
      ],
    );
    assert.equal(page.run.state, "failed");
  } finally {
    f.close();
  }
});

test("the remote allow-list accepts one spelling of the timeline cursor", () => {
  const route = HOST_API + "/runs/" + crypto.randomUUID() + "/events";
  for (const ok of ["", "?after=0", "?after=12&limit=50"])
    assert.equal(fleetRoute("GET", route + ok), true, ok);
  for (const bad of [
    "?limit=5",
    "?after=-1",
    "?after=1&limit=5&x=1",
    "?after=1&limit=1000",
    "?after=1%0a",
    "?after=",
    "/more",
  ])
    assert.equal(fleetRoute("GET", route + bad), false, bad);
  assert.equal(fleetRoute("POST", route), false);
  assert.equal(
    fleetRoute("GET", HOST_API + "/operations/" + crypto.randomUUID() + "/events"),
    false,
  );
});

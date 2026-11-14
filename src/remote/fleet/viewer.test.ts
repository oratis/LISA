import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { FleetHostService } from "./host-service.js";
import type { ClaudeEvents, ClaudeRunner } from "./claude.js";
import { fleetRoute, fleetViewRoute, HOST_API, VIEW_API } from "./types.js";

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-viewer-")));
  const home = path.join(dir, "lisa"),
    root = path.join(dir, "project");
  fs.mkdirSync(root);
  let events!: ClaudeEvents;
  const runner: ClaudeRunner = {
    reason: () => null,
    start(_, e) {
      events = e;
      return {
        send() {},
        decide(id, allow) {
          e.approval(null, { id, outcome: allow ? "allowed" : "denied" });
        },
        cancel() {
          e.exit("");
        },
      };
    },
  };
  const svc = new FleetHostService(home, runner);
  const workspaceId = svc.register("Project", root).id;
  const peer = {
    hostId: "a".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [workspaceId],
    control: true,
  };
  const viewer = { hostId: peer.hostId, deviceId: "c".repeat(32), pairingId: "pairing-one" };
  const body = (extra: object = {}) => ({
    operationId: crypto.randomUUID(),
    hostId: peer.hostId,
    workspaceId,
    ...extra,
  });
  const start = body({ text: "secret original prompt" });
  svc.mutate(peer, HOST_API + "/runs", start);
  const id = start.operationId;
  return {
    home,
    root,
    runner,
    svc,
    peer,
    viewer,
    body,
    id,
    events: () => events,
    page: (after = 0, limit = 100) =>
      svc.readViewer(viewer, `${VIEW_API}/runs/${id}/events?after=${after}&limit=${limit}`),
    async close() {
      await svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("Pocket shares bind one task to a secure pairing and project only viewer fields", async () => {
  const f = fixture();
  try {
    const url = `${VIEW_API}/runs/${f.id}/events`;
    assert.deepEqual(f.svc.readViewer(f.viewer, VIEW_API + "/runs"), { runs: [] });
    assert.throws(() => f.page(), /run_not_found/);
    assert.throws(
      () => f.svc.share({ ...f.viewer, hostId: "d".repeat(32) }, f.id, true),
      /run_not_found/,
    );
    f.svc.share(f.viewer, f.id, true);
    const approval = {
      id: crypto.randomUUID(),
      tool: "Write",
      input: { file_path: path.join(f.root, "notes.txt"), content: "private input" },
      expiresAt: Date.now() + 60_000,
    };
    f.events().approval(approval);
    const page = f.page();
    assert.ok("events" in page);
    assert.deepEqual(page.run.approval, {
      tool: "Write",
      target: "notes.txt",
      expiresAt: approval.expiresAt,
    });
    assert.deepEqual(page.events[0], {
      seq: 1,
      at: page.events[0]!.at,
      type: "turn_started",
      turn: 1,
    });
    const encoded = JSON.stringify(page);
    for (const secret of [
      approval.id,
      "private input",
      "secret original prompt",
      "approvalId",
      f.peer.deviceId,
      f.root,
    ])
      assert.ok(!encoded.includes(secret), secret);
    for (const changed of [
      { deviceId: "d".repeat(32) },
      { pairingId: "pairing-two" },
      { hostId: "d".repeat(32) },
    ]) {
      const other = { ...f.viewer, ...changed };
      assert.deepEqual(f.svc.readViewer(other, VIEW_API + "/runs"), { runs: [] });
      assert.throws(() => f.svc.readViewer(other, url), /run_not_found/);
    }
    for (const route of [
      HOST_API + "/runs",
      `${HOST_API}/runs/${f.id}`,
      `${VIEW_API}/runs/${f.id}/decisions`,
    ])
      assert.throws(() => f.svc.readViewer(f.viewer, route), /route_not_found/);
    // Controller reads retain their original approval; sharing changes no execution authority.
    const original = f.svc.read(f.peer, `${HOST_API}/runs/${f.id}`) as {
      run: { approval: { id: string } };
    };
    assert.equal(original.run.approval.id, approval.id);
    f.svc.mutate(
      f.peer,
      `${HOST_API}/runs/${f.id}/decisions`,
      f.body({ approvalId: approval.id, allow: true }),
    );
    f.events().result("x".repeat(5000), false);
    const done = f.page();
    assert.ok("events" in done);
    assert.equal(done.run.result.length, 4000);
    assert.equal(done.run.truncated, true);
    assert.equal(done.events.find((e) => e.type === "approval_resolved")?.outcome, "allowed");
    f.svc.share(f.viewer, f.id, false);
    assert.throws(() => f.page(2), /run_not_found/);
    assert.deepEqual(f.svc.readViewer(f.viewer, VIEW_API + "/runs"), { runs: [] });
  } finally {
    await f.close();
  }
});

test("viewer reconnect pages two turns without replay and survives restart, pruning and future fields", async () => {
  const f = fixture();
  try {
    f.svc.share(f.viewer, f.id, true);
    const first = f.page(0, 1);
    assert.ok("events" in first);
    f.events().result("first result", false);
    f.svc.mutate(f.peer, `${HOST_API}/runs/${f.id}/messages`, f.body({ text: "secret follow-up" }));
    f.events().result("second result", false);
    const page = f.page(1, 2);
    assert.ok("events" in page);
    assert.deepEqual(
      page.events.map((e) => e.seq),
      [2, 3],
    );
    assert.equal(page.more, true);
    const tail = f.page(3);
    assert.ok("events" in tail);
    assert.deepEqual(
      tail.events.map((e) => e.seq),
      [4],
    );
    assert.equal(tail.more, false);
    assert.deepEqual(f.page(4), { ...tail, events: [] });
    // Close the run so shutdown adds no new timeline entries.
    f.svc.mutate(f.peer, `${HOST_API}/runs/${f.id}/cancel`, f.body());
    await f.svc.shutdown();
    const db = new DatabaseSync(path.join(f.home, "fleet", "runs.sqlite"));
    db.prepare("DELETE FROM events WHERE run=? AND seq<3").run(f.id);
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(
      f.id,
      7,
      Date.now(),
      "future_event",
      JSON.stringify({ input: "future private field", approvalId: "future secret" }),
    );
    db.close();
    const reopened = new FleetHostService(f.home, f.runner);
    try {
      const restored = reopened.readViewer(f.viewer, `${VIEW_API}/runs/${f.id}/events?after=1`);
      assert.ok("events" in restored);
      assert.equal(restored.gap, true);
      assert.equal(restored.firstSeq, 3);
      assert.deepEqual(Object.keys(restored.events.at(-1)!).sort(), ["at", "seq", "type"]);
      const reset = reopened.readViewer(f.viewer, `${VIEW_API}/runs/${f.id}/events?after=999`);
      assert.ok("events" in reset);
      assert.equal(reset.reset, true);
      assert.deepEqual(reset.events, restored.events);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await f.close();
  }
});

test("viewer route allow-list accepts only two canonical GET endpoints", () => {
  const id = crypto.randomUUID(),
    base = `${VIEW_API}/runs/${id}`;
  for (const route of [VIEW_API + "/runs", base + "/events", base + "/events?after=0&limit=100"]) {
    assert.equal(fleetViewRoute("GET", route), true);
    assert.equal(fleetRoute("GET", route), false);
    for (const method of ["POST", "PUT", "DELETE"])
      assert.equal(fleetViewRoute(method, route), false);
  }
  for (const route of [
    base,
    base + "/decisions",
    base + "/events?limit=10",
    base + "/events?after=-1",
    base + "/events?after=1&after=2",
    VIEW_API + "/runs/../runs",
    HOST_API + "/runs",
  ])
    assert.equal(fleetViewRoute("GET", route), false, route);
});

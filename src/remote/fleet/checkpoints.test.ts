import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FleetHostService } from "./host-service.js";
import type { ClaudeEvents, ClaudeRunner } from "./claude.js";
import { FleetCheckpoints, repositoryIdentity } from "./checkpoints.js";
import { fleetRoute, fleetViewRoute, HOST_API, VIEW_API } from "./types.js";

function git(root: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
}
function fixture(
  configure?: (source: string, dir: string) => void,
  onSend?: (count: number, root: string, events: ClaudeEvents) => void,
) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-checkpoints-")));
  const home = path.join(dir, "lisa"),
    source = path.join(dir, "source");
  fs.mkdirSync(source);
  git(source, "init", "--template=");
  fs.writeFileSync(path.join(source, "a.txt"), "original\n");
  fs.writeFileSync(path.join(source, "delete.txt"), "delete me\n");
  fs.writeFileSync(path.join(source, ".gitignore"), "secret*\n");
  git(source, "add", ".");
  git(source, "commit", "-m", "initial");
  configure?.(source, dir);
  let events!: ClaudeEvents,
    sends = 0;
  const runner: ClaudeRunner = {
    reason: () => null,
    start(_, e) {
      events = e;
      return {
        send() {
          sends++;
          onSend?.(sends, root, e);
        },
        decide() {},
        cancel() {
          e.exit("");
        },
      };
    },
  };
  const svc = new FleetHostService(home, runner);
  const original = svc.register("Source", source);
  const worktree = svc.createWorktree(original.id),
    root = worktree.root;
  const peer = {
    hostId: "a".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [worktree.id],
    control: true,
  };
  const body = (extra: object = {}) => ({
    hostId: peer.hostId,
    workspaceId: worktree.id,
    operationId: crypto.randomUUID(),
    ...extra,
  });
  const start = body({ text: "change things" }),
    id = start.operationId;
  const route = `${HOST_API}/runs/${id}`;
  const read = (suffix = "", as = peer) =>
    svc.read(as, route + "/changes" + suffix) as {
      turns: { turn: number; state: string; available: boolean; reason?: string }[];
      files: { id: number; status: string; path: string }[];
      patch: string;
      concurrent: boolean;
      truncated: boolean;
    };
  return {
    dir,
    home,
    source,
    root,
    original,
    svc,
    runner,
    peer,
    body,
    start,
    id,
    route,
    read,
    events: () => events,
    sends: () => sends,
    async close() {
      await svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("per-turn snapshots preserve staging, include untracked changes and survive in-turn commits", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, "a.txt"), "staged before task\n");
    git(f.root, "add", "a.txt");
    fs.writeFileSync(path.join(f.root, "a.txt"), "working before task\n");
    fs.writeFileSync(path.join(f.root, "baseline.txt"), "already here\n");
    fs.writeFileSync(path.join(f.root, "secret.env"), "secret not to snapshot\n");
    const index = git(f.root, "ls-files", "--stage"),
      head = git(f.root, "rev-parse", "HEAD");
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    assert.equal(git(f.root, "ls-files", "--stage"), index);
    assert.equal(git(f.root, "rev-parse", "HEAD"), head);
    fs.writeFileSync(path.join(f.root, "a.txt"), "first turn\n");
    fs.writeFileSync(path.join(f.root, ":(glob)*\nnew.txt"), "new file\n");
    fs.unlinkSync(path.join(f.root, "delete.txt"));
    f.events().result("first done", false);
    assert.equal(git(f.root, "ls-files", "--stage"), index, "capture never stages user's files");
    assert.equal(git(f.source, "status", "--porcelain"), "", "source checkout stays untouched");
    const first = f.read("/1");
    assert.deepEqual(
      first.files.map((x) => [x.status, x.path]),
      [
        ["A", ":(glob)*\nnew.txt"],
        ["M", "a.txt"],
        ["D", "delete.txt"],
      ],
    );
    const patch = f.read("/1/" + first.files.find((x) => x.path === "a.txt")!.id).patch;
    assert.match(patch, /-working before task/);
    assert.match(patch, /\+first turn/);
    assert.doesNotMatch(patch, /staged before task/);
    assert.equal(first.concurrent, false);
    assert.match(f.read("/1/0").patch, /new file/);
    // Replaying the same receipt neither re-captures a baseline nor sends twice.
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    assert.equal(f.sends(), 1);
    // Changes made between turns belong to the next baseline, not that turn's diff.
    fs.writeFileSync(path.join(f.root, "a.txt"), "idle human edit\n");
    const follow = f.body({ text: "next" });
    f.svc.mutate(f.peer, f.route + "/messages", follow);
    fs.writeFileSync(path.join(f.root, "a.txt"), "second turn\n");
    git(f.root, "add", "a.txt");
    git(f.root, "commit", "-m", "human commit during turn");
    f.events().result("second done", false);
    f.svc.mutate(f.peer, f.route + "/messages", follow);
    assert.equal(f.sends(), 2);
    assert.equal(f.read("/2").concurrent, true);
    assert.match(f.read("/2/0").patch, /-idle human edit/);
    assert.match(f.read("/2/0").patch, /\+second turn/);
    assert.equal(f.read().turns.length, 2);
    assert.throws(() => f.read("/1", { ...f.peer, deviceId: "d".repeat(32) }), /run_not_found/);
    assert.throws(() => f.read("/1", { ...f.peer, workspaces: [] }), /run_not_found/);
    assert.throws(
      () =>
        f.svc.readViewer(
          { hostId: f.peer.hostId, deviceId: "c".repeat(32), pairingId: "phone" },
          VIEW_API + `/runs/${f.id}/changes`,
        ),
      /route_not_found/,
    );
    assert.throws(() => f.svc.clearCheckpoints(f.id), /run_not_finished/);
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    assert.match(
      f.read("/1/1").patch,
      /first turn/,
      "idle cancellation does not overwrite the completed boundary",
    );
    await f.svc.shutdown();
    const restarted = new FleetHostService(f.home, f.runner);
    try {
      assert.match(
        (restarted.read(f.peer, f.route + "/changes/2/0") as { patch: string }).patch,
        /second turn/,
      );
      restarted.clearCheckpoints(f.id);
      assert.equal(fs.existsSync(path.join(f.home, "fleet", "checkpoints", f.id)), false);
      assert.throws(
        () => restarted.read(f.peer, f.route + "/changes/1/0"),
        /checkpoint_unavailable/,
      );
      assert.ok(
        restarted.read(f.peer, HOST_API + "/operations/" + f.id),
        "cleanup preserves idempotency receipts",
      );
      assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "second turn\n");
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});

test("cancelled turns capture partial changes; a backend restart never fabricates an end snapshot", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    fs.writeFileSync(path.join(f.root, "a.txt"), "partial\n");
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    assert.equal(f.read().turns[0]!.state, "interrupted");
    assert.match(f.read("/1/0").patch, /partial/);
    const next = f.body({ text: "will be interrupted" });
    f.svc.mutate(f.peer, HOST_API + "/runs", next);
    const second = new FleetHostService(f.home, f.runner);
    try {
      const history = second.read(f.peer, `${HOST_API}/runs/${next.operationId}/changes`) as {
        turns: { state: string; available: boolean }[];
      };
      assert.equal(history.turns[0]!.state, "interrupted");
      assert.equal(history.turns[0]!.available, false);
    } finally {
      await second.shutdown();
    }
  } finally {
    await f.close();
  }
});

test("snapshots never run filters/hooks, bound large diffs, and describe binary/symlink changes", async () => {
  const f = fixture();
  try {
    const sentinel = path.join(f.dir, "filter-ran");
    git(f.source, "config", "filter.evil.clean", `touch '${sentinel}'`);
    git(f.source, "config", "filter.evil.smudge", `touch '${sentinel}'`);
    fs.writeFileSync(
      path.join(f.root, ".gitattributes"),
      "*.txt filter=evil text working-tree-encoding=UTF-16\n",
    );
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    fs.writeFileSync(path.join(f.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    fs.symlinkSync("/etc/passwd", path.join(f.root, "link"));
    fs.writeFileSync(path.join(f.root, "large.txt"), "x".repeat(100_000));
    f.events().result("done", false);
    assert.equal(fs.existsSync(sentinel), false);
    const files = f.read("/1").files;
    assert.match(
      f.read("/1/" + files.find((x) => x.path === "binary.bin")!.id).patch,
      /Binary files/,
    );
    const link = f.read("/1/" + files.find((x) => x.path === "link")!.id).patch;
    assert.match(link, /\+\/etc\/passwd/);
    assert.doesNotMatch(link, /root:/);
    const large = f.read("/1/" + files.find((x) => x.path === "large.txt")!.id);
    assert.equal(large.truncated, true);
    assert.ok(Buffer.byteLength(large.patch) <= 65536);
  } finally {
    await f.close();
  }
});

test("ordinary workspaces, snapshot bounds and missing objects fail explicitly without stopping tasks", async () => {
  const f = fixture();
  try {
    const store = new FleetCheckpoints(f.home),
      id = crypto.randomUUID(),
      identity = repositoryIdentity(f.root);
    fs.writeFileSync(path.join(f.root, "huge"), Buffer.alloc(17 * 1024 * 1024));
    assert.equal(store.capture(id, 1, "before", f.root, identity).reason, "snapshot_limit");
    assert.equal(store.capture(id, 101, "before", f.root, identity).reason, "checkpoint_limit");
    fs.unlinkSync(path.join(f.root, "huge"));
    const peer = { ...f.peer, workspaces: [f.original.id] };
    const start = { ...f.start, workspaceId: f.original.id };
    f.svc.mutate(peer, HOST_API + "/runs", start);
    f.events().result("done without checkpoint", false);
    const ordinary = f.read("", peer).turns[0]!;
    assert.equal(ordinary.available, false);
    assert.equal(ordinary.reason, "managed_worktree_required");
    assert.equal(f.sends(), 1);
  } finally {
    await f.close();
  }
});

test("only controller grants can read canonical checkpoint routes", () => {
  const id = crypto.randomUUID();
  for (const tail of ["/changes", "/changes/1", "/changes/1/0"]) {
    assert.equal(fleetRoute("GET", `${HOST_API}/runs/${id}${tail}`), true);
    assert.equal(fleetRoute("POST", `${HOST_API}/runs/${id}${tail}`), false);
    assert.equal(fleetViewRoute("GET", `${VIEW_API}/runs/${id}${tail}`), false);
  }
  for (const tail of [
    "/changes/-1",
    "/changes/1/../../2",
    "/changes/1?file=x",
    "/changes/1/0/extra",
  ])
    assert.equal(fleetRoute("GET", `${HOST_API}/runs/${id}${tail}`), false);
});

test("creating a managed worktree does not run checkout hooks/filters or carry staged source edits", async () => {
  const f = fixture((source, dir) => {
    fs.writeFileSync(path.join(source, ".gitattributes"), "*.txt filter=evil\n");
    git(source, "add", ".gitattributes");
    git(source, "commit", "-m", "attributes");
    const sentinel = path.join(dir, "executed");
    git(source, "config", "filter.evil.smudge", `touch '${sentinel}'`);
    git(source, "config", "filter.evil.required", "true");
    const hooks = path.join(dir, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${sentinel}'\n`, {
      mode: 0o700,
    });
    git(source, "config", "core.hooksPath", hooks);
    fs.writeFileSync(path.join(source, "a.txt"), "staged in original\n");
    git(source, "-c", "filter.evil.required=false", "add", "a.txt");
  });
  try {
    assert.equal(fs.existsSync(path.join(f.dir, "executed")), false);
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "original\n");
    assert.match(git(f.source, "diff", "--cached"), /staged in original/);
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    f.events().result("done", false);
    assert.equal(f.read().turns[0]!.available, true);
  } finally {
    await f.close();
  }
});

test("a follow-up captures its baseline before dispatch, even with an immediate result or a failed send", async () => {
  const f = fixture(undefined, (count, root, events) => {
    if (count === 2) {
      fs.writeFileSync(path.join(root, "a.txt"), "instant second turn\n");
      events.result("immediate result", false);
    }
    if (count === 3) throw Error("process_unavailable");
  });
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    f.events().result("first result", false);
    f.svc.mutate(f.peer, f.route + "/messages", f.body({ text: "second" }));
    assert.match(f.read("/2/0").patch, /-original/);
    assert.match(f.read("/2/0").patch, /\+instant second turn/);
    const third = f.body({ text: "third" });
    assert.throws(() => f.svc.mutate(f.peer, f.route + "/messages", third), /process_unavailable/);
    assert.equal(f.read().turns[0]!.state, "interrupted");
    f.svc.mutate(f.peer, f.route + "/messages", third);
    assert.equal(f.sends(), 3, "failed receipt replay cannot dispatch a second time");
    assert.deepEqual(f.svc.ownerRuns(), [], "failed dispatch cannot leave the host reserved");
  } finally {
    await f.close();
  }
});

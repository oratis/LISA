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

function finishedMerge(f: ReturnType<typeof fixture>) {
  f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
  fs.writeFileSync(path.join(f.root, "a.txt"), "merged change\n");
  fs.writeFileSync(path.join(f.root, "new.txt"), "added\n");
  fs.unlinkSync(path.join(f.root, "delete.txt"));
  f.events().result("done", false);
  f.svc.mutate(f.peer, f.route + "/cancel", f.body());
  const peer = { ...f.peer, workspaces: [f.original.id, ...f.peer.workspaces] };
  const selection = f.body({ turn: 1, cleanup: false });
  return { peer, selection };
}

test("merge previews all checkpoint changes, commits once and preserves history after owned cleanup", async () => {
  const f = fixture();
  try {
    const { peer, selection } = finishedMerge(f);
    const head = git(f.source, "rev-parse", "HEAD");
    const preview = f.svc.previewMerge(peer, f.id, { ...selection, cleanup: true });
    assert.deepEqual(
      preview.files.map((x) => x.path),
      ["a.txt", "delete.txt", "new.txt"],
    );
    assert.match(preview.patch, /merged change/);
    assert.equal(git(f.source, "rev-parse", "HEAD"), head, "preview cannot write source branch");
    assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "original\n");
    const body = { ...selection, ...preview };
    const receipt = f.svc.merge(peer, f.id, body) as {
      status: string;
      merge: { commit: string; cleaned: boolean };
    };
    assert.equal(receipt.status, "accepted");
    assert.equal(receipt.merge.cleaned, true);
    assert.equal(git(f.source, "rev-parse", "HEAD").trim(), receipt.merge.commit);
    assert.equal(git(f.source, "rev-parse", "HEAD^"), head);
    assert.equal(git(f.source, "status", "--porcelain"), "");
    assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "merged change\n");
    assert.equal(fs.existsSync(path.join(f.source, "delete.txt")), false);
    assert.equal(fs.existsSync(f.root), false);
    assert.equal(f.svc.workspaces().find((w) => w.id === selection.workspaceId)?.archived, 1);
    assert.deepEqual(
      f.svc.merge(peer, f.id, body),
      receipt,
      "lost reply cannot merge/delete twice",
    );
    assert.match(
      f.read("/1/0").patch,
      /merged change/,
      "archived workspace keeps its immutable diff",
    );
    assert.throws(
      () => f.svc.mutate(peer, HOST_API + "/runs", f.body({ text: "new" })),
      /workspace_archived/,
    );
    assert.equal(f.svc.maintenanceStatus(), null);
  } finally {
    await f.close();
  }
});

test("merge requires current source and child grants; changed preview or expiry cannot write", async () => {
  const f = fixture();
  try {
    const { peer, selection } = finishedMerge(f);
    assert.throws(() => f.svc.previewMerge(f.peer, f.id, selection), /source_control_denied/);
    assert.throws(
      () => f.svc.previewMerge({ ...peer, control: false }, f.id, selection),
      /control_denied/,
    );
    const preview = f.svc.previewMerge(peer, f.id, selection);
    assert.throws(
      () => f.svc.merge(f.peer, f.id, { ...selection, ...preview }),
      /source_control_denied/,
    );
    assert.throws(
      () => f.svc.merge(peer, f.id, { ...selection, ...preview, cleanup: true }),
      /merge_preview_changed/,
    );
    assert.throws(
      () => f.svc.merge(peer, f.id, { ...selection, ...preview, expiresAt: Date.now() - 1 }),
      /preview_expired/,
    );
    fs.writeFileSync(path.join(f.root, "a.txt"), "later human edit\n");
    assert.throws(
      () => f.svc.merge(peer, f.id, { ...selection, ...preview }),
      /merge_worktree_changed/,
    );
    assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "original\n");
    assert.equal(fs.existsSync(f.root), true);
    assert.equal(f.svc.maintenanceStatus(), null);
  } finally {
    await f.close();
  }
});

test("merge refuses dirty/moved source, hidden index entries and ignored path collisions", async () => {
  const f = fixture(undefined, (_, root) => {
    fs.writeFileSync(path.join(root, "new.txt"), "added\n");
    git(root, "add", "new.txt");
  });
  try {
    const { peer, selection } = finishedMerge(f);
    const preview = f.svc.previewMerge(peer, f.id, selection);
    fs.writeFileSync(path.join(f.source, "a.txt"), "human change\n");
    assert.throws(
      () => f.svc.merge(peer, f.id, { ...selection, ...preview }),
      /merge_source_dirty/,
    );
    git(f.source, "checkout", "--", "a.txt");
    git(f.source, "update-index", "--assume-unchanged", "a.txt");
    assert.throws(() => f.svc.previewMerge(peer, f.id, selection), /merge_hidden_index/);
    git(f.source, "update-index", "--no-assume-unchanged", "a.txt");
    fs.mkdirSync(path.join(f.source, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(f.source, ".git", "info", "exclude"), "new.txt\n");
    fs.writeFileSync(path.join(f.source, "new.txt"), "ignored user data\n");
    assert.throws(() => f.svc.previewMerge(peer, f.id, selection), /merge_path_collision/);
    fs.unlinkSync(path.join(f.source, "new.txt"));
    git(f.source, "checkout", "-b", "other");
    assert.throws(() => f.svc.previewMerge(peer, f.id, selection), /merge_source_changed/);
  } finally {
    await f.close();
  }
});

test("merge never runs repository filters/hooks and optional cleanup preserves ignored files", async () => {
  const f = fixture((source, dir) => {
    fs.writeFileSync(path.join(source, ".gitattributes"), "*.txt filter=evil\n");
    git(source, "add", ".gitattributes");
    git(source, "commit", "-m", "attributes");
    git(source, "config", "filter.evil.clean", `touch '${path.join(dir, "ran")}'`);
    git(source, "config", "filter.evil.smudge", `touch '${path.join(dir, "ran")}'`);
    fs.mkdirSync(path.join(source, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(
      path.join(source, ".git", "hooks", "post-merge"),
      `#!/bin/sh\ntouch '${path.join(dir, "ran")}'\n`,
      { mode: 0o755 },
    );
  });
  try {
    const { peer, selection } = finishedMerge(f);
    fs.writeFileSync(path.join(f.root, "secret.env"), "keep me");
    assert.throws(
      () => f.svc.previewMerge(peer, f.id, { ...selection, cleanup: true }),
      /worktree_contains_ignored_files/,
    );
    const preview = f.svc.previewMerge(peer, f.id, selection);
    const receipt = f.svc.merge(peer, f.id, { ...selection, ...preview }) as { status: string };
    assert.equal(receipt.status, "accepted");
    assert.equal(fs.readFileSync(path.join(f.root, "secret.env"), "utf8"), "keep me");
    assert.equal(fs.existsSync(path.join(f.dir, "ran")), false);
  } finally {
    await f.close();
  }
});

test("unknown merge receipt reserves the host across backends until explicit owner verification", async () => {
  const f = fixture();
  const originalLink = fs.linkSync;
  try {
    const { peer, selection } = finishedMerge(f);
    const preview = f.svc.previewMerge(peer, f.id, selection);
    fs.linkSync = () => {
      throw new Error("I/O unavailable");
    };
    const body = { ...selection, ...preview };
    const receipt = f.svc.merge(peer, f.id, body) as { status: string };
    fs.linkSync = originalLink;
    assert.equal(receipt.status, "unknown");
    assert.deepEqual(f.svc.merge(peer, f.id, body), receipt);
    assert.throws(
      () => f.svc.mutate(peer, HOST_API + "/runs", f.body({ text: "new" })),
      /host_busy/,
    );
    const second = new FleetHostService(f.home, f.runner);
    try {
      assert.equal(second.maintenanceStatus()?.releasable, true);
      assert.throws(() => second.previewCleanup(), /host_busy/);
      assert.throws(() => second.releaseMaintenance(false), /maintenance_verification_required/);
      second.releaseMaintenance(true);
      assert.equal(f.svc.maintenanceStatus(), null);
      assert.deepEqual(
        f.svc.merge(peer, f.id, body),
        receipt,
        "owner verification does not replay uncertain I/O",
      );
    } finally {
      await second.shutdown();
    }
  } finally {
    fs.linkSync = originalLink;
    await f.close();
  }
});

test("a changed cleanup target is preserved even when the source merge already succeeded", async () => {
  const f = fixture(),
    link = fs.linkSync;
  try {
    const { peer, selection } = finishedMerge(f);
    const preview = f.svc.previewMerge(peer, f.id, { ...selection, cleanup: true });
    fs.linkSync = (source, destination) => {
      link(source, destination);
      fs.writeFileSync(path.join(f.root, "a.txt"), "human edit during merge\n");
    };
    const body = { ...selection, ...preview };
    const receipt = f.svc.merge(peer, f.id, body) as {
      status: string;
      merge: { commit: string; cleaned: boolean };
    };
    fs.linkSync = link;
    assert.equal(receipt.status, "unknown");
    assert.equal(receipt.merge.cleaned, false);
    assert.equal(git(f.source, "rev-parse", "HEAD").trim(), receipt.merge.commit);
    assert.equal(f.svc.maintenanceStatus()?.commit, receipt.merge.commit);
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "human edit during merge\n");
    assert.deepEqual(f.svc.merge(peer, f.id, body), receipt);
  } finally {
    fs.linkSync = link;
    await f.close();
  }
});

test("merge confirmation rejects changed Git configuration and previews from an earlier backend", async () => {
  const f = fixture();
  try {
    const { peer, selection } = finishedMerge(f);
    const preview = f.svc.previewMerge(peer, f.id, selection);
    git(f.source, "config", "core.filemode", "false");
    assert.throws(
      () => f.svc.merge(peer, f.id, { ...selection, ...preview }),
      /merge_preview_changed/,
    );
    const fresh = f.svc.previewMerge(peer, f.id, selection);
    await f.svc.shutdown();
    const reopened = new FleetHostService(f.home, f.runner);
    try {
      assert.throws(
        () => reopened.merge(peer, f.id, { ...selection, ...fresh }),
        /merge_preview_changed/,
      );
      assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "original\n");
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await f.close();
  }
});

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

test("file restore previews exact bytes, preserves the index and never replays over later edits", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    fs.writeFileSync(path.join(f.root, "a.txt"), "changed\n");
    fs.unlinkSync(path.join(f.root, "delete.txt"));
    fs.writeFileSync(path.join(f.root, "new.bin"), Buffer.from([0, 1, 2]));
    f.events().result("done", false);
    const id = f.start.operationId;
    const selection = (name: string) =>
      f.body({ turn: 1, file: f.read("/1").files.find((file) => file.path === name)!.id });
    assert.throws(() => f.svc.previewRestore(f.peer, id, selection("a.txt")), /run_not_finished/);
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    const index = git(f.root, "ls-files", "--stage");
    const request = selection("a.txt"),
      preview = f.svc.previewRestore(f.peer, id, request);
    assert.equal(preview.current.text, "changed\n");
    assert.equal(preview.target.text, "original\n");
    const command = {
      ...request,
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
    };
    const receipt = f.svc.restore(f.peer, id, command) as { status: string };
    assert.equal(receipt.status, "accepted");
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "original\n");
    fs.writeFileSync(path.join(f.root, "a.txt"), "later human edit\n");
    assert.equal((f.svc.restore(f.peer, id, command) as { status: string }).status, "accepted");
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "later human edit\n");
    assert.throws(() => f.svc.restore(f.peer, id, { ...command, file: 999 }), /operation_conflict/);
    for (const name of ["delete.txt", "new.bin"]) {
      const body = selection(name),
        p = f.svc.previewRestore(f.peer, id, body);
      assert.equal(
        (
          f.svc.restore(f.peer, id, {
            ...body,
            previewToken: p.previewToken,
            expiresAt: p.expiresAt,
          }) as { status: string }
        ).status,
        "accepted",
      );
    }
    assert.equal(fs.readFileSync(path.join(f.root, "delete.txt"), "utf8"), "delete me\n");
    assert.equal(fs.existsSync(path.join(f.root, "new.bin")), false);
    assert.equal(git(f.root, "ls-files", "--stage"), index);
    assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "original\n");
    await f.svc.shutdown();
    const reopened = new FleetHostService(f.home, f.runner);
    try {
      assert.equal(
        (reopened.restore(f.peer, id, command) as { status: string }).status,
        "accepted",
      );
      assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "later human edit\n");
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await f.close();
  }
});

test("restore rejects changed content, inode, preview expiry, grants and unsafe link targets", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    const file = path.join(f.root, "a.txt");
    fs.writeFileSync(file, "agent\n");
    f.events().result("done", false);
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    const id = f.start.operationId,
      body = f.body({ turn: 1, file: 0 });
    const p = f.svc.previewRestore(f.peer, id, body);
    const command = { ...body, expiresAt: p.expiresAt, previewToken: p.previewToken };
    assert.throws(
      () => f.svc.previewRestore({ ...f.peer, control: false }, id, body),
      /control_denied/,
    );
    assert.throws(() => f.svc.restore({ ...f.peer, workspaces: [] }, id, command), /run_not_found/);
    assert.throws(() => f.svc.restore(f.peer, id, { ...command, expiresAt: 1 }), /preview_expired/);
    fs.writeFileSync(file, "human\n");
    assert.throws(() => f.svc.restore(f.peer, id, command), /restore_preview_changed/);
    assert.equal(fs.readFileSync(file, "utf8"), "human\n");
    const fresh = f.svc.previewRestore(f.peer, id, body);
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, "human\n");
    assert.throws(
      () => f.svc.restore(f.peer, id, { ...command, ...fresh }),
      /restore_preview_changed/,
    );
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(f.source, "a.txt"), file);
    assert.throws(() => f.svc.previewRestore(f.peer, id, body), /unsafe_restore_path/);
    fs.unlinkSync(file);
    fs.linkSync(path.join(f.source, "a.txt"), file);
    assert.throws(() => f.svc.previewRestore(f.peer, id, body), /unsafe_restore_path/);
    assert.equal(fs.readFileSync(path.join(f.source, "a.txt"), "utf8"), "original\n");
  } finally {
    await f.close();
  }
});

test("an uncertain restore receipt prevents retry from overwriting a subsequent edit", async () => {
  const f = fixture();
  const sync = fs.fsyncSync;
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    const file = path.join(f.root, "a.txt");
    fs.writeFileSync(file, "agent\n");
    f.events().result("done", false);
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    const id = f.start.operationId,
      body = f.body({ turn: 1, file: 0 });
    const preview = f.svc.previewRestore(f.peer, id, body);
    const command = { ...body, expiresAt: preview.expiresAt, previewToken: preview.previewToken };
    fs.fsyncSync = () => {
      throw new Error("simulated I/O failure");
    };
    assert.equal((f.svc.restore(f.peer, id, command) as { status: string }).status, "unknown");
    fs.fsyncSync = sync;
    fs.writeFileSync(file, "human after failure\n");
    assert.equal((f.svc.restore(f.peer, id, command) as { status: string }).status, "unknown");
    assert.equal(fs.readFileSync(file, "utf8"), "human after failure\n");
  } finally {
    fs.fsyncSync = sync;
    await f.close();
  }
});

test("global checkpoint quota refuses new snapshots without losing old diffs or stopping the agent", async () => {
  const f = fixture();
  try {
    f.svc.configureStorage({ quotaMiB: 1, retentionDays: 0 });
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    fs.writeFileSync(path.join(f.root, "noise.bin"), crypto.randomBytes(900_000));
    f.events().result("first", false);
    assert.equal(f.read().turns[0]!.available, true);
    const first = f.read("/1").files;
    f.svc.mutate(f.peer, f.route + "/messages", f.body({ text: "second" }));
    fs.writeFileSync(path.join(f.root, "noise.bin"), crypto.randomBytes(900_000));
    f.events().result("second", false);
    assert.equal(f.read().turns[0]!.reason, "checkpoint_quota");
    assert.deepEqual(f.read("/1").files, first);
    assert.ok(f.svc.storage().usedBytes <= 1024 * 1024);
    assert.equal((f.svc.read(f.peer, f.route) as { run: { state: string } }).run.state, "waiting");
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    const next = f.body({ text: "new task shares the same quota" });
    f.svc.mutate(f.peer, HOST_API + "/runs", next);
    f.events().result("still executes", false);
    const history = f.svc.read(f.peer, `${HOST_API}/runs/${next.operationId}/changes`) as {
      turns: { reason: string }[];
    };
    assert.equal(history.turns[0]!.reason, "checkpoint_quota");
    assert.deepEqual(f.read("/1").files, first);
  } finally {
    await f.close();
  }
});

test("retention removes only old ended-task checkpoints and preserves task receipts", async () => {
  const f = fixture();
  try {
    f.svc.configureStorage({ quotaMiB: 512, retentionDays: 1 });
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    fs.writeFileSync(path.join(f.root, "a.txt"), "keep workspace\n");
    f.events().result("keep ledger", false);
    f.svc.applyRetention(Date.now() + 2 * 86400_000);
    assert.equal(
      f.read().turns[0]!.available,
      true,
      "an open provider session must retain its snapshots",
    );
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    f.svc.applyRetention(Date.now() + 2 * 86400_000);
    assert.equal(f.read().turns[0]!.state, "cleared");
    assert.equal(f.svc.storage().usedBytes, 0);
    assert.ok(f.svc.storage().receipts > 0);
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "keep workspace\n");
    assert.equal(
      (f.svc.read(f.peer, f.route) as { run: { result: string } }).run.result,
      "keep ledger",
    );
  } finally {
    await f.close();
  }
});

test("complete ledger cleanup requires a current preview and rotates generation before removing receipts", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    assert.throws(() => f.svc.previewCleanup(), /host_busy/);
    f.events().result("DELETE_ME_FLEET_SECRET_46b17f", false);
    f.svc.mutate(f.peer, f.route + "/cancel", f.body());
    const stale = f.svc.previewCleanup();
    f.svc.configureStorage({ quotaMiB: 256, retentionDays: 0 });
    assert.throws(() => f.svc.clearLedger(stale), /cleanup_preview_changed/);
    const preview = f.svc.previewCleanup();
    assert.equal(preview.runs, 1);
    assert.ok(preview.receipts > 0);
    f.svc.storage(); // Read-only polling does not invalidate a preview.
    const cleared = f.svc.clearLedger(preview);
    assert.equal(cleared.compacted, true);
    assert.equal(f.svc.storage().runs, 0);
    assert.equal(f.svc.storage().receipts, 0);
    assert.equal(f.svc.storage().usedBytes, 0);
    assert.equal(f.svc.workspaces().length, 2);
    assert.equal(fs.readFileSync(path.join(f.root, "a.txt"), "utf8"), "original\n");
    for (const file of ["runs.sqlite", "runs.sqlite-wal"]) {
      const filename = path.join(f.home, "fleet", file);
      if (fs.existsSync(filename))
        assert.ok(
          !fs.readFileSync(filename).includes(Buffer.from("DELETE_ME_FLEET_SECRET_46b17f")),
        );
    }
    assert.throws(
      () => f.svc.mutate(f.peer, HOST_API + "/runs", f.start),
      /operation_generation_changed/,
    );
    assert.throws(
      () => f.svc.mutate(f.peer, HOST_API + "/runs", { ...f.start, operationGeneration: "old" }),
      /operation_generation_changed/,
    );
    await f.svc.shutdown();
    const reopened = new FleetHostService(f.home, f.runner);
    try {
      assert.equal(reopened.operationGeneration(), cleared.operationGeneration);
      assert.throws(
        () => reopened.mutate(f.peer, HOST_API + "/runs", f.start),
        /operation_generation_changed/,
      );
      reopened.mutate(
        f.peer,
        HOST_API + "/runs",
        f.body({ text: "explicit new task", operationGeneration: cleared.operationGeneration }),
      );
      assert.equal(reopened.storage().runs, 1);
    } finally {
      await reopened.shutdown();
    }
  } finally {
    await f.close();
  }
});

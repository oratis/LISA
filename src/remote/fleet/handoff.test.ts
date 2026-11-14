import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ClaudeEvents, ClaudeRunner } from "./claude.js";
import { FleetHostService } from "./host-service.js";
import { fleetRoute, fleetViewRoute, HOST_API, VIEW_API } from "./types.js";
import type { FleetActions } from "./capabilities.js";
import type { AgentSession } from "../../integrations/types.js";

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-handoff-")));
  const home = path.join(dir, "home"),
    source = path.join(dir, "source");
  fs.mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        ...args,
      ],
      {
        cwd: source,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  git("init", "--template=");
  fs.writeFileSync(path.join(source, "file.txt"), "before\n");
  git("add", ".");
  git("commit", "-m", "initial");
  const events: Record<string, ClaudeEvents> = {},
    sends: { agent: string; text: string }[] = [];
  let codexUnavailable: string | null = null;
  const runner = (agent: string): ClaudeRunner => ({
    reason: () => (agent === "codex" ? codexUnavailable : null),
    start(_, e) {
      events[agent] = e;
      return {
        send: (text) => {
          sends.push({ agent, text });
        },
        decide() {},
        cancel: () => e.exit(""),
      };
    },
  });
  let observed: AgentSession[] = [];
  const reopen = () =>
    new FleetHostService(home, runner("claude-code"), {
      codex: runner("codex"),
      observed: () => observed,
    });
  const svc = reopen();
  const workspace = svc.createWorktree(svc.register("Source", source).id);
  const peer = {
    hostId: "a".repeat(32),
    deviceId: "b".repeat(32),
    workspaces: [workspace.id],
    control: true,
  };
  const body = (extra: object = {}) => ({
    hostId: peer.hostId,
    workspaceId: workspace.id,
    operationId: crypto.randomUUID(),
    ...extra,
  });
  const start = body({ text: "Original request " + "x".repeat(600) }),
    id = start.operationId;
  const route = `${HOST_API}/runs/${id}`;
  const read = (run = id, as = peer) =>
    (
      svc.read(as, `${HOST_API}/runs/${run}`) as {
        run: { agent: string; state: string; approval: unknown; capabilities: FleetActions };
      }
    ).run;
  const finish = () => {
    fs.writeFileSync(path.join(workspace.root, "file.txt"), "after\n");
    events["claude-code"]!.result("Implementation done; test output is only an agent claim", false);
    svc.mutate(peer, route + "/cancel", body());
  };
  return {
    dir,
    home,
    reopen,
    source,
    workspace,
    peer,
    svc,
    body,
    start,
    id,
    route,
    read,
    finish,
    sends,
    events,
    observe: (sessions: AgentSession[]) => {
      observed = sessions;
    },
    unavailable: (reason: string | null) => {
      codexUnavailable = reason;
    },
    async close() {
      await svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("host capabilities distinguish scoped external observations, live adapters and viewer rights", async () => {
  const f = fixture();
  try {
    const ext: AgentSession = {
      agent: "codex",
      sessionId: f.id,
      project: "secret project",
      cwd: f.workspace.root,
      state: "working",
      stateReason: "hidden",
      lastMtime: 123,
      activity: {
        turnCount: 1,
        lastTools: ["Read"],
        filesTouched: ["secret.txt"],
        approvalId: "do-not-forward",
      },
    };
    f.observe([ext, { ...ext, cwd: f.source }, { ...ext, controllable: "pty" }]);
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    const providers = (
      f.svc.read(f.peer, HOST_API + "/capabilities") as { agents: { start: boolean }[] }
    ).agents;
    assert.ok(
      providers.every((a) => !a.start),
      "an occupied host advertises no new starts, including to other controllers",
    );
    let actions = f.read().capabilities;
    assert.equal(actions.observe, true);
    assert.equal(actions.cancel, true);
    assert.equal(actions.append, false);
    assert.equal(actions.approve, false);
    assert.equal(actions.resume, false);
    const approval = {
      id: crypto.randomUUID(),
      tool: "Write",
      input: { file_path: path.join(f.workspace.root, "file.txt"), content: "private" },
      expiresAt: Date.now() + 10000,
    };
    f.events["claude-code"]!.approval(approval);
    assert.equal(f.read().capabilities.approve, true);
    assert.equal(f.read(f.id, { ...f.peer, control: false }).capabilities.approve, false);
    assert.throws(
      () =>
        f.svc.mutate(
          { ...f.peer, control: false },
          f.route + "/decisions",
          f.body({ approvalId: approval.id, allow: true }),
        ),
      /control_denied/,
    );
    const listing = f.svc.read(f.peer, HOST_API + "/runs") as {
      observations: { capabilities: FleetActions }[];
    };
    assert.equal(listing.observations.length, 1);
    assert.deepEqual(listing.observations[0]!.capabilities, {
      observe: true,
      append: false,
      cancel: false,
      approve: false,
      resume: false,
      handoff: false,
    });
    assert.doesNotMatch(JSON.stringify(listing.observations), /secret|do-not-forward|file_path/);
    assert.equal(
      (f.svc.read({ ...f.peer, workspaces: [] }, HOST_API + "/runs") as { observations: unknown[] })
        .observations.length,
      0,
    );
    f.events["claude-code"]!.result("done", false);
    actions = f.read().capabilities;
    assert.equal(actions.append, true);
    assert.equal(actions.approve, false);
    f.finish();
    assert.equal(f.read().capabilities.handoff, true);
    const viewer = { hostId: f.peer.hostId, deviceId: "c".repeat(32), pairingId: "phone" };
    f.svc.share(viewer, f.id, true);
    const shared = f.svc.readViewer(viewer, `${VIEW_API}/runs`) as {
      runs: { capabilities: FleetActions; agent: string }[];
    };
    assert.equal(shared.runs[0]!.agent, "claude-code");
    assert.deepEqual(shared.runs[0]!.capabilities, listing.observations[0]!.capabilities);
  } finally {
    await f.close();
  }
});

test("confirmed Claude to Codex handoff sends the exact preview once and never transfers approval", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    const selection = f.body({
      agent: "codex",
      turn: 1,
      verification: "npm test: passed (owner report)",
    });
    assert.throws(() => f.svc.previewHandoff(f.peer, f.id, selection), /finish_source_first/);
    const oldApproval = crypto.randomUUID();
    f.events["claude-code"]!.approval({
      id: oldApproval,
      tool: "Write",
      input: { file_path: path.join(f.workspace.root, "file.txt"), content: "old approval secret" },
      expiresAt: Date.now() + 10000,
    });
    f.finish();
    const preview = f.svc.previewHandoff(f.peer, f.id, selection);
    assert.equal(f.sends.length, 1, "preview starts no receiver");
    assert.ok(preview.prompt.includes(f.start.text));
    assert.match(preview.prompt, /\+after/);
    assert.match(preview.prompt, /npm test: passed/);
    assert.match(preview.prompt, /not independently verified/);
    assert.doesNotMatch(preview.prompt, /old approval secret|approvalId/);
    const confirmation = {
      ...selection,
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
    };
    f.svc.mutate(f.peer, f.route + "/handoff", confirmation);
    f.svc.mutate(f.peer, f.route + "/handoff", confirmation);
    assert.equal(f.sends.length, 2);
    assert.equal(f.sends[1]!.agent, "codex");
    assert.equal(f.sends[1]!.text, preview.prompt);
    const run = f.read(selection.operationId);
    assert.equal(run.agent, "codex");
    assert.equal(run.approval, null);
    assert.equal(run.capabilities.append, false);
    assert.equal(run.capabilities.approve, false);
    assert.equal(run.capabilities.cancel, true);
    assert.equal(run.capabilities.resume, false);
    f.events.codex!.result("Reviewed", false);
    assert.throws(
      () =>
        f.svc.mutate(
          f.peer,
          `${HOST_API}/runs/${selection.operationId}/messages`,
          f.body({ text: "again" }),
        ),
      /append_unavailable/,
    );
    assert.throws(
      () =>
        f.svc.mutate(
          f.peer,
          `${HOST_API}/runs/${selection.operationId}/decisions`,
          f.body({ approvalId: crypto.randomUUID(), allow: true }),
        ),
      /stale_approval/,
    );
    f.events.codex!.exit("");
    assert.equal(f.read(selection.operationId).state, "completed");
    f.svc.mutate(f.peer, f.route + "/handoff", confirmation);
    assert.equal(
      f.sends.length,
      2,
      "receipt survives receiver completion and source timeline advancing",
    );
    const back = f.body({ agent: "claude-code", turn: 1 });
    const reverse = f.svc.previewHandoff(f.peer, selection.operationId, back);
    f.svc.mutate(f.peer, `${HOST_API}/runs/${selection.operationId}/handoff`, {
      ...back,
      previewToken: reverse.previewToken,
      expiresAt: reverse.expiresAt,
    });
    const newApproval = crypto.randomUUID();
    f.events["claude-code"]!.approval({
      id: newApproval,
      tool: "Edit",
      input: { file_path: path.join(f.workspace.root, "file.txt") },
      expiresAt: Date.now() + 10000,
    });
    assert.equal(f.read(back.operationId).capabilities.approve, true);
    assert.throws(
      () =>
        f.svc.mutate(
          f.peer,
          `${HOST_API}/runs/${back.operationId}/decisions`,
          f.body({ approvalId: oldApproval, allow: true }),
        ),
      /stale_approval/,
    );
    assert.doesNotThrow(() =>
      f.svc.mutate(
        f.peer,
        `${HOST_API}/runs/${back.operationId}/decisions`,
        f.body({ approvalId: newApproval, allow: true }),
      ),
    );
  } finally {
    await f.close();
  }
});

test("handoff confirmation fails closed after edits, expiry, revocation, cleanup or adapter loss", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    f.finish();
    const selection = f.body({ agent: "codex", turn: 1, verification: "not tested" });
    const preview = f.svc.previewHandoff(f.peer, f.id, selection);
    const confirmation = {
      ...selection,
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
    };
    for (const values of [{ verification: "tested" }, { previewToken: "0".repeat(64) }])
      assert.throws(
        () => f.svc.mutate(f.peer, f.route + "/handoff", { ...confirmation, ...values }),
        /handoff_preview_changed/,
      );
    assert.throws(
      () =>
        f.svc.mutate(f.peer, f.route + "/handoff", { ...confirmation, expiresAt: Date.now() - 1 }),
      /handoff_preview_expired/,
    );
    assert.throws(
      () =>
        f.svc.mutate({ ...f.peer, deviceId: "c".repeat(32) }, f.route + "/handoff", confirmation),
      /run_not_found/,
    );
    assert.throws(
      () => f.svc.mutate({ ...f.peer, workspaces: [] }, f.route + "/handoff", confirmation),
      /control_denied/,
    );
    f.unavailable("codex_not_installed");
    assert.equal(f.read().capabilities.handoff, false);
    assert.throws(
      () => f.svc.mutate(f.peer, f.route + "/handoff", confirmation),
      /codex_not_installed/,
    );
    f.unavailable(null);
    f.svc.clearCheckpoints(f.id);
    assert.equal(f.read().capabilities.handoff, false);
    assert.throws(
      () => f.svc.mutate(f.peer, f.route + "/handoff", confirmation),
      /checkpoint_unavailable/,
    );
    assert.equal(f.sends.length, 1);
    assert.throws(
      () => f.svc.read(f.peer, `${HOST_API}/operations/${selection.operationId}`),
      /operation_not_found/,
    );
  } finally {
    await f.close();
  }
});

test("handoff refuses oversized turns instead of silently dropping files", async () => {
  const f = fixture();
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    for (let i = 0; i < 21; i++)
      fs.writeFileSync(path.join(f.workspace.root, `new-${i}.txt`), "change");
    f.finish();
    assert.throws(
      () => f.svc.previewHandoff(f.peer, f.id, f.body({ agent: "codex", turn: 1 })),
      /handoff_too_large/,
    );
    assert.equal(f.sends.length, 1);
  } finally {
    await f.close();
  }
});

test("backend restart invalidates previews but retains confirmed handoff receipts and context", async () => {
  const f = fixture();
  let second: FleetHostService | undefined;
  try {
    f.svc.mutate(f.peer, HOST_API + "/runs", f.start);
    f.finish();
    const selection = f.body({ agent: "codex", turn: 1 });
    const old = f.svc.previewHandoff(f.peer, f.id, selection);
    await f.svc.shutdown();
    second = f.reopen();
    assert.throws(
      () =>
        second!.mutate(f.peer, f.route + "/handoff", {
          ...selection,
          previewToken: old.previewToken,
          expiresAt: old.expiresAt,
        }),
      /handoff_preview_changed/,
    );
    const fresh = second.previewHandoff(f.peer, f.id, selection);
    assert.equal(fresh.prompt, old.prompt);
    const confirmation = {
      ...selection,
      previewToken: fresh.previewToken,
      expiresAt: fresh.expiresAt,
    };
    second.mutate(f.peer, f.route + "/handoff", confirmation);
    f.events.codex!.result("review complete", false);
    f.events.codex!.exit("");
    await second.shutdown();
    second = f.reopen();
    second.mutate(f.peer, f.route + "/handoff", confirmation);
    assert.equal(
      f.sends.length,
      2,
      "a recorded handoff replays even though its preview signature belongs to an earlier backend",
    );
  } finally {
    await second?.shutdown();
    await f.close();
  }
});

test("handoff routes require controller grants and cannot be used by Pocket or arbitrary paths", () => {
  const id = crypto.randomUUID();
  for (const tail of ["handoff", "handoff-preview"]) {
    assert.equal(fleetRoute("POST", `${HOST_API}/runs/${id}/${tail}`), true);
    assert.equal(fleetRoute("GET", `${HOST_API}/runs/${id}/${tail}`), false);
    assert.equal(fleetViewRoute("POST", `${VIEW_API}/runs/${id}/${tail}`), false);
    assert.equal(fleetRoute("POST", `${HOST_API}/runs/${id}/${tail}?agent=codex`), false);
  }
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdmissionDependencies } from "../billing/admission.js";
import type { UsageRecord } from "../billing/meter.js";
import { homeForUid, homeScope, scopedUid } from "../paths.js";
import type { Provider, ProviderResult, ProviderUsage } from "../providers/types.js";
import type { AccountRecord } from "../web/accounts.js";
import { createTaskHost } from "../web/tasks-host.js";
import { cloudModelGate, sweepUserTasks, TASK_USAGE_SOURCE } from "./cloud.js";
import { TaskRunner } from "./runner.js";
import { createTask, getTask, listRuns, listTasks } from "./store.js";

let home: string;
let previousHome: string | undefined;
before(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-tasks-cloud-"));
  process.env.LISA_HOME = home;
});
after(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-02T08:00:00Z");
let uidN = 0;
const freshUid = () => `u${++uidN}x${Math.random().toString(36).slice(2, 8)}`;
const account = (uid: string): AccountRecord => ({
  uid,
  kind: "email",
  email: `${uid}@example.com`,
  createdAt: 1,
  lastLoginAt: 1,
  verified: true,
  sessionVersion: 0,
});

const USAGE_RECORD: UsageRecord = {
  at: "2026-10-02T08:00:00.000Z",
  source: TASK_USAGE_SOURCE,
  model: "m",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  microUSD: 3,
  pricesVersion: 1,
};

/** Real admitInference, with its dependencies recorded and overridable. */
function admission(over: Partial<AdmissionDependencies> = {}) {
  const calls: string[] = [];
  const settled: Array<{ source: string; usage: ProviderUsage; reservationId: string }> = [];
  const deps: AdmissionDependencies = {
    preflight: () => (calls.push("limits"), { ok: true }),
    acquire: async () => (calls.push("acquire"), "off"),
    precheck: async () => (calls.push("quota"), { ok: true, budgetMicroUSD: 1000 }),
    startRenewal: () => (calls.push("renew"), () => void calls.push("stop")),
    releaseLease: async () => void calls.push("release"),
    settle: async (_acct, source, _model, usage, reservationId) => {
      calls.push("settle");
      settled.push({ source, usage, reservationId });
      return USAGE_RECORD;
    },
    ...over,
  };
  return { calls, settled, deps };
}

function scripted(replies: Array<{ text?: string; tool?: string; tokens?: number }>) {
  let i = 0;
  const provider: Provider = {
    name: "fake",
    async runTurn(): Promise<ProviderResult> {
      const r = replies[i++];
      if (!r) throw new Error("scripted provider exhausted");
      return {
        content: r.tool
          ? [{ type: "tool_use", id: `tu_${i}`, name: r.tool, input: {} } as never]
          : [{ type: "text", text: r.text ?? "" } as never],
        stopReason: r.tool ? "tool_use" : "end_turn",
        usage: {
          inputTokens: r.tokens ?? 5,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
  return { provider, calls: () => i };
}

async function dueTask(uid: string, title = "Hourly check") {
  return await createTask(
    {
      kind: "routine",
      title,
      instruction: "Check.",
      origin: { kind: "api" },
      owner: uid,
      host: "cloud",
      schedule: { expr: "every:1h" },
      enabled: true,
      state: "scheduled",
      nextRunAt: NOW,
    },
    NOW - 1000,
  );
}

function tenantRunner(
  uid: string,
  provider: Provider,
  deps: AdmissionDependencies,
  lookup = async () => account(uid),
) {
  return new TaskRunner({
    tools: [
      {
        name: "kb_search",
        description: "",
        inputSchema: { type: "object" },
        execute: async () => "none",
      },
    ],
    model: "m",
    cwd: os.tmpdir(),
    provider,
    host: "cloud",
    modelGate: cloudModelGate(uid, { deps, lookup }),
    unattendedAllowed: () => true,
    log: () => {},
    now: () => NOW,
  });
}

const inTenant = <T>(uid: string, fn: () => Promise<T>): Promise<T> => {
  fs.mkdirSync(homeForUid(uid), { recursive: true });
  return homeScope.run(homeForUid(uid), fn);
};

// ── admission ──

test("each model call of a cloud run is admitted, settled as `task` usage, and released", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const task = await dueTask(uid);
    const { calls, settled, deps } = admission();
    const { provider } = scripted([
      { tool: "kb_search", tokens: 7 },
      { text: "Nothing new.", tokens: 9 },
    ]);
    const runner = tenantRunner(uid, provider, deps);
    await runner.tick();
    await runner.drain();
    const perCall = ["limits", "acquire", "quota", "renew", "settle", "stop", "release"];
    assert.deepEqual(calls, [...perCall, ...perCall]);
    assert.deepEqual(
      settled.map((s) => [s.source, s.usage.inputTokens]),
      [
        ["task", 7],
        ["task", 9],
      ],
    );
    assert.notEqual(
      settled[0]!.reservationId,
      settled[1]!.reservationId,
      "one reservation per call",
    );
    assert.equal((await listRuns((await getTask(task.id))!))[0]!.state, "succeeded");
  });
});

test("no allowance: the run is refused before any model call and nothing is settled", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const task = await dueTask(uid);
    const { calls, settled, deps } = admission({
      precheck: async () => ({
        ok: false,
        error: "quota_exhausted",
        resetAt: NOW + 3_600_000,
        tier: "free",
      }),
    });
    const script = scripted([{ text: "never" }]);
    const runner = tenantRunner(uid, script.provider, deps);
    await runner.tick();
    await runner.drain();
    assert.equal(script.calls(), 0, "the provider was never called");
    assert.deepEqual(settled, []);
    assert.ok(calls.includes("release"), "the turn lease taken for the precheck is given back");
    const run = (await listRuns((await getTask(task.id))!))[0]!;
    assert.equal(run.state, "failed");
    assert.equal(run.stopReason, "admission_denied");
    assert.match(run.error!, /quota_exhausted/);
    assert.deepEqual(run.tokens, { in: 0, out: 0 });
    const after = (await getTask(task.id))!;
    assert.equal(after.state, "paused", "switched off, not left to hammer admission every hour");
    assert.equal(after.enabled, false);
    assert.match(after.pausedReason!, /quota_exhausted/);
  });
});

test("the allowance running out mid-run stops it at that call", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const task = await dueTask(uid);
    let prechecks = 0;
    const { settled, deps } = admission({
      precheck: async () =>
        ++prechecks === 1
          ? { ok: true, budgetMicroUSD: 10 }
          : { ok: false, error: "quota_exhausted", resetAt: NOW + 1, tier: "free" },
    });
    const script = scripted([{ tool: "kb_search" }, { text: "never" }]);
    const runner = tenantRunner(uid, script.provider, deps);
    await runner.tick();
    await runner.drain();
    assert.equal(script.calls(), 1);
    assert.equal(settled.length, 1, "the call that did run was paid for");
    assert.equal((await listRuns((await getTask(task.id))!))[0]!.stopReason, "admission_denied");
  });
});

test("the kill switch / service pause and a missing account both deny", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const paused = cloudModelGate(uid, {
      lookup: async () => account(uid),
      deps: admission({
        preflight: () => ({ ok: false, status: 402, body: { error: "service_paused" } }),
      }).deps,
    });
    assert.deepEqual(await paused.admit("m"), {
      ok: false,
      reason: "service_paused",
      transient: false,
    });
    const gone = cloudModelGate(uid, { lookup: async () => null, deps: admission().deps });
    assert.deepEqual(await gone.admit("m"), { ok: false, reason: "account_not_found" });
  });
});

test("a busy tenant (chat turn in flight) or a rate limit is transient: the run is retried, not reported", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const task = await dueTask(uid);
    const { deps } = admission({ acquire: async () => null });
    const script = scripted([{ text: "never" }]);
    const runner = tenantRunner(uid, script.provider, deps);
    await runner.tick();
    await runner.drain();
    assert.equal(script.calls(), 0);
    const after = (await getTask(task.id))!;
    assert.equal(after.state, "queued");
    assert.equal(after.resumeAt, NOW + 60_000, "parked: the SAME run resumes later");
    assert.ok(after.activeRunId);
    assert.equal(after.authFailureCount, 0, "not counted as a refusal");
    assert.equal(after.enabled, true);
    const parked = (await listRuns(after))[0]!;
    assert.equal(parked.state, "interrupted");
    assert.match(parked.lastError!, /admission busy: turn_in_progress/);
  });
});

test("a settlement failure fails closed: the run stops and the lease is still released", async () => {
  const uid = freshUid();
  await inTenant(uid, async () => {
    const task = await dueTask(uid);
    const { calls, deps } = admission({
      settle: async () => {
        throw new Error("usage outbox unavailable");
      },
    });
    const script = scripted([{ tool: "kb_search" }, { text: "never" }]);
    const runner = tenantRunner(uid, script.provider, deps);
    await runner.tick();
    await runner.drain();
    assert.equal(script.calls(), 1, "no second model call on unsettled usage");
    assert.ok(calls.includes("release"));
    const run = (await listRuns((await getTask(task.id))!))[0]!;
    assert.equal(run.state, "failed");
    assert.equal(run.stopReason, "settlement_failed");
    assert.match(run.error!, /usage outbox unavailable/);
    const after = (await getTask(task.id))!;
    assert.equal(after.state, "paused", "a settlement failure is not retried");
    assert.match(after.pausedReason!, /usage outbox unavailable/);
  });
});

// ── sweep ──

test("the sweep runs each tenant's due tasks inside that tenant's home, one tenant at a time", async () => {
  const alice = freshUid();
  const bob = freshUid();
  const idle = freshUid(); // has an account, no tasks
  const ids: Record<string, string> = {};
  for (const uid of [alice, bob])
    await inTenant(uid, async () => void (ids[uid] = (await dueTask(uid, `for ${uid}`)).id));
  fs.mkdirSync(homeForUid(idle), { recursive: true });

  const scopes: Array<string | null> = [];
  const runners = new Map<string, TaskRunner>();
  let concurrent = 0;
  let maxConcurrent = 0;
  const report = await sweepUserTasks({
    accounts: async () => [{ uid: alice }, { uid: idle }, { uid: bob }],
    accountExists: async () => true,
    paused: () => false,
    now: () => NOW,
    runnerFor: (uid) => {
      scopes.push(scopedUid());
      const provider: Provider = {
        name: "fake",
        async runTurn() {
          maxConcurrent = Math.max(maxConcurrent, ++concurrent);
          await new Promise((r) => setTimeout(r, 15));
          concurrent--;
          return {
            content: [{ type: "text", text: `done for ${scopedUid()}` } as never],
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        },
      };
      const runner = tenantRunner(uid, provider, admission().deps);
      runners.set(uid, runner);
      return runner;
    },
  });

  assert.deepEqual(report, {
    scanned: 2,
    ran: 2,
    outcomes: [
      { uid: alice, started: 1 },
      { uid: bob, started: 1 },
    ],
  });
  assert.deepEqual(scopes, [alice, bob], "each runner was built inside its own tenant's scope");
  assert.equal(maxConcurrent, 1);
  for (const uid of [alice, bob]) {
    await inTenant(uid, async () => {
      const tasks = await listTasks();
      assert.deepEqual(
        tasks.map((t) => t.id),
        [ids[uid]],
        "a tenant sees only its own task",
      );
      assert.equal((await listRuns(tasks[0]!))[0]!.summary, `done for ${uid}`);
    });
  }
  assert.equal(fs.existsSync(path.join(homeForUid(idle), "tasks")), false);
});

test("the sweep's run budget is counted per run, not per tenant", async () => {
  const greedy = freshUid();
  const next = freshUid();
  await inTenant(greedy, async () => {
    for (const title of ["a", "b", "c", "d"]) await dueTask(greedy, title);
  });
  await inTenant(next, async () => void (await dueTask(next)));
  let modelCalls = 0;
  const report = await sweepUserTasks({
    accounts: async () => [{ uid: greedy }, { uid: next }],
    accountExists: async () => true,
    paused: () => false,
    now: () => NOW,
    maxRuns: 2,
    runnerFor: (uid) =>
      tenantRunner(
        uid,
        {
          name: "fake",
          async runTurn() {
            modelCalls++;
            return {
              content: [{ type: "text", text: "ok" } as never],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            };
          },
        },
        admission().deps,
      ),
  });
  assert.equal(report.ran, 2);
  assert.equal(
    modelCalls,
    2,
    "one tenant with four due tasks does not get four runs out of a budget of two",
  );
  assert.deepEqual(report.outcomes, [
    { uid: greedy, started: 2 },
    { uid: next, started: 0, skipped: "sweep_budget" },
  ]);
});

test("the sweep honours the service pause, the per-sweep budget, account deletion and a missing runner", async () => {
  const uids = [freshUid(), freshUid(), freshUid(), freshUid()];
  for (const uid of uids) await inTenant(uid, async () => void (await dueTask(uid)));
  const accounts = async () => uids.map((uid) => ({ uid }));
  const built: string[] = [];
  const runnerFor = (uid: string) => {
    built.push(uid);
    return tenantRunner(uid, scripted([{ text: "ok" }]).provider, admission().deps);
  };

  const paused = await sweepUserTasks({
    accounts,
    accountExists: async () => true,
    paused: () => true,
    runnerFor,
  });
  assert.deepEqual(paused.outcomes, [{ uid: uids[0], started: 0, skipped: "service_paused" }]);
  assert.equal(paused.ran, 0);
  assert.deepEqual(built, []);

  const report = await sweepUserTasks({
    accounts,
    paused: () => false,
    now: () => NOW,
    maxRuns: 1,
    accountExists: async (uid) => uid !== uids[1],
    beginAccountWork: (uid) => (uid === uids[0] ? null : () => {}),
    runnerFor: (uid) => (uid === uids[2] ? runnerFor(uid) : null),
  });
  assert.deepEqual(report.outcomes, [
    { uid: uids[0], started: 0, skipped: "account_deleting" },
    { uid: uids[1], started: 0, skipped: "account_deleted" },
    { uid: uids[2], started: 1 },
    { uid: uids[3], started: 0, skipped: "sweep_budget" },
  ]);
  assert.deepEqual(built, [uids[2]]);
});

// ── the web host's cloud gating ──

function host(over: { cloudEnabled: boolean; gate: boolean }) {
  return createTaskHost({
    cloud: true,
    profile: "cloud-chat",
    tools: [],
    model: "m",
    cwd: os.tmpdir(),
    broadcast: () => {},
    reachOut: async () => ({ id: "ro_1", deliver: false, channels: [], reason: "no-channel" }),
    withConversation: (fn) => fn({ history: [], append: async () => {} }),
    cloudEnabled: over.cloudEnabled,
    ...(over.gate
      ? { modelGateFor: (uid: string) => cloudModelGate(uid, { deps: admission().deps }) }
      : {}),
  });
}

test("hosted edition: no runner without the flag, none without admission, none outside the tenant's scope", async () => {
  const uid = freshUid();
  const off = host({ cloudEnabled: false, gate: true });
  const unmetered = host({ cloudEnabled: true, gate: false });
  const on = host({ cloudEnabled: true, gate: true });
  try {
    await inTenant(uid, async () => {
      assert.equal(off.runnerFor(uid), null, "LISA_CLOUD_TASKS off");
      assert.equal(unmetered.runnerFor(uid), null, "no admission wired ⇒ no cloud runs at all");
      const runner = on.runnerFor(uid);
      assert.ok(runner);
      assert.equal(on.runnerFor(uid), runner, "one runner per tenant, reused");
      assert.equal(
        on.runnerFor("someone-else"),
        null,
        "a runner is only handed out inside its own scope",
      );
    });
    assert.equal(on.runnerFor(uid), null, "…and not outside any scope");
    assert.equal(on.runnerFor(null), null);
  } finally {
    await Promise.all([off.stop(), unmetered.stop(), on.stop()]);
  }
});

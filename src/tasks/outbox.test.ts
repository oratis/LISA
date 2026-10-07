import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope } from "../paths.js";
import { drainOutbox, enqueueNotice, listOutbox, noticeId, OUTBOX_MAX_ATTEMPTS } from "./outbox.js";
import { tasksDir } from "./store.js";
import type { TaskNotice } from "./types.js";

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-outbox-"));
  try {
    return await homeScope.run(home, async () => {
      // A notice only ever exists for a task, so the tasks directory is there.
      await fsp.mkdir(tasksDir(), { recursive: true });
      return await fn();
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

function notice(
  runId = "r_0123456789abcdef",
  kind: TaskNotice["kind"] = "task_result",
): TaskNotice {
  return {
    id: noticeId(runId, kind),
    uid: null,
    taskId: "t_0123456789ab",
    runId,
    title: "Morning brief",
    summary: "Two things need you today.",
    status: "succeeded",
    priority: "normal",
    kind,
  };
}

test("enqueue is idempotent on the notice id", async () => {
  await withHome(async () => {
    const first = await enqueueNotice(notice(), 100);
    const again = await enqueueNotice({ ...notice(), summary: "a different body" }, 200);
    assert.equal(again.createdAt, first.createdAt);
    assert.equal(again.notice.summary, "Two things need you today.");
    assert.equal((await listOutbox()).length, 1);
    // A different kind for the same run is its own notice.
    await enqueueNotice(notice("r_0123456789abcdef", "task_failed"));
    assert.equal((await listOutbox()).length, 2);
  });
});

test("drain delivers each pending notice once", async () => {
  await withHome(async () => {
    await enqueueNotice(notice());
    const seen: string[] = [];
    const deliver = async (n: TaskNotice) => {
      seen.push(n.id);
      return { delivered: true };
    };
    assert.deepEqual(await drainOutbox(deliver), {
      delivered: 1,
      suppressed: 0,
      deferred: 0,
      failed: 0,
    });
    assert.deepEqual(await drainOutbox(deliver), {
      delivered: 0,
      suppressed: 0,
      deferred: 0,
      failed: 0,
    });
    assert.deepEqual(seen, [noticeId("r_0123456789abcdef", "task_result")]);
    assert.equal((await listOutbox())[0]!.state, "delivered");
    // Re-enqueueing a delivered notice (a resumed run finishing again) does not resurrect it.
    const again = await enqueueNotice(notice());
    assert.equal(again.state, "delivered");
    await drainOutbox(deliver);
    assert.equal(seen.length, 1);
  });
});

test("with no deliver wired, notices wait — and go out once one is", async () => {
  await withHome(async () => {
    await enqueueNotice(notice());
    assert.deepEqual(await drainOutbox(undefined), {
      delivered: 0,
      suppressed: 0,
      deferred: 1,
      failed: 0,
    });
    assert.equal((await listOutbox())[0]!.state, "pending");
    let calls = 0;
    await drainOutbox(async () => {
      calls++;
      return { delivered: true };
    });
    assert.equal(calls, 1);
  });
});

test("a crash after deliver() but before the mark redelivers with the SAME id", async () => {
  await withHome(async () => {
    await enqueueNotice(notice());
    // An idempotent consumer, like the default task-card deliver.
    const cards = new Set<string>();
    let calls = 0;
    const deliver = async (n: TaskNotice) => {
      calls++;
      cards.add(n.id);
      return { delivered: true };
    };
    await drainOutbox(deliver);
    // Simulate the crash: the entry is on disk as `delivering`, as it is while deliver() runs.
    const file = path.join(
      tasksDir(),
      "outbox",
      `${noticeId("r_0123456789abcdef", "task_result")}.json`,
    );
    const entry = JSON.parse(await fsp.readFile(file, "utf8"));
    await fsp.writeFile(file, JSON.stringify({ ...entry, state: "delivering" }));

    await drainOutbox(deliver); // the "restarted" process
    assert.equal(calls, 2, "at-least-once: the ambiguous entry is delivered again");
    assert.equal(cards.size, 1, "…under the same id, so the consumer dedupes it");
    assert.equal((await listOutbox())[0]!.state, "delivered");
  });
});

test("a throwing deliver is retried with backoff and eventually given up", async () => {
  await withHome(async () => {
    await enqueueNotice(notice(), 0);
    let now = 0;
    let calls = 0;
    const deliver = async () => {
      calls++;
      throw new Error("push bridge down");
    };
    assert.equal((await drainOutbox(deliver, now)).deferred, 1);
    // Still inside the backoff window: not attempted.
    assert.equal((await drainOutbox(deliver, now + 1000)).deferred, 1);
    assert.equal(calls, 1);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i++) {
      now += 31 * 60_000;
      await drainOutbox(deliver, now);
    }
    assert.equal(calls, OUTBOX_MAX_ATTEMPTS);
    const [entry] = await listOutbox();
    assert.equal(entry!.state, "failed");
    assert.match(entry!.reason!, /push bridge down/);
  });
});

test("delivered:false is final unless the reason says defer", async () => {
  await withHome(async () => {
    await enqueueNotice(notice("r_aaaaaaaaaaaaaaaa"));
    await enqueueNotice(notice("r_bbbbbbbbbbbbbbbb"));
    let quiet = true;
    const calls: string[] = [];
    const deliver = async (n: TaskNotice) => {
      calls.push(n.runId);
      if (n.runId === "r_aaaaaaaaaaaaaaaa") return { delivered: false, reason: "reach_out_off" };
      return quiet ? { delivered: false, reason: "defer:quiet_hours" } : { delivered: true };
    };
    assert.deepEqual(await drainOutbox(deliver), {
      delivered: 0,
      suppressed: 1,
      deferred: 1,
      failed: 0,
    });
    quiet = false;
    assert.deepEqual(await drainOutbox(deliver), {
      delivered: 1,
      suppressed: 0,
      deferred: 0,
      failed: 0,
    });
    // The suppressed one was asked exactly once; the deferred one twice.
    assert.deepEqual(calls.sort(), [
      "r_aaaaaaaaaaaaaaaa",
      "r_bbbbbbbbbbbbbbbb",
      "r_bbbbbbbbbbbbbbbb",
    ]);
    const states = Object.fromEntries((await listOutbox()).map((e) => [e.notice.runId, e.state]));
    assert.deepEqual(states, { r_aaaaaaaaaaaaaaaa: "suppressed", r_bbbbbbbbbbbbbbbb: "delivered" });
  });
});

test("two drains racing deliver a notice once between them", async () => {
  await withHome(async () => {
    await enqueueNotice(notice());
    let calls = 0;
    const deliver = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      return { delivered: true };
    };
    await Promise.all([drainOutbox(deliver), drainOutbox(deliver), drainOutbox(deliver)]);
    assert.equal(calls, 1);
  });
});

test("draining after the home was deleted re-creates nothing", async () => {
  await withHome(async () => {
    await enqueueNotice(notice("r_0000000000000001"), 1);
    await enqueueNotice(notice("r_0000000000000002"), 2);
    const home = path.dirname(tasksDir());
    // The account is deleted between the outbox listing and the first delivery.
    const realReadFile = fsp.readFile.bind(fsp);
    let reads = 0;
    (fsp as { readFile: unknown }).readFile = async (target: unknown, ...rest: unknown[]) => {
      const out = await (realReadFile as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
      if (String(target).endsWith(".json") && String(target).includes("outbox") && ++reads === 2) {
        await fsp.rm(home, { recursive: true, force: true });
      }
      return out;
    };
    try {
      await drainOutbox(async () => ({ delivered: true })).catch(() => null);
    } finally {
      (fsp as { readFile: unknown }).readFile = realReadFile;
    }
    await assert.rejects(fsp.stat(home), /ENOENT/, "no outbox directory brought the home back");
  });
});

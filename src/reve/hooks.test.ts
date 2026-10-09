/**
 * The real reflective entry points, driven by scripted fake providers (no
 * model API), each leave exactly one dream record of the right trigger.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, ProviderResult } from "../providers/types.js";

process.env.LISA_SOUL_GIT = "0";
process.env.LISA_KB_NO_GIT = "1";

const { reflectOnSession } = await import("../reflect.js");
const { runIdleOnce } = await import("../idle/runner.js");
const { runDesireReviewOnce } = await import("../heartbeat/runner.js");
const { beginDreamForKind, withDream } = await import("./record.js");
const { listDreams, readDream } = await import("./store.js");
const { requestReconsider } = await import("./reconsider.js");
const { setAutonomyEnabled } = await import("../autonomy/state.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");

let home: string;
const savedHome = process.env.LISA_HOME;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-hooks-"));
  process.env.LISA_HOME = home;
  setAutonomyEnabled(true);
  await soulStore.ensureSoulDirs();
  fs.writeFileSync(path.join(home, "soul", "identity.md"), "I am Lisa.\n");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** A provider that replies with `text` and records every prompt it was shown. */
function scripted(text: string, seen: string[] = [], sideEffect?: () => Promise<void>): Provider {
  return {
    name: "fake",
    async runTurn(req): Promise<ProviderResult> {
      seen.push(JSON.stringify(req.messages));
      if (sideEffect) await sideEffect();
      return { content: [{ type: "text", text }], stopReason: "end_turn", usage };
    },
  } as Provider;
}

const history = [
  { role: "user" as const, content: "I'm learning Rust this month." },
  { role: "assistant" as const, content: "Nice — want a study plan?" },
];

describe("reflective entry points produce dream records", () => {
  test("session reflection → trigger=reflect, run linked, reconsider injected once", async () => {
    // A soul-changing dream for the user to push back on.
    await withDream({ trigger: "idle" }, async () => {
      await soulStore.writeIdentity("I am Lisa, and I dislike Rust.");
    });
    const target = (await listDreams(1)).dreams[0]!.id;
    const req = await requestReconsider(target, "you said you dislike Rust — is that you?");

    const payload = JSON.stringify({
      summary: "We talked about Rust.",
      journal: "",
      operations: [{ kind: "memory_append", store: "user", entry: "learning Rust this month" }],
    });
    const seen: string[] = [];
    const r1 = await reflectOnSession({
      history,
      sessionId: "s1",
      model: "test",
      provider: scripted(payload, seen),
    });
    assert.ok(r1.applied.some((a) => a.startsWith("memory:user")));
    assert.ok(seen[0]!.includes("is that you?"), "the note reached the reflector prompt");
    assert.ok(seen[0]!.includes(req.id));

    const newest = await readDream((await listDreams(1)).dreams[0]!.id);
    assert.equal(newest.trigger, "reflect");
    assert.equal(newest.outcome, "done");
    assert.equal(newest.autonomyRunIds.length, 1);
    assert.deepEqual(newest.reconsiderDelivered, [req.id]);
    assert.ok(newest.changes.some((c) => c.path === "memory/USER.md"));

    // The next reflection does not see the note again.
    const seen2: string[] = [];
    await reflectOnSession({
      history,
      sessionId: "s2",
      model: "test",
      provider: scripted(payload, seen2),
    });
    assert.ok(!seen2[0]!.includes("is that you?"));
    assert.equal(
      fs.readFileSync(path.join(home, "soul", "identity.md"), "utf8"),
      "I am Lisa, and I dislike Rust.\n",
      "the reconsider request itself never edited her soul",
    );
  });

  test("idle (Reve) run → trigger=idle", async () => {
    const res = await runIdleOnce({
      tools: [],
      cwd: home,
      signal: new AbortController().signal,
      model: "test",
      idleMs: 60 * 60_000,
      provider: scripted("I tidied my memory.", [], async () => {
        // Stands in for a memory tool call made during the idle turn.
        await appendMemory("memory", "tidied during idle");
      }),
    });
    assert.equal(res.silent, false);
    const { dreams } = await listDreams(5);
    assert.equal(dreams.length, 1);
    const rec = await readDream(dreams[0]!.id);
    assert.equal(rec.trigger, "idle");
    assert.equal(rec.outcome, "done");
    assert.equal(rec.autonomyRunIds.length, 1);
    assert.equal(rec.metrics.memoryEntriesAdded, 1);
  });

  test("desire review → trigger=desire-review with the revised desire", async () => {
    await soulStore.writeDesire({
      slug: "fallback-review",
      what: "understand fallback-review",
      why: "curiosity",
      actionable: true,
      heartbeatPrompt: "read and reflect",
      bornAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      horizon: "spark",
      intensity: 1,
    });
    const result = await runDesireReviewOnce({
      tools: [],
      cwd: home,
      signal: new AbortController().signal,
      model: "test",
      now: new Date("2026-01-05T00:00:00.000Z"),
      provider: scripted("(no update)"),
    });
    assert.ok(result);
    const { dreams } = await listDreams(5);
    assert.equal(dreams.length, 1);
    const rec = await readDream(dreams[0]!.id);
    assert.equal(rec.trigger, "desire-review");
    assert.equal(rec.task, "builtin:desire_review");
    assert.deepEqual(rec.desires.revised, ["fallback-review"]);
    assert.equal(rec.autonomyRunIds.length, 1);
    assert.equal(rec.outcome, "no-update");
  });

  test("heartbeat: the examen is a dream, other task kinds are not", async () => {
    const examen = await beginDreamForKind("examen", "builtin:weekly_examen");
    assert.ok(examen.id);
    await examen.run(() => soulStore.appendJournal("2026-10-09", "weekly examen entry"));
    const rec = await examen.end({ outcome: "done" });
    assert.ok(rec);
    assert.equal(rec.trigger, "examen");
    assert.equal(rec.task, "builtin:weekly_examen");
    for (const kind of ["heartbeat", "desire"] as const) {
      const h = await beginDreamForKind(kind, "x");
      assert.equal(h.id, null);
      assert.equal(await h.end(), null);
    }
  });
});

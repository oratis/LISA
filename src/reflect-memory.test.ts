import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReflectionInterruptedError, reflectOnSession, parseReflectionPayload } from "./reflect.js";
import { readMemory, writeMemory, appendMemory } from "./memory/store.js";
import { evidenceFromHistory, recentMemoryEvidence } from "./memory/evidence.js";
import type { Provider, ProviderRunOpts } from "./providers/types.js";
import type { StoredMessage } from "./types.js";

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.LISA_HOME;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-reflect-memory-"));
  process.env.LISA_HOME = dir;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previous;
  await fs.rm(dir, { recursive: true, force: true });
});

const history: StoredMessage[] = [
  { role: "user", content: "We moved the API port from 3000 to 5757." },
  { role: "assistant", content: "I have updated the configuration." },
];
const source = evidenceFromHistory(history, "session1")[0]!;
function fakeProvider(answer: (opts: ProviderRunOpts) => unknown | Promise<unknown>): Provider {
  return {
    name: "offline",
    async runTurn(opts) {
      const payload = await answer(opts);
      return {
        content: [
          {
            type: "text",
            text: typeof payload === "string" ? payload : JSON.stringify(payload),
            citations: [],
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 4, cacheWriteTokens: 5 },
      };
    },
  };
}
function correction() {
  return {
    summary: "Updated the API port.",
    operations: [
      {
        kind: "memory_replace",
        store: "memory",
        old_string: "API port: 3000",
        new_string: "API port: 5757",
        reason: "User provided an explicit correction.",
        source_quotes: [{ id: source.id, quote: source.text }],
      },
    ],
  };
}

test("reflection sees current memory, corrects it from evidence and consumes identical input once", async () => {
  await writeMemory("memory", "- API port: 3000\n- Keep the backup schedule");
  let calls = 0;
  const provider = fakeProvider((opts) => {
    calls++;
    const prompt = JSON.stringify(opts.messages);
    assert.match(prompt, /API port: 3000/);
    assert.ok(prompt.includes(source.id));
    assert.ok(opts.signal);
    return correction();
  });
  const first = await reflectOnSession({ history, sessionId: "session1", provider });
  assert.equal(first.usage?.inputTokens, 120);
  assert.equal(first.usage?.cacheReadTokens, 4);
  assert.equal(first.skipped.length, 0);
  assert.match(await readMemory("memory"), /API port: 5757/);
  assert.match(await readMemory("memory"), /Keep the backup schedule/);
  const second = await reflectOnSession({ history, sessionId: "session1", provider });
  assert.equal(second.duplicate, true);
  assert.equal(second.usage, undefined);
  assert.equal(calls, 1);
});

for (const currentCitation of [true, false]) {
  test(`a reference to an earlier conversation requires a current citation (${currentCitation})`, async () => {
    const earlier = "In the pressroom swatch list, Twilight means violet ink.";
    const decision = "Use Twilight as my regular pressroom ink.";
    const history: StoredMessage[] = [
      { role: "user", content: decision },
      { role: "assistant", content: "Understood." },
    ];
    const logs = path.join(dir, "sessions");
    await fs.mkdir(logs);
    for (const [id, ts, message] of [
      ["sample", "2025-07-01T12:00:00Z", earlier],
      ["choice", "2025-07-02T12:00:00Z", decision],
    ] as const) {
      const header = { type: "session", version: 2, id, cwd: "/workspace", startedAt: ts };
      const utterance = { type: "message", ts, message: { role: "user", content: message } };
      await fs.writeFile(
        path.join(logs, id + ".jsonl"),
        [header, utterance].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }
    const [mapping] = await recentMemoryEvidence(["sample"]);
    const [choice] = evidenceFromHistory(history, "choice");
    const provider = fakeProvider((opts) => {
      assert.ok(JSON.stringify(opts.messages).includes(mapping!.id));
      const quotes = [{ id: mapping!.id, quote: earlier }];
      if (currentCitation) quotes.push({ id: choice!.id, quote: decision });
      return {
        summary: "Pressroom ink selection.",
        operations: [
          {
            kind: "memory_append",
            store: "user",
            entry: "Regular pressroom ink: violet.",
            reason: "Resolve the user's swatch selection.",
            source_quotes: quotes,
          },
        ],
      };
    });
    const result = await reflectOnSession({ sessionId: "choice", history, provider });
    if (currentCitation) {
      const { memoryRevisionHistory } = await import("./memory/review.js");
      const [rev] = await memoryRevisionHistory("user");
      assert.deepEqual(
        new Set(rev!.sources.map((s) => s.sessionId)),
        new Set(["sample", "choice"]),
      );
      assert.match(await readMemory("user"), /violet/);
    } else {
      assert.match(result.skipped.join(" "), /current session/);
      assert.equal(await readMemory("user"), "");
    }
  });
}

test("new evidence in the same session can be reflected", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls++;
    return { summary: "No durable changes.", operations: [] };
  });
  await reflectOnSession({ history, sessionId: "session1", provider });
  await reflectOnSession({
    history: [...history, { role: "user", content: "New fact: use port 8080 instead." }],
    sessionId: "session1",
    provider,
  });
  assert.equal(calls, 2);
});

test("reflection cannot overwrite memory edited while its model was running", async () => {
  await writeMemory("memory", "- API port: 3000");
  const result = await reflectOnSession({
    history,
    sessionId: "session1",
    provider: fakeProvider(async () => {
      await appendMemory("memory", "a concurrent chat entry");
      return correction();
    }),
  });
  assert.ok(result.skipped.some((s) => s.includes("changed since review")));
  assert.equal(await readMemory("memory"), "- API port: 3000\n- a concurrent chat entry\n");
});

test("unsubstantiated memory operations do not land", async () => {
  const result = await reflectOnSession({
    history,
    sessionId: "session1",
    provider: fakeProvider(() => ({
      summary: "An unsupported guess.",
      operations: [{ kind: "memory_append", entry: "The user likes purple" }],
    })),
  });
  assert.ok(result.skipped.some((s) => s.startsWith("memory:")));
  assert.equal(await readMemory("memory"), "");
});

test("malformed operations retry without crashing the operation loop; errors are not checkpointed", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls++;
    return { summary: "invalid", operations: [null] };
  });
  const first = await reflectOnSession({ history, sessionId: "session1", provider });
  assert.equal(first.malformed, true);
  assert.equal(first.usage?.inputTokens, 240);
  await reflectOnSession({ history, sessionId: "session1", provider });
  assert.equal(calls, 4);
  assert.equal(parseReflectionPayload('{"summary":"s","journal":{}}').ok, false);
});

test("aborted reflections and invalid session ids do not call the provider", async () => {
  const provider = fakeProvider(() => {
    throw new Error("must not be called");
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    reflectOnSession({ history, sessionId: "session1", provider, signal: controller.signal }),
    /reflection_cancelled/,
  );
  await assert.rejects(
    reflectOnSession({ history, sessionId: "../escape", provider }),
    /invalid session/,
  );
});

test("concurrent reflection of identical input runs the provider once", async () => {
  let calls = 0;
  const provider = fakeProvider(() => {
    calls++;
    return { summary: "No changes.", operations: [] };
  });
  const results = await Promise.all([
    reflectOnSession({ history, sessionId: "session1", provider }),
    reflectOnSession({ history, sessionId: "session1", provider }),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
});

test("explicit empty replacement removes cancelled memory with evidence and preserves other facts", async () => {
  await writeMemory("memory", "- API port: 3000\n- Keep the backup schedule");
  const provider = fakeProvider(() => {
    const payload = correction();
    payload.operations[0]!.old_string = "- API port: 3000\n";
    payload.operations[0]!.new_string = "";
    return payload;
  });
  const result = await reflectOnSession({ history, sessionId: "session1", provider });
  assert.deepEqual(result.skipped, []);
  assert.equal(await readMemory("memory"), "- Keep the backup schedule\n");
});

test("cancellation after the first durable write stops later soul operations and stays retryable", async (t) => {
  const { listDreams, readDream } = await import("./reve/store.js");
  const controller = new AbortController();
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    await rename(from, to);
    if (String(to).includes(`${path.sep}journal${path.sep}`)) controller.abort();
  });
  const provider = fakeProvider(() => ({
    summary: "Interrupted",
    journal: "One journal entry.",
    operations: [{ kind: "patch_identity", new_text: "must not land" }],
  }));
  await assert.rejects(
    reflectOnSession({ history, sessionId: "session1", provider, signal: controller.signal }),
    /reflection_cancelled/,
  );
  assert.equal(
    await fs.readFile(path.join(dir, "soul", "identity.md"), "utf8").catch(() => ""),
    "",
  );
  assert.deepEqual(
    await fs.readdir(path.join(dir, "reflections", "processed")).catch(() => []),
    [],
  );
  const dream = await readDream((await listDreams(1)).dreams[0]!.id);
  assert.equal(dream.outcome, "error");
  const { buildReveOverview } = await import("./web/reve-overview.js");
  const { stats } = await buildReveOverview();
  assert.equal(stats.runs, 1);
  assert.equal(stats.issues, 1);
  assert.deepEqual(stats.usage, {
    inputTokens: 120,
    outputTokens: 30,
    cacheReadTokens: 4,
    cacheWriteTokens: 5,
    incompleteCacheRuns: 0,
  });
});

test("a concurrent Forget cancels a reflection before stale source text can be written back", async () => {
  const { forget } = await import("./sovereignty/forget.js");
  await writeMemory("memory", "- API port: 3000");
  const provider = fakeProvider(async () => {
    await forget("3000");
    return { ...correction(), journal: "Restore the old port 3000." };
  });
  await assert.rejects(
    reflectOnSession({ history, sessionId: "session1", provider }),
    (err) =>
      err instanceof ReflectionInterruptedError &&
      err.code === "reflection_invalidated" &&
      err.usage.outputTokens === 30,
  );
  assert.doesNotMatch(await readMemory("memory"), /3000|5757/);
  assert.deepEqual(
    await fs.readdir(path.join(dir, "reflections", "processed")).catch(() => []),
    [],
  );
});

test("Forget redacts prior summaries returned by duplicate reflection", async () => {
  const { forget } = await import("./sovereignty/forget.js");
  const provider = fakeProvider(() => ({
    summary: "We talked about privatecode.",
    operations: [],
  }));
  await reflectOnSession({ history, sessionId: "session1", provider });
  const preview = await forget("privatecode", { dryRun: true });
  assert.ok(preview.locations.some((item) => item.location.includes("reflections/processed/")));
  await forget("privatecode", { digest: preview.digest });
  const repeated = await reflectOnSession({ history, sessionId: "session1", provider });
  assert.equal(repeated.duplicate, true);
  assert.doesNotMatch(repeated.summary, /privatecode/);
});

test("contended reflection has a safe busy response and a waiting caller can cancel without spending", async () => {
  const lockDir = path.join(dir, "reflections");
  await fs.mkdir(lockDir);
  await fs.writeFile(
    path.join(lockDir, "session1.lock"),
    JSON.stringify({ pid: process.pid, ts: Date.now() }),
  );
  let calls = 0;
  const provider = fakeProvider(() => {
    calls++;
    return correction();
  });
  const busy = reflectOnSession({ history, sessionId: "session1", provider });
  const cancelled = reflectOnSession({
    history,
    sessionId: "session1",
    provider,
    signal: AbortSignal.timeout(75),
  });
  const other = reflectOnSession({ history, sessionId: "session2", provider });
  const [busyResult, cancelledResult, otherResult] = await Promise.allSettled([
    busy,
    cancelled,
    other,
  ]);
  for (const [r, code] of [
    [busyResult, "reflection_busy"],
    [cancelledResult, "reflection_cancelled"],
  ] as const) {
    assert.equal(r.status, "rejected");
    assert.ok(r.reason instanceof ReflectionInterruptedError);
    assert.equal(r.reason.code, code);
    assert.equal(r.reason.usage.inputTokens, 0);
    assert.equal(r.reason.message, code);
  }
  assert.equal(otherResult.status, "fulfilled");
  assert.equal(calls, 1);
});

test("active privacy reset blocks review, restore, and reflection before any model call", async () => {
  const { withReviewReset, prepareMemoryReview, restoreMemoryRevision, consolidateMemory } =
    await import("./memory/review.js");
  const draft = await prepareMemoryReview("user", []);
  const applied = await consolidateMemory(draft.id, []);
  await withReviewReset(async () => {
    await assert.rejects(prepareMemoryReview("user", []), /reset in progress/);
    await assert.rejects(restoreMemoryRevision(applied.revisionId), /reset in progress/);
    await assert.rejects(consolidateMemory(draft.id, []), /reset in progress/);
    await assert.rejects(
      reflectOnSession({
        history,
        sessionId: "session1",
        provider: fakeProvider(() => {
          throw new Error("unexpected call");
        }),
      }),
      (err) =>
        err instanceof ReflectionInterruptedError &&
        err.code === "reflection_invalidated" &&
        err.usage.outputTokens === 0,
    );
  });
});

test("reflection rejects a cross-home processed directory without consuming tokens or following it", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "other-reflection-"));
  try {
    await fs.mkdir(path.join(dir, "reflections"));
    await fs.symlink(outside, path.join(dir, "reflections", "processed"));
    await assert.rejects(
      reflectOnSession({
        history,
        sessionId: "session1",
        provider: fakeProvider(() => {
          throw new Error("unexpected call");
        }),
      }),
      (err) =>
        err instanceof ReflectionInterruptedError &&
        err.code === "reflection_failed" &&
        err.usage.inputTokens === 0,
    );
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a failed completion checkpoint records each incurred token once and marks a single failed run", async (t) => {
  const { readAutonomyRuns } = await import("./autonomy/runs.js");
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (String(to).startsWith(path.join(dir, "reflections", "processed") + path.sep))
      throw new Error("checkpoint unavailable");
    await rename(from, to);
  });
  const provider = fakeProvider(() => ({ summary: "finished", operations: [] }));
  await assert.rejects(
    reflectOnSession({ history, sessionId: "session1", provider }),
    /reflection_failed/,
  );
  assert.deepEqual(
    (await readAutonomyRuns()).map((r) => [
      r.outcome,
      r.note,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWriteTokens,
    ]),
    [["error", "reflection_failed", 120, 30, 4, 5]],
  );
});

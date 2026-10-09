import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_KB_NO_GIT = "1";
process.env.LISA_SECRETS_BACKEND = "file";

const { withDream, beginDream } = await import("./record.js");
const { readDream, listDreams, CorruptDreamError, readDreamSidecar } = await import("./store.js");
const { DREAM_TRIGGERS } = await import("./types.js");
const { recordAutonomyRun, readAutonomyRuns } = await import("../autonomy/runs.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");
const { initSoulRepo, withSoulCaller, _resetGitAvailableCache } = await import("../soul/git.js");
const { EMOTION_EVENTS_MAX } = await import("../soul/types.js");
const { revertDream } = await import("./revert.js");
const { MAX_SNAPSHOT_FILES } = await import("./snapshot.js");

let home: string;
const saved = { home: process.env.LISA_HOME, git: process.env.LISA_SOUL_GIT };

function seedHome(): void {
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.writeFileSync(path.join(home, "memory", "MEMORY.md"), "- user prefers tea\n");
  fs.mkdirSync(path.join(home, "soul", "desires"), { recursive: true });
  fs.writeFileSync(path.join(home, "soul", "identity.md"), "I am Lisa.\n");
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-record-"));
  process.env.LISA_HOME = home;
  process.env.LISA_SOUL_GIT = "0";
  await _resetGitAvailableCache();
  seedHome();
});

afterEach(async () => {
  if (saved.home === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = saved.home;
  if (saved.git === undefined) delete process.env.LISA_SOUL_GIT;
  else process.env.LISA_SOUL_GIT = saved.git;
  delete process.env.LISA_REVE_DREAMS;
  await _resetGitAvailableCache();
  fs.rmSync(home, { recursive: true, force: true });
});

async function onlyDream() {
  const { dreams } = await listDreams(10);
  assert.equal(dreams.length, 1, "exactly one dream recorded");
  return await readDream(dreams[0]!.id);
}

describe("dream capture (snapshot path, soul git off)", () => {
  for (const trigger of DREAM_TRIGGERS) {
    test(`records memory, soul, desire and emotion changes for trigger=${trigger}`, async () => {
      fs.rmSync(path.join(home, "reve"), { recursive: true, force: true });
      await withDream({ trigger }, async () => {
        await appendMemory("memory", "user is learning Rust");
        await soulStore.writeOpinion({
          slug: "tabs-vs-spaces",
          stance: "spaces, mostly",
          confidence: 0.6,
          evidence: [],
          bornAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        });
        await soulStore.writeDesire({
          slug: "learn-rust",
          what: "learn rust with the user",
          why: "they are",
          actionable: false,
          bornAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
        });
        await soulStore.applyEmotionDelta({
          emotion: "curiosity",
          delta: 0.3,
          trigger: "a new language",
          maxEvents: EMOTION_EVENTS_MAX,
        });
        await recordAutonomyRun({
          kind: trigger === "desire-review" ? "desire-review" : trigger,
          startedAt: new Date().toISOString(),
          durationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          outcome: "done",
        });
      });
      const rec = await onlyDream();
      assert.equal(rec.trigger, trigger);
      assert.equal(rec.capture, "snapshot");
      assert.equal(rec.outcome, "done");
      assert.equal(rec.autonomyRunIds.length, 1);
      const runs = await readAutonomyRuns();
      assert.equal(runs.at(-1)!.dreamId, rec.id, "the run is linked back to the dream");
      assert.equal(runs.at(-1)!.id, rec.autonomyRunIds[0]);

      const mem = rec.changes.find((c) => c.path === "memory/MEMORY.md")!;
      assert.equal(mem.part, "memory");
      assert.equal(mem.status, "modified");
      assert.deepEqual(mem.entriesAdded, ["user is learning Rust"]);
      assert.deepEqual(mem.entriesRemoved, []);
      assert.equal(mem.revertible, true);

      const op = rec.changes.find((c) => c.path === "soul/opinions/tabs-vs-spaces.md")!;
      assert.equal(op.part, "soul");
      assert.equal(op.status, "added");
      assert.equal(op.revertible, false, "soul changes are never user-revertible");

      assert.deepEqual(rec.desires, { added: ["learn-rust"], revised: [], closed: [] });
      assert.ok(rec.emotions && rec.emotions.delta.curiosity! > 0);
      assert.equal(rec.metrics.desireChurn, 1);
      assert.ok(rec.metrics.opinionsChurn > 0);
      assert.equal(rec.metrics.memoryEntriesAdded, 1);
      assert.ok(rec.metrics.emotionVolatility > 0);
      assert.match(rec.summary, /memory \+1\/-0 entries/);

      // Revert sidecar: memory keeps only the pass's entry delta (never the
      // whole pre-pass file), and never soul content.
      const side = await readDreamSidecar(rec.id);
      assert.deepEqual(side!.memory!["memory/MEMORY.md"], {
        added: ["- user is learning Rust"],
        removed: [],
      });
      assert.equal(side!.files["memory/MEMORY.md"], undefined);
      assert.ok(!JSON.stringify(side).includes("user prefers tea"));
      assert.ok(!Object.keys(side!.files).some((p) => p.startsWith("soul/")));
      assert.ok(fs.existsSync(path.join(home, "reve", "dreams", `${rec.id}.md`)));
    });
  }

  test("a pass that changes nothing writes no record", async () => {
    await withDream({ trigger: "idle" }, async () => undefined);
    const { dreams } = await listDreams();
    assert.equal(dreams.length, 0);
  });

  test("a failing pass still records what it changed, with outcome=error, and rethrows", async () => {
    await assert.rejects(
      withDream({ trigger: "idle" }, async () => {
        await appendMemory("user", "half-written thought");
        throw new Error("model fell over");
      }),
      /model fell over/,
    );
    const rec = await onlyDream();
    assert.equal(rec.outcome, "error");
    assert.ok(rec.changes.some((c) => c.path === "memory/USER.md" && c.status === "added"));
  });

  test("LISA_REVE_DREAMS=0 disables capture entirely", async () => {
    process.env.LISA_REVE_DREAMS = "0";
    await withDream({ trigger: "reflect" }, async () => {
      await appendMemory("memory", "x");
    });
    assert.equal(fs.existsSync(path.join(home, "reve")), false);
  });

  test("reflection never snapshots the KB (it cannot write it)", async () => {
    fs.mkdirSync(path.join(home, "kb", "wiki"), { recursive: true });
    await withDream({ trigger: "reflect" }, async () => {
      fs.writeFileSync(path.join(home, "kb", "wiki", "x.md"), "# x\n");
      await appendMemory("memory", "y");
    });
    const rec = await onlyDream();
    assert.ok(!rec.changes.some((c) => c.part === "kb"));
  });

  test("idle tracks KB pages but not the generated index", async () => {
    fs.mkdirSync(path.join(home, "kb", "wiki"), { recursive: true });
    await withDream({ trigger: "idle" }, async () => {
      fs.writeFileSync(path.join(home, "kb", "wiki", "rust.md"), "# Rust\n");
      fs.writeFileSync(path.join(home, "kb", "index.md"), "toc\n");
    });
    const rec = await onlyDream();
    assert.deepEqual(
      rec.changes.map((c) => c.path),
      ["kb/wiki/rust.md"],
    );
    assert.equal(rec.metrics.kbFilesChanged, 1);
  });
});

describe("dream capture (soul git on)", () => {
  beforeEach(async () => {
    process.env.LISA_SOUL_GIT = "1";
    await _resetGitAvailableCache();
    await initSoulRepo();
  });

  test("records soul commits with caller labels and the dream stamp", async () => {
    await withSoulCaller("reflect", () =>
      withDream({ trigger: "reflect" }, async () => {
        await soulStore.writeIdentity("I am Lisa, and I like quiet mornings.");
      }),
    );
    const rec = await onlyDream();
    assert.equal(rec.capture, "git");
    assert.ok(rec.soulHeadBefore && rec.soulHeadAfter && rec.soulHeadBefore !== rec.soulHeadAfter);
    assert.equal(rec.soulCommits.length, 1);
    const c = rec.soulCommits[0]!;
    assert.equal(c.caller, "reflect");
    assert.equal(c.opKind, "patch");
    assert.equal(c.dreamId, rec.id);
    assert.ok(c.subject.includes(`[dream:${rec.id}]`));
    assert.deepEqual(
      c.files.map((f) => f.path),
      ["identity.md"],
    );
    assert.match(c.diff, /\+I am Lisa, and I like quiet mornings\./);
    assert.equal(rec.metrics.identityPatches, 1);
  });

  test("cloud edition: soul git defaults off, the snapshot path still captures the soul diff", async () => {
    // A repo exists, but the cloud edition (GCS FUSE) never runs git by default.
    delete process.env.LISA_SOUL_GIT;
    process.env.LISA_EDITION = "cloud";
    await _resetGitAvailableCache();
    try {
      await withDream({ trigger: "idle" }, async () => {
        await soulStore.writeIdentity("I am Lisa, in the cloud.");
      });
      const rec = await onlyDream();
      assert.equal(rec.capture, "snapshot");
      assert.equal(rec.soulCommits.length, 0);
      const id = rec.changes.find((ch) => ch.path === "soul/identity.md")!;
      assert.match(id.diff, /\+ I am Lisa, in the cloud\./);
      assert.match(id.diff, /- I am Lisa\./);
      assert.equal(id.revertible, false);
      assert.equal(rec.metrics.identityPatches, 1);
    } finally {
      delete process.env.LISA_EDITION;
    }
  });

  test("a concurrent dream's stamped commits are not attributed to this one", async () => {
    const a = await beginDream({ trigger: "idle" });
    const b = await beginDream({ trigger: "reflect" });
    await b.run(() => withSoulCaller("reflect", () => soulStore.writePurpose("help, gently")));
    await a.run(() =>
      withSoulCaller("soul_patch", () => soulStore.writeIdentity("I am Lisa (a).")),
    );
    const recB = await b.end();
    const recA = await a.end();
    assert.ok(recA && recB);
    assert.deepEqual(
      recA.soulCommits.map((c) => c.files[0]!.path),
      ["identity.md"],
    );
    assert.equal(recA.soulCommits[0]!.caller, "soul_patch");
    assert.deepEqual(
      recB.soulCommits.map((c) => c.files[0]!.path),
      ["purpose.md"],
    );
  });
});

describe("snapshot caps never invent changes (#423 F5)", () => {
  test("a part past the file cap is left out whole and named; revert never deletes an untouched page", async () => {
    const wiki = path.join(home, "kb", "wiki");
    fs.mkdirSync(wiki, { recursive: true });
    const n = MAX_SNAPSHOT_FILES + 1;
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(wiki, `p${String(i).padStart(5, "0")}.md`), `# page ${i}\n`);
    }
    const last = path.join(wiki, `p${String(n - 1).padStart(5, "0")}.md`);
    await withDream({ trigger: "idle" }, async () => {
      fs.rmSync(path.join(wiki, "p00000.md")); // Lisa prunes one stale page
      await appendMemory("memory", "pruned a stale page");
    });
    const rec = await onlyDream();
    assert.ok(!rec.changes.some((c) => c.part === "kb"), "no KB change is claimed");
    assert.deepEqual(rec.uncaptured, [{ part: "kb", reason: "too_many_files", files: n }]);
    assert.equal(rec.capped, true);
    assert.match(rec.summary, /not captured: kb \(5001 files\)/);
    // The parts that fit are still captured.
    assert.ok(rec.changes.some((c) => c.path === "memory/MEMORY.md"));

    const res = await revertDream(rec.id, { parts: ["kb"] });
    assert.deepEqual(res.reverted, []);
    assert.ok(fs.existsSync(last), "a page the dream never touched is never deleted");
  });

  test("a pass that ran while a part was left out is recorded, never shown as 'no changes'", async () => {
    const wiki = path.join(home, "kb", "wiki");
    fs.mkdirSync(wiki, { recursive: true });
    for (let i = 0; i <= MAX_SNAPSHOT_FILES; i++)
      fs.writeFileSync(path.join(wiki, `p${i}.md`), "x\n");
    await withDream({ trigger: "idle" }, async () => {
      fs.writeFileSync(path.join(wiki, "p1.md"), "rewritten\n");
      await recordAutonomyRun({
        kind: "idle",
        startedAt: new Date().toISOString(),
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        outcome: "no-update",
      });
    });
    const rec = await onlyDream();
    assert.deepEqual(rec.changes, []);
    assert.equal(rec.uncaptured![0]!.part, "kb");
  });

  test(
    "a file that could not be read before the pass is never 'added' and never revertible",
    { skip: process.getuid?.() === 0 ? "root can read a 000 file" : false },
    async () => {
      const notes = path.join(home, "memory", "notes.md");
      fs.writeFileSync(notes, "- the user's own notes\n");
      fs.chmodSync(notes, 0o000);
      try {
        await withDream({ trigger: "idle" }, async () => {
          fs.chmodSync(notes, 0o644);
          fs.appendFileSync(notes, "- Lisa added this\n");
        });
      } finally {
        fs.chmodSync(notes, 0o644);
      }
      const rec = await onlyDream();
      const c = rec.changes.find((x) => x.path === "memory/notes.md")!;
      assert.equal(c.status, "modified", "it existed before the pass");
      assert.equal(c.revertible, false);
      assert.match(c.notRevertibleReason!, /before could not be read/);
      assert.equal(rec.capped, true);
      await assert.rejects(revertDream(rec.id, { parts: ["memory"] }));
      assert.ok(fs.existsSync(notes), "revert never deletes it");
    },
  );
});

describe("capture failures on the cloud edition (#423 F7)", () => {
  test("a capture-failure log line redacts the tenant's uid in users/<uid>/ paths", async () => {
    const { homeScope, homeForUid } = await import("../paths.js");
    const uid = "uid-abcdef1234567890";
    const tenant = homeForUid(uid);
    fs.mkdirSync(path.join(tenant, "memory"), { recursive: true });
    fs.writeFileSync(path.join(tenant, "reve"), "not a directory"); // the record write fails
    const lines: string[] = [];
    const origError = console.error;
    const origWrite = process.stderr.write.bind(process.stderr);
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    process.stderr.write = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      await homeScope.run(tenant, () =>
        withDream({ trigger: "idle" }, async () => {
          await appendMemory("memory", "tenant memory");
        }),
      );
    } finally {
      console.error = origError;
      process.stderr.write = origWrite;
    }
    const warn = lines.find((l) => l.includes("[reve] dream capture failed"));
    assert.ok(warn, "the failure is logged");
    assert.ok(!warn.includes(uid), `uid redacted: ${warn}`);
    assert.match(warn, /users\/uid-…7890/);
  });
});

describe("dream storage robustness", () => {
  test("corrupt records are skipped in listings and reported, and reading one throws", async () => {
    await withDream({ trigger: "idle" }, async () => {
      await appendMemory("memory", "ok");
    });
    const bad = "d-20261001T000000000-deadbeef";
    fs.writeFileSync(path.join(home, "reve", "dreams", `${bad}.json`), "{not json");
    const listing = await listDreams();
    assert.equal(listing.dreams.length, 1);
    assert.deepEqual(listing.corrupt, [bad]);
    await assert.rejects(readDream(bad), CorruptDreamError);
    // A structurally wrong record (valid JSON) is corrupt too.
    const wrong = "d-20261001T000001000-deadbeef";
    fs.writeFileSync(
      path.join(home, "reve", "dreams", `${wrong}.json`),
      JSON.stringify({ version: 1, id: wrong, trigger: "idle" }),
    );
    await assert.rejects(readDream(wrong), CorruptDreamError);
  });
});

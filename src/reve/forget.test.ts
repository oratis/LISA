import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_KB_NO_GIT = "1";
process.env.LISA_SOUL_GIT = "0";

const { withDream } = await import("./record.js");
const { listDreams, readDream, readDreamSidecar } = await import("./store.js");
const { revertDream, RevertConflictError } = await import("./revert.js");
const { requestReconsider, listReconsiderRequests } = await import("./reconsider.js");
const { forgetInReve, REVE_FORGOTTEN, SIDECAR_FORGOTTEN_REASON } = await import("./forget.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");

let home: string;
const savedHome = process.env.LISA_HOME;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), text);
};
const read = (rel: string) => fs.readFileSync(path.join(home, rel), "utf8");

/** Every file under reve/ that still holds `needle`. */
function reveHits(needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p, "utf8").includes(needle)) hits.push(path.relative(home, p));
    }
  };
  walk(path.join(home, "reve"));
  return hits.sort();
}

const DRQ = (s: string) => /\bDr\. Q\b/.test(s);
const KEY = (s: string) => s.includes("sk-live-ABCDEF");

let dreamId: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-forget-"));
  process.env.LISA_HOME = home;
  write("memory/MEMORY.md", "- user's therapist is Dr. Q\n- user likes tea\n");
  write("kb/wiki/care.md", "# Care\n\nSees Dr. Q every week.\n");
  write("soul/identity.md", "I am Lisa.\n");
  await withDream({ trigger: "idle" }, async () => {
    await appendMemory("memory", "user's API key is sk-live-ABCDEF1234567890");
    write("kb/wiki/care.md", "# Care\n\nSees a therapist every week.\n");
    await soulStore.writeIdentity("I am Lisa, and I keep a care page.");
  });
  dreamId = (await listDreams(1)).dreams[0]!.id;
  await requestReconsider(dreamId, "the care page should still say Dr. Q, not 'a therapist'");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("forgetInReve (#423 F4)", () => {
  test("blanks the topic in records, summaries and notes, and deletes sidecars that hold it", async () => {
    assert.ok(reveHits("Dr. Q").length >= 2, "before: the record, the KB sidecar and the note");
    const res = await forgetInReve(DRQ, { apply: true });
    assert.deepEqual(reveHits("Dr. Q"), [], "nothing under reve/ still holds it");
    assert.deepEqual(res.counts, {
      records: 1,
      summaries: 0,
      sidecars: 1,
      reconsider: 1,
      audit: 0,
    });
    assert.equal(res.total, 3);
    assert.equal(res.apply, true);

    const rec = await readDream(dreamId);
    const care = rec.changes.find((c) => c.path === "kb/wiki/care.md")!;
    assert.match(care.diff, new RegExp(`^- ${REVE_FORGOTTEN.replace(/[[\]]/g, "\\$&")}$`, "m"));
    assert.match(care.diff, /\+ Sees a therapist every week\./, "non-matching lines stay");
    for (const c of rec.changes.filter((x) => x.part !== "soul")) {
      assert.equal(c.revertible, false);
      assert.equal(c.notRevertibleReason, SIDECAR_FORGOTTEN_REASON);
    }
    assert.equal(await readDreamSidecar(dreamId), null);
    const [note] = await listReconsiderRequests(dreamId);
    assert.equal(note!.note, REVE_FORGOTTEN);

    // A forced revert after forget cannot bring the page's old text back.
    await assert.rejects(revertDream(dreamId, { parts: ["kb"] }), RevertConflictError);
    const forced = await revertDream(dreamId, { parts: ["kb"], force: true });
    assert.deepEqual(forced.reverted, []);
    assert.deepEqual(forced.skipped, ["kb/wiki/care.md"]);
    assert.equal(read("kb/wiki/care.md"), "# Care\n\nSees a therapist every week.\n");

    // Idempotent: a second pass finds nothing.
    assert.equal((await forgetInReve(DRQ, { apply: true })).total, 0);
    // The audit says forget ran, with counts and nothing else.
    const last = JSON.parse(read("reve/audit.jsonl").trim().split("\n").at(-1)!);
    assert.equal(last.action, "forget");
    assert.deepEqual(Object.keys(last).sort(), ["action", "at", "counts"]);
  });

  test("a secret the dream added is blanked from the diff and the entry list", async () => {
    assert.ok(reveHits("sk-live-ABCDEF").length > 0);
    const res = await forgetInReve(KEY, { apply: true });
    assert.deepEqual(reveHits("sk-live-ABCDEF"), []);
    assert.equal(res.counts.sidecars, 1, "the memory delta held the key");
    const mem = (await readDream(dreamId)).changes.find((c) => c.path === "memory/MEMORY.md")!;
    assert.deepEqual(mem.entriesAdded, [REVE_FORGOTTEN]);
    assert.equal(mem.revertible, false);
  });

  test("a dry run lists the same items and writes nothing; apply can be limited to them", async () => {
    const before = fs
      .readdirSync(path.join(home, "reve", "dreams"))
      .map((f) => read(`reve/dreams/${f}`));
    const dry = await forgetInReve(DRQ, { apply: false });
    assert.equal(dry.apply, false);
    assert.equal(dry.total, 3);
    assert.deepEqual(
      fs.readdirSync(path.join(home, "reve", "dreams")).map((f) => read(`reve/dreams/${f}`)),
      before,
      "nothing written",
    );
    // Apply only the reconsider note the preview listed.
    const note = dry.items.find((i) => i.kind === "reconsider")!;
    assert.match(note.location, /^reve\/reconsider\.json#rc-/);
    const res = await forgetInReve(DRQ, { apply: true, only: new Set([note.id]) });
    assert.deepEqual(
      res.items.map((i) => i.id),
      [note.id],
    );
    assert.deepEqual(reveHits("Dr. Q").sort(), [
      `reve/dreams/${dreamId}.before.json`,
      `reve/dreams/${dreamId}.json`,
    ]);
  });

  test("audit lines: matching values are blanked, structure kept", async () => {
    fs.appendFileSync(
      path.join(home, "reve", "audit.jsonl"),
      JSON.stringify({
        at: "2026-10-01T00:00:00.000Z",
        action: "revert",
        dreamId,
        files: ["about Dr. Q"],
      }) + "\nnot json about Dr. Q\n",
    );
    const res = await forgetInReve(DRQ, { apply: true });
    assert.equal(res.counts.audit, 2);
    const lines = read("reve/audit.jsonl")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const revert = lines.find((l) => l.action === "revert")!;
    assert.deepEqual(revert.files, [REVE_FORGOTTEN]);
    assert.equal(revert.dreamId, dreamId);
    assert.ok(lines.some((l) => l.action === "forgotten"));
  });

  test("applying only the sidecar deletion leaves the record's text alone", async () => {
    const dry = await forgetInReve(DRQ, { apply: false });
    const side = dry.items.find((i) => i.kind === "sidecars")!;
    await forgetInReve(DRQ, { apply: true, only: new Set([side.id]) });
    const rec = await readDream(dreamId);
    assert.match(rec.changes.find((c) => c.path === "kb/wiki/care.md")!.diff, /Dr\. Q/);
    assert.equal(rec.changes.find((c) => c.path === "kb/wiki/care.md")!.revertible, false);
    assert.equal(await readDreamSidecar(dreamId), null);
  });

  test("paths and names are structure: reported as untouched, never renamed", async () => {
    const res = await forgetInReve((s) => s.includes("care.md"), { apply: true });
    assert.ok(res.untouched.includes(`reve/dreams/${dreamId}.json`));
    assert.ok((await readDream(dreamId)).changes.some((c) => c.path === "kb/wiki/care.md"));
  });
});

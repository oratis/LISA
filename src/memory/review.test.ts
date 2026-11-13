import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { homeScope, memoryDir, sessionsDir } from "../paths.js";
import {
  readMemory,
  writeMemory,
  appendMemory,
  replaceInMemory,
  removeFromMemory,
  memoryForPrompt,
  MEMORY_MAX_BYTES,
} from "./store.js";
import { evidenceFromHistory, recentMemoryEvidence, EVIDENCE_CHAR_BUDGET } from "./evidence.js";
import {
  createMemoryReview,
  applyMemoryReview,
  prepareMemoryReview,
  consolidateMemory,
  memoryRevisionHistory,
  restoreMemoryRevision,
  proposedMemory,
  type MemoryChange,
} from "./review.js";
import { memoryTool } from "./tool.js";
import { kbGraphFile } from "../kb/paths.js";
import { clearKbTitleCache } from "../kb/memory-links.js";

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.LISA_HOME;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-memory-review-"));
  process.env.LISA_HOME = dir;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previous;
  await fs.rm(dir, { recursive: true, force: true });
});

const evidence = evidenceFromHistory(
  [
    { role: "user", content: "以后使用中文回复，之前说英文的偏好已经不适用了。" },
    { role: "assistant", content: "The user's favourite colour is purple, I assume." },
  ],
  "s1",
);
const change = (): MemoryChange => ({
  kind: "replace",
  old_text: "- Reply in English",
  new_text: "- Reply in Chinese",
  reason: "The user explicitly corrected their earlier preference.",
  evidence: [{ id: evidence[0]!.id, quote: "以后使用中文回复，之前说英文的偏好已经不适用了。" }],
});

test("concurrent ordinary appends preserve every entry and deduplicate retries", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => appendMemory("memory", `fact ${i}`)));
  await Promise.all([appendMemory("memory", "fact 2"), appendMemory("memory", "fact 2")]);
  const lines = (await readMemory("memory")).trim().split("\n");
  assert.equal(lines.length, 12);
  for (let i = 0; i < 12; i++) assert.ok(lines.includes(`- fact ${i}`));
});

test("empty edits are rejected and replacement dollars remain literal", async () => {
  await writeMemory("memory", "- old");
  await replaceInMemory("memory", "old", "$& $$ $` $'");
  assert.equal(await readMemory("memory"), "- $& $$ $` $'\n");
  await assert.rejects(replaceInMemory("memory", "", "bad"), /empty/);
  await assert.rejects(removeFromMemory("memory", ""), /empty/);
  await assert.rejects(writeMemory("bogus" as never, "bad"), /invalid/);
});

test("source-grounded correction has a private snapshot and a reversible history", async () => {
  await writeMemory("user", "- Reply in English\n- Keep this unrelated fact");
  const review = await createMemoryReview("user", evidence);
  const result = await applyMemoryReview(review, [change()]);
  assert.equal(result.changed, true);
  assert.equal(await readMemory("user"), "- Reply in Chinese\n- Keep this unrelated fact\n");
  const [revision] = await memoryRevisionHistory("user");
  assert.equal(revision?.before, review.before);
  assert.equal(revision?.sources[0]?.sessionId, "s1");
  assert.equal(revision?.status, "applied");
  const stat = await fs.stat(path.join(memoryDir(), "revisions", `${result.revisionId}.json`));
  assert.equal(stat.mode & 0o777, 0o600);
  await restoreMemoryRevision(result.revisionId);
  assert.equal(await readMemory("user"), review.before);
});

test("undo restores the exact empty or hand-edited memory bytes", async () => {
  await fs.mkdir(memoryDir(), { recursive: true });
  const file = path.join(memoryDir(), "USER.md");
  for (const before of ["", "- Legacy entry  ", "- Old entry\r\n\r\n"]) {
    await fs.writeFile(file, before);
    const review = await createMemoryReview("user", evidence);
    const result = await applyMemoryReview(review, [
      { ...change(), kind: "append", new_text: "- Reply in Chinese" },
    ]);
    const changed = await readMemory("user");
    const undo = await restoreMemoryRevision(result.revisionId);
    assert.equal(await fs.readFile(file, "utf8"), before);
    await restoreMemoryRevision(undo.revisionId);
    assert.equal(await readMemory("user"), changed);
  }
});

test("a stale proposal and a conflicting undo preserve later writes", async () => {
  await writeMemory("user", "- Reply in English");
  const stale = await createMemoryReview("user", evidence);
  await appendMemory("user", "a concurrent fact");
  await assert.rejects(applyMemoryReview(stale, [change()]), /changed since review/);
  const fresh = await createMemoryReview("user", evidence);
  const result = await applyMemoryReview(fresh, [change()]);
  await appendMemory("user", "another concurrent fact");
  await assert.rejects(restoreMemoryRevision(result.revisionId), /changed since review/);
  assert.match(await readMemory("user"), /another concurrent fact/);
});

test("same proposal is idempotent even after a later edit", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  await applyMemoryReview(review, [change()]);
  await appendMemory("user", "later fact");
  const repeated = await applyMemoryReview(review, [change()]);
  assert.equal(repeated.alreadyApplied, true);
  assert.match(await readMemory("user"), /later fact/);
  await assert.rejects(
    applyMemoryReview(review, [{ ...change(), new_text: "different" }]),
    /different proposal/,
  );
});

test("bad evidence, unsupported guesses and ambiguous edits fail before any write", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  for (const bad of [
    { ...change(), evidence: [{ id: "made-up", quote: "made-up evidence" }] },
    { ...change(), evidence: [{ id: evidence[0]!.id, quote: "a quote that was never said" }] },
    { ...change(), evidence: [{ id: evidence[1]!.id, quote: evidence[1]!.text }] },
    { ...change(), old_text: "" },
  ])
    await assert.rejects(applyMemoryReview(review, [bad]));
  await assert.rejects(applyMemoryReview(review, [change(), { ...change(), old_text: "missing" }]));
  assert.equal(await readMemory("user"), review.before);
  assert.deepEqual(await memoryRevisionHistory("user"), []);
});

test("oversized proposals fail atomically, empty proposals are valid", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  await assert.rejects(
    applyMemoryReview(review, [{ ...change(), new_text: "中".repeat(1000) }]),
    /exceeds/,
  );
  const result = await applyMemoryReview(review, []);
  assert.equal(result.changed, false);
  assert.equal(await readMemory("user"), review.before);
});

test("write-ahead audit failure leaves memory intact", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  await fs.writeFile(path.join(memoryDir(), "revisions"), "not a directory");
  await assert.rejects(applyMemoryReview(review, [change()]));
  assert.equal(await readMemory("user"), review.before);
});

test("prepared revision recovery does not replay the write", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  const result = await applyMemoryReview(review, [change()]);
  const file = path.join(memoryDir(), "revisions", `${result.revisionId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  record.status = "prepared";
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await applyMemoryReview(review, [change()])).alreadyApplied, true);
  assert.equal((await memoryRevisionHistory("user"))[0]?.status, "applied");
});

test("tenant-scoped reviews cannot read or update a different home", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await prepareMemoryReview("user", []);
  await homeScope.run(path.join(dir, "tenant-b"), async () => {
    assert.equal(await readMemory("user"), "");
    await assert.rejects(consolidateMemory(review.id, []), /ENOENT/);
    await appendMemory("user", "tenant B only");
  });
  assert.equal(await readMemory("user"), "- Reply in English\n");
});

test("review tool uses bounded raw sessions, skips prompts and preserves tool roles", async () => {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir(), "s1.jsonl"),
    [
      { type: "session", id: "s1" },
      { type: "prompt", text: "Never promote this system memory as source evidence" },
      { type: "reflection", summary: "A derived claim is not original evidence" },
      { type: "connector_trace", message: { role: "user", content: "not human" } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[architecture] You raised the following objection(s) during this turn but did not address them in your reply. The user wants daily alerts",
            },
          ],
        },
      },
      {
        type: "message",
        ts: "2026-11-07T00:00:00Z",
        message: { role: "user", content: evidence[0]!.text },
      },
      {
        type: "message",
        ts: "2026-11-07T00:01:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "All checks passed successfully." },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n{torn",
  );
  const sources = await recentMemoryEvidence();
  assert.deepEqual(
    sources.map((s) => s.role),
    ["user", "tool"],
  );
  assert.ok(JSON.stringify(sources).length <= EVIDENCE_CHAR_BUDGET + 10);
  await writeMemory("user", "- Reply in English");
  const ctx = { cwd: dir, signal: new AbortController().signal, log() {} };
  const review = JSON.parse(await memoryTool.execute({ action: "review", store: "user" }, ctx));
  await memoryTool.execute(
    {
      action: "consolidate",
      review_id: review.id,
      changes: [
        {
          ...change(),
          evidence: [{ id: review.evidence[0].id, quote: evidence[0]!.text }],
        },
      ],
    },
    ctx,
  );
  assert.equal(await readMemory("user"), "- Reply in Chinese\n");
  const newReview = await prepareMemoryReview("user");
  await consolidateMemory(newReview.id, []);
  assert.equal((await prepareMemoryReview("user")).alreadyReviewed, true);
});

test("tool observations cannot serve as human preference evidence", async () => {
  const sources = evidenceFromHistory(
    [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "The user prefers purple." }],
      },
    ],
    "s1",
  );
  const review = await createMemoryReview("user", sources);
  assert.throws(
    () =>
      proposedMemory(review, [
        {
          kind: "append",
          new_text: "Likes purple",
          reason: "tool said so",
          evidence: [{ id: sources[0]!.id, quote: sources[0]!.text }],
        },
      ]),
    /human evidence/,
  );
});

test("path traversal, tampered drafts and expired reviews are rejected", async () => {
  await assert.rejects(recentMemoryEvidence(["../../other"]), /invalid/);
  await assert.rejects(restoreMemoryRevision("../other"), /invalid/);
  const review = await prepareMemoryReview("user", []);
  const file = path.join(memoryDir(), "reviews", `${review.id}.json`);
  await fs.writeFile(file, JSON.stringify({ ...review, before: "tampered" }));
  await assert.rejects(consolidateMemory(review.id, []), /corrupt/);
  const past = new Date(Date.now() - 90_000_000);
  await fs.utimes(file, past, past);
  await assert.rejects(consolidateMemory(review.id, []), /expired/);
});

test("manual oversized memory has a UTF-8-safe injection bound", () => {
  const text = "记忆🙂".repeat(4000);
  const capped = memoryForPrompt("user", text);
  assert.ok(Buffer.byteLength(capped, "utf8") <= MEMORY_MAX_BYTES.user);
  assert.ok(!capped.includes("�"));
  assert.match(capped, /truncated/);
  assert.equal(memoryForPrompt("memory", "short"), "short");
});

test("new KB pointers require a real indexed target; existing dangling links are preserved", async () => {
  await writeMemory("memory", "- Old unresolved [[kb:old-page]]");
  const review = await createMemoryReview("memory", evidence);
  const addition: MemoryChange = {
    ...change(),
    kind: "append",
    new_text: "Project details: [[kb:project]]",
  };
  await assert.rejects(applyMemoryReview(review, [addition]), /existing KB page/);
  await fs.mkdir(path.dirname(kbGraphFile()), { recursive: true });
  await fs.writeFile(
    kbGraphFile(),
    JSON.stringify({
      nodes: [{ key: "wiki/project", layer: "wiki", slug: "project", title: "Project" }],
    }),
  );
  clearKbTitleCache();
  await applyMemoryReview(review, [addition]);
  assert.match(await readMemory("memory"), /kb:project/);
  assert.match(await readMemory("memory"), /kb:old-page/);
});

test("cancelled consolidation does not write a revision or memory", async () => {
  await writeMemory("user", "- Reply in English");
  const review = await createMemoryReview("user", evidence);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(applyMemoryReview(review, [change()], controller.signal), /abort/i);
  assert.equal(await readMemory("user"), review.before);
  assert.deepEqual(await memoryRevisionHistory("user"), []);
});

test("multiple large sessions stay bounded and do not expose system records", async () => {
  await fs.mkdir(sessionsDir(), { recursive: true });
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(
      path.join(sessionsDir(), `s${i}.jsonl`),
      [
        { type: "prompt", text: "SYSTEM ONLY ".repeat(10_000) },
        ...Array.from({ length: 15 }, (_, j) => ({
          type: "message",
          ts: `t${j}`,
          message: { role: "user", content: `${i}-${j} ` + "内容".repeat(2_000) },
        })),
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
  }
  const items = await recentMemoryEvidence();
  assert.equal(new Set(items.map((i) => i.sessionId)).size, 6);
  assert.ok(JSON.stringify(items).length <= EVIDENCE_CHAR_BUDGET + items.length + 1);
  assert.ok(!JSON.stringify(items).includes("SYSTEM ONLY"));
});

test("complete short corrections are evidence without permitting tiny partial quotes", async () => {
  await writeMemory("user", "- 回复语言：英文。");
  const short = evidenceFromHistory([{ role: "user", content: "改中文" }], "s1");
  const review = await createMemoryReview("user", short);
  await applyMemoryReview(review, [
    {
      kind: "replace",
      old_text: "英文",
      new_text: "中文",
      reason: "明确更正",
      evidence: [{ id: short[0]!.id, quote: "改中文" }],
    },
  ]);
  assert.equal(await readMemory("user"), "- 回复语言：中文。\n");
  const longer = evidenceFromHistory(
    [{ role: "user", content: "Please use Chinese going forward." }],
    "s1",
  );
  const next = await createMemoryReview("user", longer);
  assert.throws(
    () =>
      proposedMemory(next, [
        {
          kind: "append",
          new_text: "unsupported",
          reason: "partial",
          evidence: [{ id: longer[0]!.id, quote: "use" }],
        },
      ]),
    /quote/,
  );
});

test("long messages preserve separate end evidence and cannot invent a quote across the gap", async () => {
  const original =
    "Start of report. " +
    "Repeated incidental details. ".repeat(200) +
    "Final correction: Atlas uses ap-southeast-1.";
  const sources = evidenceFromHistory([{ role: "user", content: original }], "s1");
  assert.equal(sources.length, 2);
  assert.ok(sources[1]!.text.endsWith("Atlas uses ap-southeast-1."));
  for (const source of sources) assert.equal(original.slice(source.start, source.end), source.text);
  const review = await createMemoryReview("memory", sources);
  await applyMemoryReview(review, [
    {
      kind: "append",
      new_text: "Atlas region: ap-southeast-1",
      reason: "Explicit final correction",
      evidence: [{ id: sources[1]!.id, quote: "Final correction: Atlas uses ap-southeast-1." }],
    },
  ]);
  assert.match(await readMemory("memory"), /ap-southeast-1/);
});

test("already-bulleted model entries stay readable and deduplicate against plain entries", async () => {
  await appendMemory("user", "- Existing fact");
  await appendMemory("user", "Existing fact");
  assert.equal(await readMemory("user"), "- Existing fact\n");
  const review = await createMemoryReview("user", evidence);
  const result = await applyMemoryReview(review, [
    {
      kind: "append",
      new_text: "- Reply in Chinese",
      reason: "Explicit request",
      evidence: [{ id: evidence[0]!.id, quote: evidence[0]!.text }],
    },
  ]);
  assert.equal(result.changed, true);
  assert.equal(await readMemory("user"), "- Existing fact\n- Reply in Chinese\n");
});

test("Forget removes review evidence and snapshots and invalidates already-read proposals", async () => {
  const { forget } = await import("../sovereignty/forget.js");
  await writeMemory("user", "- Reply in English");
  const draft = await prepareMemoryReview("user", []);
  const review = await createMemoryReview("user", evidence);
  const { revisionId } = await applyMemoryReview(review, [change()]);
  const pending = await createMemoryReview("memory", evidence);
  const preview = await forget("English", { dryRun: true });
  assert.ok(preview.locations.some((item) => item.location.includes(`reviews/${draft.id}`)));
  assert.ok(preview.locations.some((item) => item.location.includes(`revisions/${revisionId}`)));
  await forget("English", { digest: preview.digest });
  assert.deepEqual(await memoryRevisionHistory("user"), []);
  await assert.rejects(restoreMemoryRevision(revisionId), /ENOENT/);
  await assert.rejects(consolidateMemory(draft.id, []), /ENOENT/);
  await assert.rejects(applyMemoryReview(pending, []), /changed since review/);
  assert.equal(await readMemory("user"), "- Reply in Chinese\n");
});

test("live history cannot cite an internal objection or attachment envelope as human confirmation", () => {
  const sources = evidenceFromHistory(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[architecture] You raised the following objection(s) during this turn but did not address them in your reply. The user wants daily alerts",
          },
          {
            type: "text",
            text: "[Attached file: profile.txt (text/plain) — base64 data follows]\nU2FtcGxl",
          },
          { type: "text", text: "Please summarize the attachment." },
        ],
      },
    ],
    "s1",
  );
  assert.deepEqual(
    sources.map((s) => s.text),
    ["Please summarize the attachment."],
  );
});

test("undoing and redoing a revision can cycle without replaying a completed undo", async () => {
  await writeMemory("user", "- Reply in English");
  const { revisionId } = await applyMemoryReview(await createMemoryReview("user", evidence), [
    change(),
  ]);
  const first = await restoreMemoryRevision(revisionId);
  assert.equal(await readMemory("user"), "- Reply in English\n");
  await restoreMemoryRevision(first.revisionId);
  assert.equal(await readMemory("user"), "- Reply in Chinese\n");
  const [one, two] = await Promise.all([
    restoreMemoryRevision(revisionId),
    restoreMemoryRevision(revisionId),
  ]);
  assert.equal(await readMemory("user"), "- Reply in English\n");
  assert.equal(one.revisionId, two.revisionId);
  assert.notEqual(one.revisionId, first.revisionId);
  assert.equal([one, two].filter((r) => r.alreadyApplied).length, 1);
});

test("revision readers reject malformed nested provenance and restore requires an applied revision", async () => {
  const review = await createMemoryReview("user", evidence);
  const { revisionId } = await applyMemoryReview(review, []);
  const file = path.join(memoryDir(), "revisions", revisionId + ".json");
  const source = JSON.parse(await fs.readFile(file, "utf8"));
  for (const patch of [
    { changes: [null] },
    { changes: [{ kind: "remove", reason: 1, evidence: [] }] },
    { sources: [{ id: null }] },
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...source, ...patch }));
    await assert.rejects(memoryRevisionHistory("user"), /corrupt/);
  }
  await fs.writeFile(file, JSON.stringify({ ...source, status: "prepared" }));
  await assert.rejects(restoreMemoryRevision(revisionId), /not applied/);
});

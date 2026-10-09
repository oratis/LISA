import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearIndexCache, buildIndex } from "../memory/vector.js";
import { searchKb } from "../kb/search.js";
import { gitLogOneline, initSoulRepo } from "../soul/git.js";
import { FORGOTTEN, forget, ForgetError, readForgetNotice } from "./forget.js";

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ["LISA_HOME", "LISA_SOUL_GIT", "LISA_EDITION"]) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-forget-"));
  process.env.LISA_HOME = home;
  process.env.LISA_SOUL_GIT = "1";
  clearIndexCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function read(rel: string): string {
  return fs.readFileSync(path.join(home, rel), "utf8");
}

const SESSION = "2026-10-01-abc";

function seed(): void {
  write(
    "memory/MEMORY.md",
    "- Sam's sister Alice lives in Oslo\n- likes tea\n- notes in [[kb:glacier-research]] and [[kb:tea]]\n",
  );
  write("memory/USER.md", "- prefers ALICE's recipes\n- name: Sam\n");
  write(
    "kb/wiki/glacier-research.md",
    "---\ntitle: Alice notes\n---\nAlice studies glaciology in Oslo.\n",
  );
  write(
    "kb/wiki/travel.md",
    "---\ntitle: Travel\n---\nVisited Bergen with alice.\nTrains are great.\nSee [[glacier-research|her notes]].\n",
  );
  write("kb/wiki/tea.md", "---\ntitle: Tea\n---\nOolong is nice.\n");
  const lines = [
    {
      type: "session",
      id: SESSION,
      version: 2,
      startedAt: "2026-10-01T10:00:00Z",
      cwd: "/x",
      model: "m",
    },
    {
      type: "prompt",
      ts: "t",
      fingerprint: "f",
      reason: "initial",
      text: "## Memory\n- Sam's sister Alice lives in Oslo\n- likes tea",
    },
    {
      type: "message",
      ts: "t",
      message: { role: "user", content: "Tell me what you know about Alice" },
    },
    {
      type: "message",
      ts: "t",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user asks about Alice.", signature: "sig" },
          { type: "text", text: "Alice is in Oslo." },
          {
            type: "tool_use",
            id: "tu1",
            name: "memory_search",
            input: { query: "Alice Oslo", k: 3 },
          },
        ],
      },
    },
    {
      type: "message",
      ts: "t",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "found: Alice glaciology" }],
      },
    },
    { type: "message", ts: "t", message: { role: "user", content: "and how do I brew oolong?" } },
    { type: "reflection", ts: "t", summary: "Talked about Alice.\nAlso tea." },
  ];
  write(`sessions/${SESSION}.jsonl`, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write(
    `reflections/${SESSION}.json`,
    JSON.stringify({ summary: "Sam's sister Alice", operations: [] }),
  );
  write("embeddings/ollama_nomic.json", JSON.stringify({ abc: [0.1, 0.2] }));
  write("soul/seed.json", "{}\n");
  write("soul/identity.md", "I once met an Alice in a story.\n");
  write("soul/journal/2026-10-01.md", "## 10:00\n\nSam told me about Alice today. I felt warm.\n");
  write("soul/relationships/owner.md", "Sam has a sister named Alice.\n");
}

describe("forget", () => {
  test("rejects too-short and non-string queries", async () => {
    await assert.rejects(forget("ab"), ForgetError);
    await assert.rejects(forget(42 as unknown as string), ForgetError);
    await assert.rejects(forget("a\u0000b c"), ForgetError);
  });

  test("dry-run counts every layer, changes nothing, and reports no content", async () => {
    seed();
    const before = new Map(
      [
        "memory/MEMORY.md",
        "memory/USER.md",
        "kb/wiki/travel.md",
        `sessions/${SESSION}.jsonl`,
        "soul/journal/2026-10-01.md",
      ].map((r) => [r, read(r)]),
    );
    const report = await forget("alice", { dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.counts.memory, 1);
    assert.equal(report.counts.user, 1);
    assert.equal(report.counts.kb, 2); // glacier-research deleted, travel redacted
    assert.equal(report.counts.memory_kb_links, 2); // memory pointer + travel backlink
    assert.equal(report.counts.sessions, 5); // prompt, 3 matching messages, reflection entry
    assert.equal(report.counts.reflections, 1);
    assert.ok(report.counts.search_index >= 2);
    assert.equal(report.counts.relationships, 1);
    assert.equal(report.counts.journal, 1);
    assert.deepEqual(
      report.untouched.map((u) => u.location),
      ["soul/identity.md"],
    );
    assert.ok(report.residuals.some((r) => /provider/i.test(r)));
    assert.ok(report.residuals.some((r) => /backup/i.test(r)));
    for (const [r, content] of before) assert.equal(read(r), content, `${r} changed by dry-run`);
    assert.ok(fs.existsSync(path.join(home, "kb/wiki/glacier-research.md")));
    const json = JSON.stringify(report);
    for (const secret of ["Oslo", "glaciology", "felt warm", "sister"]) {
      assert.ok(!json.includes(secret), `report leaks content: ${secret}`);
    }
    const audit = read("sovereignty/audit.jsonl");
    assert.match(audit, /"action":"forget.dry_run"/);
    assert.ok(!/alice/i.test(audit), "audit must not hold the query");
  });

  test("apply cleans every layer, keeps structure, and leaves nothing findable", async () => {
    seed();
    await initSoulRepo();
    const report = await forget("Alice");
    assert.equal(report.dryRun, false);
    assert.ok(report.remaining);
    for (const [layer, n] of Object.entries(report.remaining)) {
      assert.equal(n, 0, `${layer} still has matches after forget`);
    }

    // (a) memory: matching entries gone, dangling pointer stripped, rest kept.
    assert.equal(read("memory/MEMORY.md"), "- likes tea\n- notes in and [[kb:tea]]\n");
    assert.equal(read("memory/USER.md"), "- name: Sam\n");
    // (b) kb: page deleted, other page redacted line-wise with backlink removed.
    assert.ok(!fs.existsSync(path.join(home, "kb/wiki/glacier-research.md")));
    const travel = read("kb/wiki/travel.md");
    assert.ok(!/alice/i.test(travel));
    assert.match(travel, /Trains are great\./);
    assert.ok(!/alice/i.test(read("kb/index.md")));
    // (c) sessions: same number of lines, same entry types, text redacted.
    const lines = read(`sessions/${SESSION}.jsonl`).trim().split("\n");
    assert.equal(lines.length, 7);
    const entries = lines.map(
      (l) => JSON.parse(l) as { type: string; message?: { content: unknown } },
    );
    assert.deepEqual(
      entries.map((e) => e.type),
      ["session", "prompt", "message", "message", "message", "message", "reflection"],
    );
    assert.ok(!/alice/i.test(lines.join("\n")));
    assert.equal(entries[2]!.message!.content, FORGOTTEN);
    const assistant = entries[3]!.message!.content as { type: string; text?: string }[];
    assert.deepEqual(
      assistant.map((b) => b.type),
      ["text", "tool_use"],
      "thinking block with the topic is dropped, others kept",
    );
    assert.equal(assistant[0]!.text, FORGOTTEN);
    assert.equal(entries[5]!.message!.content, "and how do I brew oolong?");
    assert.ok(!/alice/i.test(read(`reflections/${SESSION}.json`)));
    // (d) search index: persisted embeddings evicted, rebuilt index is clean.
    assert.ok(!fs.existsSync(path.join(home, "embeddings")));
    const index = await buildIndex({ cache: false });
    assert.ok(index.docs.length > 0);
    assert.ok(index.docs.every((d) => !/alice/i.test(d.text)));
    assert.deepEqual(await searchKb("alice"), []);
    // (e) relationships + (f) journal: literal redaction only.
    assert.equal(read("soul/relationships/owner.md"), `Sam has a sister named ${FORGOTTEN}.\n`);
    assert.equal(
      read("soul/journal/2026-10-01.md"),
      `## 10:00\n\nSam told me about ${FORGOTTEN} today. I felt warm.\n`,
    );
    // Lisa's own self is never edited.
    assert.equal(read("soul/identity.md"), "I once met an Alice in a story.\n");
    // Soul git: each soul change is a labelled, auditable commit.
    const log = await gitLogOneline({ limit: 10 });
    assert.match(log, /user-forget: journal\/2026-10-01\.md via user_forget/);
    assert.match(log, /user-forget: relationships\/owner\.md via user_forget/);
    // Lisa gets a notice; it names no topic.
    const notice = await readForgetNotice();
    assert.ok(notice);
    assert.equal(notice.journal, 1);
    assert.ok(!/alice/i.test(read("sovereignty/forget-notice.json")));
    assert.match(read("sovereignty/audit.jsonl"), /"action":"forget.apply"/);
  });

  test("a corrupt MEMORY.md is reported, not rewritten, and other layers still apply", async () => {
    fs.mkdirSync(path.join(home, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(home, "memory/MEMORY.md"),
      Buffer.from([0x2d, 0x20, 0x41, 0x6c, 0x69, 0x63, 0x65, 0x00, 0xff, 0x0a]),
    );
    write("soul/journal/2026-10-02.md", "Alice again.\n");
    const before = fs.readFileSync(path.join(home, "memory/MEMORY.md"));
    const report = await forget("alice");
    assert.deepEqual(report.errors, [{ layer: "memory", error: "memory_corrupt" }]);
    assert.ok(fs.readFileSync(path.join(home, "memory/MEMORY.md")).equals(before));
    assert.equal(read("soul/journal/2026-10-02.md"), `${FORGOTTEN} again.\n`);
  });

  test("forget never reaches another tenant's home", async () => {
    const { homeScope, homeForUid } = await import("../paths.js");
    const a = homeForUid("uid-a");
    const b = homeForUid("uid-b");
    for (const h of [a, b]) {
      fs.mkdirSync(path.join(h, "memory"), { recursive: true });
      fs.writeFileSync(path.join(h, "memory", "MEMORY.md"), "- Alice is a friend\n");
    }
    await homeScope.run(a, () => forget("alice"));
    assert.equal(fs.readFileSync(path.join(a, "memory", "MEMORY.md"), "utf8"), "\n");
    assert.equal(
      fs.readFileSync(path.join(b, "memory", "MEMORY.md"), "utf8"),
      "- Alice is a friend\n",
    );
  });
});

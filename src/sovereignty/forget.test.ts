import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearIndexCache, buildIndex } from "../memory/vector.js";
import { searchKb } from "../kb/search.js";
import { gitLogOneline, initSoulRepo } from "../soul/git.js";
import { loadSessionMessages } from "../sessions/list.js";
import {
  FORGOTTEN,
  forget,
  ForgetError,
  OUTSIDE_ACCOUNT_HOME_STORES,
  readForgetNotice,
  replaceAppendOnly,
} from "./forget.js";

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

  test("dry-run previews every layer with snippets, changes nothing, audits no content", async () => {
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
    // The preview shows each item with the text around the match, and why.
    const at = (loc: string) => report.locations.find((l) => l.location.startsWith(loc));
    assert.equal(at("memory/MEMORY.md#")?.snippet, "Sam's sister Alice lives in Oslo");
    assert.equal(at("kb/wiki/glacier-research.md")?.action, "delete");
    assert.equal(at("kb/wiki/glacier-research.md")?.why, "title");
    assert.equal(at("kb/wiki/glacier-research.md")?.snippet, "Alice notes");
    assert.equal(
      at("soul/journal/2026-10-01.md:3")?.snippet,
      "Sam told me about Alice today. I felt warm.",
    );
    assert.equal(at(`sessions/${SESSION}.jsonl:3`)?.snippet, "Tell me what you know about Alice");
    assert.match(report.digest, /^[0-9a-f]{32}$/);
    assert.equal(report.match.mode, "words");
    const audit = read("sovereignty/audit.jsonl");
    assert.match(audit, /"action":"forget.dry_run"/);
    assert.ok(!/alice/i.test(audit), "audit must not hold the query");
  });

  test("apply cleans every layer, keeps structure, and leaves nothing findable", async () => {
    seed();
    await initSoulRepo();
    const preview = await forget("Alice", { dryRun: true });
    const report = await forget("Alice", { digest: preview.digest });
    assert.equal(report.dryRun, false);
    assert.deepEqual(
      report.locations.map((l) => l.id).sort(),
      preview.locations.map((l) => l.id).sort(),
      "apply changed exactly the previewed items",
    );
    assert.ok(
      report.locations.every((l) => l.snippet === undefined),
      "no content when applied",
    );
    for (const secret of ["Oslo", "glaciology", "felt warm", "sister"]) {
      assert.ok(!JSON.stringify(report).includes(secret), `applied report leaks: ${secret}`);
    }
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

  test("a two-character CJK topic can be forgotten; short Latin ones still cannot", async () => {
    write("memory/MEMORY.md", "- 机密 项目在周五开会\n- 天气很好\n");
    await forget("机密", { apply: true });
    assert.equal(read("memory/MEMORY.md"), "- 天气很好\n");
    await assert.rejects(forget("机"), ForgetError);
    await assert.rejects(forget("ab"), ForgetError);
  });

  test("in an account scope the report names the stores kept outside the account home", async () => {
    const { homeScope, homeForUid } = await import("../paths.js");
    const tenant = homeForUid("uid-scope");
    fs.mkdirSync(path.join(tenant, "memory"), { recursive: true });
    fs.writeFileSync(path.join(tenant, "memory", "MEMORY.md"), "- Alice is a friend\n");
    const scoped = await homeScope.run(tenant, () => forget("alice"));
    for (const store of OUTSIDE_ACCOUNT_HOME_STORES) {
      assert.ok(scoped.notScanned.includes(store), store);
      assert.ok(scoped.residuals.includes(`Not scanned: ${store}`), store);
    }
    const local = await forget("alice");
    for (const store of OUTSIDE_ACCOUNT_HOME_STORES) {
      assert.equal(local.notScanned.includes(store), false, store);
    }
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

  test("matches whole words only: 'Ann' spares annual, planning and announcement", async () => {
    process.env.LISA_KB_NO_GIT = "1";
    write(
      "memory/MEMORY.md",
      "- Ann is my cousin\n- annual review is on Friday\n- planning a trip to Rome\n",
    );
    write("kb/wiki/annual-report.md", "---\ntitle: Annual report\n---\nRevenue grew.\n");
    write("kb/wiki/rome.md", "---\ntitle: Rome\n---\nThe announcement went out.\nColosseum.\n");
    write("kb/wiki/family.md", "---\ntitle: Family\n---\nAnn's birthday is in May.\nCake.\n");
    write("soul/journal/2026-10-01.md", "Talked about ANN and the annual plan.\n");
    try {
      const report = await forget("Ann");
      assert.equal(
        read("memory/MEMORY.md"),
        "- annual review is on Friday\n- planning a trip to Rome\n",
      );
      assert.ok(fs.existsSync(path.join(home, "kb/wiki/annual-report.md")));
      assert.equal(
        read("kb/wiki/rome.md"),
        "---\ntitle: Rome\n---\nThe announcement went out.\nColosseum.\n",
      );
      assert.match(read("kb/wiki/family.md"), new RegExp(`${escape(FORGOTTEN)}\\nCake\\.`));
      assert.equal(
        read("soul/journal/2026-10-01.md"),
        `Talked about ${FORGOTTEN} and the annual plan.\n`,
      );
      assert.equal(report.counts.memory, 1);
      assert.equal(report.counts.kb, 1);
    } finally {
      delete process.env.LISA_KB_NO_GIT;
    }
  });

  test("a KB page is never deleted for its file name or provenance alone", async () => {
    process.env.LISA_KB_NO_GIT = "1";
    write(
      "kb/sources/ann-call.md",
      "---\ntitle: Call notes\nurl: https://example.com/ann\nauthor: Ann Lee\n---\nBudget is fine.\n",
    );
    write("kb/wiki/ann.md", "---\ntitle: Tea\ntags: [drinks]\n---\nOolong.\n");
    write("kb/wiki/people.md", "---\ntitle: People\ntags: [ann, friends]\n---\nA list.\n");
    try {
      const preview = await forget("ann", { dryRun: true });
      const report = await forget("ann", { digest: preview.digest });
      // Kept: the title and tags don't name the topic.
      assert.ok(fs.existsSync(path.join(home, "kb/wiki/ann.md")));
      assert.equal(read("kb/wiki/ann.md"), "---\ntitle: Tea\ntags: [drinks]\n---\nOolong.\n");
      const call = read("kb/sources/ann-call.md");
      assert.ok(fs.existsSync(path.join(home, "kb/sources/ann-call.md")));
      assert.match(call, /Budget is fine\./);
      assert.ok(!/Ann Lee|example\.com\/ann/.test(call), "matching provenance values redacted");
      // Deleted: a tag names it.
      assert.ok(!fs.existsSync(path.join(home, "kb/wiki/people.md")));
      assert.equal(preview.locations.find((l) => l.location === "kb/wiki/people.md")?.why, "tag");
      // File names that mention it are listed, not acted on.
      assert.deepEqual(
        report.untouched
          .filter((u) => u.layer === "kb")
          .map((u) => [u.location, u.why])
          .sort(),
        [
          ["kb/sources/ann-call.md", "file name"],
          ["kb/wiki/ann.md", "file name"],
        ],
      );
    } finally {
      delete process.env.LISA_KB_NO_GIT;
    }
  });

  test("CJK topics match the exact character sequence, and the preview says so", async () => {
    write("memory/MEMORY.md", "- 我住在東京都内\n- 京都很美\n- met Ann at 東京都庁\n");
    const preview = await forget("東京都", { dryRun: true });
    assert.equal(preview.match.mode, "sequence");
    assert.match(preview.match.note, /exact character sequence/);
    assert.equal(preview.counts.memory, 2);
    await forget("東京都", { digest: preview.digest });
    assert.equal(read("memory/MEMORY.md"), "- 京都很美\n");
    // A Latin word next to CJK text still counts as a whole word.
    write("memory/MEMORY.md", "- 我和Ann去了\n- Annabel\n");
    await forget("Ann");
    assert.equal(read("memory/MEMORY.md"), "- Annabel\n");
  });

  test("apply refuses when the matches changed after the preview, and changes nothing", async () => {
    write("memory/MEMORY.md", "- Ann is my cousin\n- likes tea\n");
    write("soul/journal/2026-10-01.md", "Ann called.\n");
    const preview = await forget("Ann", { dryRun: true });
    // A new mention appears after the person saw the preview.
    fs.appendFileSync(
      path.join(home, "soul/journal/2026-10-01.md"),
      "Ann's address is 5 Elm St.\n",
    );
    await assert.rejects(
      forget("Ann", { digest: preview.digest }),
      (e: Error) => e instanceof ForgetError && e.code === "preview_changed",
    );
    assert.equal(read("memory/MEMORY.md"), "- Ann is my cousin\n- likes tea\n");
    assert.equal(read("soul/journal/2026-10-01.md"), "Ann called.\nAnn's address is 5 Elm St.\n");
    // A fresh preview of the new state applies.
    const again = await forget("Ann", { dryRun: true });
    assert.equal(again.counts.journal, 2);
    await forget("Ann", { digest: again.digest });
    assert.equal(read("memory/MEMORY.md"), "- likes tea\n");
  });

  test("never rewrites structure: every transcript still loads, whatever the query", async () => {
    const lines = [
      {
        type: "session",
        id: "2026-10-01-abc",
        version: 2,
        startedAt: "2026-10-01T10:00:00Z",
        cwd: "/x",
        model: "claude-x",
      },
      {
        type: "prompt",
        ts: "2026-10-01T10:00:00Z",
        fingerprint: "fp1",
        reason: "initial",
        text: "Be kind.",
      },
      {
        type: "message",
        ts: "2026-10-01T10:00:01Z",
        message: { role: "user", content: "what's the weather" },
      },
      {
        type: "message",
        ts: "2026-10-01T10:00:02Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check it.", signature: "sig-abc" },
            { type: "text", text: "Sunny." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "memory_search",
              input: { query: "weather", k: 3 },
            },
          ],
        },
      },
      {
        type: "message",
        ts: "2026-10-01T10:00:03Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "none" }],
        },
      },
      { type: "model_change", ts: "2026-10-01T10:00:04Z", model: "claude-x" },
      { type: "reflection", ts: "2026-10-01T10:00:05Z", summary: "Talked." },
    ];
    const original = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    for (const query of [
      "message",
      "session",
      "2026-10-01",
      "2026-10-01-abc",
      "assistant",
      "user",
      "tool_use",
      "toolu_1",
      "memory_search",
      "text",
      "thinking",
      "signature",
      "sig-abc",
      "model_change",
      "claude-x",
      "fingerprint",
      "initial",
      "role",
      "content",
    ]) {
      write(`sessions/${SESSION}.jsonl`, original);
      const preview = await forget(query, { dryRun: true });
      assert.equal(preview.counts.sessions, 0, `${query}: structure counted as content`);
      await forget(query, { digest: preview.digest });
      assert.equal(read(`sessions/${SESSION}.jsonl`), original, `${query} rewrote structure`);
    }
    // Content queries redact content and nothing else; the file still loads.
    write(`sessions/${SESSION}.jsonl`, original);
    for (const query of ["weather", "Sunny", "Check it", "Be kind", "Talked", "none"]) {
      await forget(query);
    }
    const after = read(`sessions/${SESSION}.jsonl`).trim().split("\n");
    assert.equal(after[0], JSON.stringify(lines[0]), "header untouched");
    const parsed = after.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(
      parsed.map((p) => [p.type, p.ts ?? null]),
      lines.map((l) => [l.type, (l as { ts?: string }).ts ?? null]),
    );
    const { header, messages } = await loadSessionMessages(SESSION);
    assert.equal(header.id, "2026-10-01-abc");
    assert.deepEqual(
      messages.map((msg) => msg.role),
      ["user", "assistant", "user"],
    );
    assert.equal(messages[0]!.content, FORGOTTEN);
    const blocks = messages[1]!.content as {
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
    }[];
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["text", "tool_use"],
      "signed thinking dropped, others kept",
    );
    assert.deepEqual(
      [blocks[1]!.id, blocks[1]!.name, blocks[1]!.input],
      ["toolu_1", "memory_search", { query: FORGOTTEN, k: 3 }],
    );
    const result = (messages[2]!.content as { tool_use_id: string; content: unknown }[])[0]!;
    assert.deepEqual([result.tool_use_id, result.content], ["toolu_1", FORGOTTEN]);
    assert.equal(parsed[1]!.fingerprint, "fp1");
  });

  test("never matches its own placeholder: a second forget changes nothing", async () => {
    write("soul/journal/2026-10-01.md", "I wonder about the user today.\n");
    write("kb/wiki/notes.md", "---\ntitle: Notes\n---\nThe user said hi.\nOther.\n");
    write(
      `sessions/${SESSION}.jsonl`,
      [
        JSON.stringify({
          type: "session",
          id: SESSION,
          version: 2,
          startedAt: "t",
          cwd: "/x",
          model: "m",
        }),
        JSON.stringify({
          type: "message",
          ts: "t",
          message: { role: "user", content: "ask the user" },
        }),
      ].join("\n") + "\n",
    );
    process.env.LISA_KB_NO_GIT = "1";
    try {
      const first = await forget("user");
      assert.equal(first.remaining!.journal, 0);
      assert.equal(first.remaining!.kb, 0);
      assert.equal(first.remaining!.sessions, 0);
      const journal = read("soul/journal/2026-10-01.md");
      assert.equal(journal, `I wonder about the ${FORGOTTEN} today.\n`);
      const kb = read("kb/wiki/notes.md");
      const session = read(`sessions/${SESSION}.jsonl`);
      for (const query of ["user", "forgotten", "by user", "forgotten by user", "[forgotten"]) {
        const again = await forget(query, { dryRun: true });
        assert.deepEqual(
          again.locations.filter((l) => l.layer !== "search_index"),
          [],
          `${query} matched a placeholder`,
        );
        await forget(query);
        assert.equal(read("soul/journal/2026-10-01.md"), journal, query);
        assert.equal(read("kb/wiki/notes.md"), kb, query);
        assert.equal(read(`sessions/${SESSION}.jsonl`), session, query);
      }
    } finally {
      delete process.env.LISA_KB_NO_GIT;
    }
  });

  test("tasks: specs, run transcripts and pending notices lose the topic, keep their structure", async () => {
    const {
      createTask,
      createRun,
      appendRunMessage,
      appendRunEvent,
      checkpointRun,
      getTask,
      loadRun,
    } = await import("../tasks/store.js");
    const { enqueueNotice, listOutbox, noticeId } = await import("../tasks/outbox.js");
    const task = await createTask({
      id: "task_ann01",
      kind: "watcher",
      title: "Remind Ann",
      instruction: "email Ann about the party",
      origin: { kind: "chat" },
      trigger: {
        kind: "mail",
        from: "ann@example.com",
        subject: "party",
        mode: "appears",
      } as never,
    });
    const run = await createRun(task.id, { input: "Ann replied" });
    await appendRunMessage(task.id, run.id, { role: "user", content: "Ann's address is 5 Elm St" });
    await appendRunEvent(task.id, run.id, { type: "info", summary: "wrote to Ann" });
    await checkpointRun({
      ...run,
      summary: "Told Ann",
      artifacts: [{ kind: "text", value: "Ann: yes" }],
    });
    await enqueueNotice({
      id: noticeId(run.id, "task_result"),
      uid: null,
      taskId: task.id,
      runId: run.id,
      title: "Ann answered",
      summary: "Ann says yes",
      status: "succeeded",
      priority: "normal",
      kind: "task_result",
    });
    const preview = await forget("Ann", { dryRun: true });
    assert.ok(preview.counts.tasks >= 4, `tasks counted: ${preview.counts.tasks}`);
    assert.ok(preview.locations.some((l) => l.layer === "tasks" && l.snippet === "Remind Ann"));
    const report = await forget("Ann", { digest: preview.digest });
    assert.equal(report.remaining!.tasks, 0);
    // Every file under tasks/ is free of the topic…
    const walk = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(home, "tasks"))) {
      assert.ok(
        !/\bann\b/i.test(fs.readFileSync(f, "utf8")),
        `${path.relative(home, f)} still names it`,
      );
    }
    // …and the store still reads it all: ids, kinds, states and the watcher kept.
    const after = await getTask(task.id);
    assert.ok(after, "spec still validates");
    assert.equal(after.title, FORGOTTEN);
    assert.equal(after.instruction, FORGOTTEN);
    assert.equal(after.kind, "watcher");
    assert.equal(after.trigger?.kind, "mail");
    assert.deepEqual(after.runs, [run.id]);
    const loaded = await loadRun(task.id, run.id);
    assert.ok(loaded, "run log still loads");
    assert.equal(loaded.run.id, run.id);
    assert.equal(loaded.run.summary, FORGOTTEN);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0]!.content, FORGOTTEN);
    assert.equal(loaded.events[0]!.summary, FORGOTTEN);
    const [notice] = await listOutbox();
    assert.equal(notice!.notice.title, FORGOTTEN);
    assert.equal(notice!.notice.taskId, task.id);
    assert.equal(notice!.state, "pending");
  });

  test("tasks: state the runner sealed stays sealed after a forget; unsealed state stays unsealed (#422)", async () => {
    const { createTask, createRun, checkpointRun, getTask, loadRun, rewriteTaskJson } =
      await import("../tasks/store.js");
    const { loadDigestKey } = await import("../warden/store.js");
    const { sealRunTaint, sealTaskState, runTaintSealed, taskStateSealed } =
      await import("../tasks/seal.js");
    const key = await loadDigestKey();
    const sealed = await createTask({
      id: "task_seal01",
      kind: "routine",
      title: "Weekly plan",
      instruction: "plan the week",
      origin: { kind: "chat" },
    });
    const plain = await createTask({
      id: "task_seal02",
      kind: "routine",
      title: "Other plan",
      instruction: "plan the month",
      origin: { kind: "chat" },
    });
    for (const [t, seal] of [
      [sealed, true],
      [plain, false],
    ] as const) {
      await rewriteTaskJson(t.id, (v) => {
        const task = v as Parameters<typeof sealTaskState>[0];
        task.lastSummary = "Booked dinner with Ann";
        if (seal) sealTaskState(task, key);
        return task;
      });
    }
    const run = await createRun(sealed.id, { input: "Ann replied" }, Date.now(), {
      seal: (r) => sealRunTaint(r, key),
    });
    await checkpointRun({ ...run, summary: "Told Ann" });
    // The run as the runner left it: sealed over its current taint.
    const before = await loadRun(sealed.id, run.id);
    assert.ok(before);
    sealRunTaint(before.run, key);
    await checkpointRun(before.run);
    assert.ok(runTaintSealed((await loadRun(sealed.id, run.id))!.run, key));

    const preview = await forget("Ann", { dryRun: true });
    await forget("Ann", { digest: preview.digest });

    const a = await getTask(sealed.id);
    assert.equal(a!.lastSummary, FORGOTTEN);
    assert.equal(taskStateSealed(a!, key), true, "a sealed task is re-sealed");
    const b = await getTask(plain.id);
    assert.equal(b!.lastSummary, FORGOTTEN);
    assert.equal(taskStateSealed(b!, key), false, "forget never seals what was not sealed");
    const r = await loadRun(sealed.id, run.id);
    assert.equal(r!.run.input, FORGOTTEN);
    assert.equal(runTaintSealed(r!.run, key), true, "a sealed run is re-sealed");
  });

  test("names what it did not scan, and never claims more than it verified", async () => {
    write("memory/MEMORY.md", "- Ann is my cousin\n");
    write("skills/party/SKILL.md", "---\nname: party\n---\nInvite Ann.\n");
    write("mail/latest-digest.json", '{"items":[{"subject":"Ann"}]}');
    write("history", "tell me about Ann\n");
    write("soul/emotions.json", '{"events":[{"trigger":"Ann called"}]}');
    write("reachout/ledger.jsonl", "{}\n");
    write("brand-new-store.json", '{"x":"Ann"}');
    const preview = await forget("Ann", { dryRun: true });
    const names = preview.notScanned.map((n) => n.split(" — ")[0]);
    assert.deepEqual(names, [
      "brand-new-store.json",
      "history",
      "mail",
      "skills",
      "soul/emotions.json",
    ]);
    assert.match(preview.notScanned[0]!, /not classified/);
    for (const n of preview.notScanned) {
      assert.ok(preview.residuals.includes(`Not scanned: ${n}`), n);
    }
    assert.ok(preview.scanned.some((a) => a.startsWith("tasks/")));
    const report = await forget("Ann", { digest: preview.digest });
    assert.deepEqual(report.notScanned, preview.notScanned);
    assert.ok(Object.values(report.remaining!).every((n) => n === 0));
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("forget — matching on parsed text, nested entries, caps and caches", () => {
  const header = (id: string) => ({
    type: "session",
    id,
    version: 2,
    startedAt: "2026-10-02T10:00:00Z",
    cwd: "/x",
    model: "m",
  });
  const message = (role: string, content: unknown) => ({
    type: "message",
    ts: "t",
    message: { role, content },
  });
  function session(id: string, lines: (object | string)[]): void {
    write(
      `sessions/${id}.jsonl`,
      [header(id), ...lines]
        .map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
        .join("\n") + "\n",
    );
  }
  function sessionLines(id: string): unknown[] {
    return read(`sessions/${id}.jsonl`)
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return l; // a torn fragment, as it is on disk
        }
      });
  }

  test("a topic right after a newline or tab is found in transcripts and tasks, redacted and re-scanned", async () => {
    const id = "2026-10-02-newline";
    session(id, [
      message("user", "Friends coming over:\nAnnabel and\nAnn"),
      message("assistant", [{ type: "text", text: "Sure.\n\nAnn likes tea." }]),
      message("user", "columns:\tAnn\tBob"),
      // Escapes before a longer word still don't make it the topic.
      message("user", "the\nannual report"),
      // A torn fragment: decided on its decoded text, too.
      '{"type":"message","message":{"role":"user","content":"note:\\nAnn called',
      '{"type":"message","message":{"role":"user","content":"note:\\nannual',
    ]);
    write(
      "tasks/task_nl0001.json",
      JSON.stringify({ id: "task_nl0001", title: "Reminder", instruction: "Call:\nAnn tomorrow" }),
    );
    write(
      "tasks/runs/task_nl0001/run_nl0001.jsonl",
      JSON.stringify({ t: "msg", message: { role: "user", content: "todo:\nAnn" } }) + "\n",
    );

    const preview = await forget("Ann", { dryRun: true });
    assert.equal(preview.counts.sessions, 4, JSON.stringify(preview.locations));
    assert.equal(preview.counts.tasks, 2);
    assert.ok(
      preview.locations.some((l) => l.snippet === "Friends coming over: Annabel and Ann"),
      "the snippet shows the parsed text, not JSON escapes",
    );

    const report = await forget("Ann", { digest: preview.digest });
    assert.equal(report.remaining!.sessions, 0);
    assert.equal(report.remaining!.tasks, 0);
    const lines = sessionLines(id) as { message?: { content: unknown }; type: string }[];
    assert.deepEqual(
      lines.slice(0, 4).map((l) => l.message!.content),
      [FORGOTTEN, [{ type: "text", text: FORGOTTEN }], FORGOTTEN, "the\nannual report"],
    );
    assert.deepEqual(lines[4], { type: "forgotten" });
    assert.match(String(lines[5]), /annual$/, "the torn fragment without the word stays");
    assert.equal(
      (JSON.parse(read("tasks/task_nl0001.json")) as { instruction: string }).instruction,
      FORGOTTEN,
    );
    assert.ok(read("tasks/runs/task_nl0001/run_nl0001.jsonl").includes(FORGOTTEN));
    // A fresh scan agrees with the re-scan.
    const again = await forget("Ann", { dryRun: true });
    assert.equal(again.counts.sessions + again.counts.tasks, 0);
  });

  test("the re-scan counts a newline-led match that apply could not change", async () => {
    if (process.getuid?.() === 0) return; // root ignores the read-only directory
    const id = "2026-10-02-rescan";
    session(id, [message("user", "x\nAnn")]);
    write("memory/MEMORY.md", "- Ann is a friend\n");
    const preview = await forget("Ann", { dryRun: true });
    assert.equal(preview.counts.sessions, 1);
    const dir = path.join(home, "sessions");
    fs.chmodSync(dir, 0o555); // the transcript can't be rewritten…
    try {
      const report = await forget("Ann", { digest: preview.digest });
      assert.ok(report.errors.some((e) => e.layer === "sessions"));
      assert.equal(report.remaining!.memory, 0);
      // …and the re-scan says so instead of reporting it clean.
      assert.equal(report.remaining!.sessions, 1);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  test("a conversation expression on a forgotten line no longer renders its sticker", async () => {
    const id = "2026-10-02-expression";
    const expression = (assetId: string) => ({
      version: 1,
      id: "e-" + assetId,
      assetId,
      format: "animated",
    });
    session(id, [
      message("user", "time for a tea break?"),
      {
        ...message("assistant", "🍵 [LISA: Tea break · 喝杯茶]"),
        expression: expression("sticker-tea-break"),
      },
      {
        ...message("assistant", "👋 [LISA: Hello · 你好]"),
        expression: expression("sticker-hello"),
      },
    ]);
    const preview = await forget("tea break", { dryRun: true });
    const report = await forget("tea break", { digest: preview.digest });
    assert.equal(report.remaining!.sessions, 0);
    const lines = sessionLines(id) as { message: { content: unknown }; expression?: unknown }[];
    assert.equal(lines[1]!.message.content, FORGOTTEN);
    assert.equal(lines[1]!.expression, undefined, "the sticker record goes with its text");
    const { SessionStore } = await import("../sessions/store.js");
    const page = await (await SessionStore.open(id)).readMessagePage(0, 20, true);
    assert.equal(page.messages[1]!.expression, undefined);
    assert.ok(!JSON.stringify(page.messages).toLowerCase().includes("tea break"));
    // An unrelated expression keeps rendering.
    assert.equal(page.messages[2]!.expression?.assetId, "sticker-hello");
  });

  test("connector traces and connection requests lose the topic, nothing else", async () => {
    const id = "2026-10-02-connector";
    session(id, [
      message("user", "summarize my mail"),
      {
        type: "connector_trace",
        ts: "t",
        requestId: "r1",
        message: { role: "assistant", content: [{ type: "text", text: "Mail from Ann: lunch?" }] },
      },
    ]);
    const request = (rid: string, prompt: string) => ({
      id: rid,
      sessionId: id,
      prompt,
      createdAt: 1,
      expiresAt: 2,
      status: "succeeded",
      resources: [],
      attempts: 0,
    });
    const state = {
      version: 2,
      requests: [request("r1", "summarize mail\nfrom Ann"), request("r2", "list repos")],
    };
    write("connectors/gmail/state.json", JSON.stringify(state));
    write(
      "connectors/github/state.json.v1.bak",
      JSON.stringify({ version: 1, requests: [request("r0", "Ann's repos")] }),
    );

    const preview = await forget("Ann", { dryRun: true });
    assert.equal(preview.counts.sessions, 1);
    assert.equal(preview.counts.connectors, 2);
    const report = await forget("Ann", { digest: preview.digest });
    assert.equal(report.remaining!.sessions, 0);
    assert.equal(report.remaining!.connectors, 0);

    const trace = sessionLines(id)[1] as { type: string; requestId: string; message: unknown };
    assert.equal(trace.type, "connector_trace");
    assert.equal(trace.requestId, "r1");
    assert.deepEqual(trace.message, {
      role: "assistant",
      content: [{ type: "text", text: FORGOTTEN }],
    });
    const after = JSON.parse(read("connectors/gmail/state.json")) as typeof state;
    assert.deepEqual(after, {
      ...state,
      requests: [{ ...state.requests[0]!, prompt: FORGOTTEN }, state.requests[1]],
    });
    assert.ok(!fs.existsSync(path.join(home, "connectors/gmail/state.lock")), "lock released");
    assert.ok(!read("connectors/github/state.json.v1.bak").includes("Ann"));
    assert.ok(report.scanned.some((a) => a.startsWith("connectors/")));
  });

  test("the connector service still reads its state after a forget, with the prompt redacted", async () => {
    const { ReadonlyConnector } = await import("../connectors/service.js");
    const { GoogleReadonlyDriver } = await import("../connectors/google-driver.js");
    const { MemorySecretStore } = await import("../warden/secrets.js");
    const offline = async (): Promise<never> => {
      throw new Error("offline test driver");
    };
    const service = new ReadonlyConnector({
      home,
      secrets: new MemorySecretStore(),
      driver: new GoogleReadonlyDriver("gmail", {
        client: async () => ({ clientId: "fixture.apps.googleusercontent.com" }),
        authorize: offline,
        http: offline,
      }),
      changed: () => {},
      resume: async () => {},
    });
    const sid = "2026-10-02-service";
    const asked = await service.create(sid, "summarize the mail from Ann");
    await service.create(sid, "summarize the mail from Bob");
    const preview = await forget("Ann", { dryRun: true });
    assert.equal(preview.counts.connectors, 1);
    await forget("Ann", { digest: preview.digest });
    const state = JSON.parse(read("connectors/gmail/state.json")) as {
      requests: { id: string; prompt: string }[];
    };
    assert.deepEqual(
      state.requests.map((r) => [r.id === asked.id, r.prompt]),
      [
        [true, FORGOTTEN],
        [false, "summarize the mail from Bob"],
      ],
    );
    // The service validates every read: it still accepts the state and works on.
    assert.equal((await service.list(sid)).length, 2);
    await service.create(sid, "and from Carol");
    assert.equal((await service.list(sid)).length, 3);
    await service.stop();
  });

  test("forgetting a nested list item keeps its siblings and parent; the preview shows whole entries", async () => {
    const long =
      "Ann likes jazz and long walks on the beach every single Sunday morning before breakfast, with friends";
    write(
      "memory/MEMORY.md",
      [
        "## People",
        "- Friends:",
        "  - Ann (neighbour)",
        "  - Bob, dentist on Tue",
        "  - Carol's kids: Tim, Sue",
        `- ${long}`,
        "",
      ].join("\n"),
    );
    const preview = await forget("Ann", { dryRun: true });
    const memory = preview.locations.filter((l) => l.layer === "memory");
    assert.deepEqual(
      memory.map((l) => [l.action, l.snippet]),
      [
        ["delete", "Ann (neighbour)"],
        ["delete", long],
      ],
    );
    await forget("Ann", { digest: preview.digest });
    assert.equal(
      read("memory/MEMORY.md"),
      "## People\n- Friends:\n  - Bob, dentist on Tue\n  - Carol's kids: Tim, Sue\n",
    );
  });

  test("a store over its byte cap still loses the topic", async () => {
    const lines = ["- Ann's phone is 555-0100"];
    for (let i = 0; i < 60; i++) lines.push(`- filler entry number ${i} about the weather`);
    write("memory/USER.md", lines.join("\n") + "\n");
    assert.ok(fs.statSync(path.join(home, "memory/USER.md")).size > 2048);
    const preview = await forget("Ann", { dryRun: true });
    const report = await forget("Ann", { digest: preview.digest });
    assert.deepEqual(report.errors, []);
    assert.equal(report.remaining!.user, 0);
    assert.ok(!read("memory/USER.md").includes("Ann"));
  });

  test("nothing found: no search-index item, no eviction, no notice for Lisa", async () => {
    write("embeddings/cache.json", "{}");
    write("memory/MEMORY.md", "- likes tea\n");
    const preview = await forget("Zanzibar", { dryRun: true });
    assert.ok(
      Object.values(preview.counts).every((n) => n === 0),
      JSON.stringify(preview.counts),
    );
    assert.deepEqual(preview.locations, []);
    await forget("Zanzibar", { digest: preview.digest });
    assert.equal(await readForgetNotice(), null);
    assert.ok(fs.existsSync(path.join(home, "embeddings/cache.json")));
    // With a match the cache is evicted, as before.
    write("memory/MEMORY.md", "- likes tea with Ann\n");
    const found = await forget("Ann", { dryRun: true });
    assert.ok(found.counts.search_index > 0);
    await forget("Ann", { digest: found.digest });
    assert.ok(!fs.existsSync(path.join(home, "embeddings/cache.json")));
    assert.ok(await readForgetNotice());
  });

  test("an append that races the transcript rewrite is carried over, not lost", async () => {
    const file = path.join(home, "sessions", "race.jsonl");
    write("sessions/race.jsonl", "a\n");
    const tmp = `${file}.tmp-test`;
    fs.writeFileSync(tmp, "A\n");
    const before = fs.statSync(file);
    // A writer that opened the transcript before the rename…
    const writer = await fs.promises.open(file, "a");
    const replacing = replaceAppendOnly(file, tmp, before, 200);
    while (fs.statSync(file).ino === before.ino) await new Promise((r) => setImmediate(r));
    // …and writes after it.
    await writer.write("b\n");
    await writer.close();
    assert.equal(await replacing, true);
    assert.equal(read("sessions/race.jsonl"), "A\nb\n");

    // A change before the rename makes it redo instead (and drops the temp file).
    fs.writeFileSync(tmp, "B\n");
    const stale = fs.statSync(file);
    fs.appendFileSync(file, "c\n");
    assert.equal(await replaceAppendOnly(file, tmp, stale, 0), false);
    assert.ok(!fs.existsSync(tmp));
    assert.equal(read("sessions/race.jsonl"), "A\nb\nc\n");
  });
});

describe("forget × the dream log (#423)", () => {
  test("forget deletes the revert copy that holds the topic, so a later revert cannot bring it back", async () => {
    const { withDream } = await import("../reve/record.js");
    const { listDreams, readDream } = await import("../reve/store.js");
    const { revertDream, RevertConflictError } = await import("../reve/revert.js");
    const { removeFromMemory } = await import("../memory/store.js");
    write("memory/MEMORY.md", "- Sam's sister Alice lives in Oslo\n- likes tea\n");
    // A dream consolidates the entry away: its sidecar now holds it.
    await withDream({ trigger: "idle" }, () => removeFromMemory("memory", "Alice"));
    const id = (await listDreams(1)).dreams[0]!.id;
    const side = `reve/dreams/${id}.before.json`;
    assert.match(read(side), /Alice/);

    const preview = await forget("Alice", { dryRun: true });
    assert.ok(preview.counts.reve > 0, "the dream log is part of the preview");
    const sideItem = preview.locations.find((l) => l.location === side);
    assert.equal(sideItem?.action, "delete");
    assert.match(sideItem?.snippet ?? "", /Alice/);
    assert.ok(preview.locations.some((l) => l.location === `reve/dreams/${id}.json`));
    assert.match(read(side), /Alice/, "a dry run writes nothing");

    const applied = await forget("Alice", { digest: preview.digest });
    assert.equal(applied.remaining?.reve, 0, "the re-scan finds nothing left in reve/");
    assert.equal(fs.existsSync(path.join(home, side)), false, "revert copy deleted");
    assert.doesNotMatch(read(`reve/dreams/${id}.json`), /Alice/);
    const rec = await readDream(id);
    const change = rec.changes.find((c) => c.path === "memory/MEMORY.md");
    assert.equal(change?.revertible, false);

    await assert.rejects(revertDream(id, { parts: ["memory"] }), RevertConflictError);
    const forced = await revertDream(id, { parts: ["memory"], force: true });
    assert.deepEqual(forced.reverted, []);
    assert.doesNotMatch(read("memory/MEMORY.md"), /Alice/, "the revert brought nothing back");
  });

  test("reve/ is scanned, not listed as a residual", async () => {
    write("reve/reconsider.json", JSON.stringify({ version: 1, requests: [] }));
    const report = await forget("Alice", { dryRun: true });
    assert.ok(report.scanned.some((s) => s.startsWith("reve")));
    assert.ok(!report.notScanned.some((s) => s.startsWith("reve")));
  });
});

test("Forget refuses linked review and processed directories across homes", async () => {
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-forget-"));
  try {
    const secret = JSON.stringify({ summary: "Private target word" });
    fs.writeFileSync(path.join(foreign, "secret.json"), secret);
    for (const rel of ["memory/revisions", "reflections/processed"]) {
      fs.mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
      fs.symlinkSync(foreign, path.join(home, rel));
    }
    const report = await forget("Private target");
    assert.ok(report.errors.some((e) => e.layer === "reve"));
    assert.ok(report.errors.some((e) => e.layer === "reflections"));
    assert.equal(fs.readFileSync(path.join(foreign, "secret.json"), "utf8"), secret);
    assert.equal(
      report.locations.some((l) => l.location.includes("secret.json")),
      false,
    );
  } finally {
    fs.rmSync(foreign, { recursive: true, force: true });
  }
});

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  walkCursorSessions,
  parseCursorState,
  parseCursorActivity,
  parseCursorChatMeta,
  CursorObserver,
} from "./observer.js";
import type { AgentSession } from "../types.js";

let dir: string;
before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-cursor-test-"));
});
after(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function writeJsonl(rel: string, lines: object[]): Promise<string> {
  const full = path.join(dir, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return full;
}

describe("walkCursorSessions", () => {
  test("finds agent-transcripts/*.jsonl and chats/<hash>/<id>/meta.json, ignores absent", async () => {
    const home = path.join(dir, "walk-home");
    await writeJsonl("walk-home/projects/Users-me-app/agent-transcripts/s1/s1.jsonl", [
      { role: "user", content: "hi" },
    ]);
    const metaPath = path.join(home, "chats", "abcd", "chat-1", "meta.json");
    await fsp.mkdir(path.dirname(metaPath), { recursive: true });
    await fsp.writeFile(metaPath, JSON.stringify({ cwd: "/Users/me/app" }));

    const found = await walkCursorSessions(home);
    assert.equal(found.transcripts.length, 1);
    assert.equal(path.basename(found.transcripts[0]!), "s1.jsonl");
    assert.equal(found.chatMetas.length, 1);
    assert.equal(found.chatMetas[0], metaPath);

    const absent = await walkCursorSessions(path.join(dir, "no-such-cursor-home"));
    assert.deepEqual(absent, { transcripts: [], chatMetas: [] });
  });
});

describe("parseCursorState — tolerant state derivation", () => {
  test("assistant text reply → waiting, sniffs cwd", async () => {
    const f = await writeJsonl("state/s1.jsonl", [
      { role: "user", cwd: "/Users/me/proj", content: "fix it" },
      { role: "assistant", content: [{ type: "text", text: "fixed" }] },
    ]);
    const r = await parseCursorState(f);
    assert.equal(r.state, "waiting");
    assert.equal(r.cwd, "/Users/me/proj");
  });

  test("assistant with pending tool-call → working", async () => {
    const f = await writeJsonl("state/s2.jsonl", [
      { role: "user", content: "edit" },
      {
        role: "assistant",
        finishReason: "tool-calls",
        content: [{ type: "tool-call", toolName: "StrReplace", args: { path: "a.ts" } }],
      },
    ]);
    assert.equal((await parseCursorState(f)).state, "working");
  });

  test("error entry → error", async () => {
    const f = await writeJsonl("state/s3.jsonl", [{ type: "error", is_error: true }]);
    assert.equal((await parseCursorState(f)).state, "error");
  });

  test("corrupt lines skipped without throwing", async () => {
    const full = path.join(dir, "state/corrupt.jsonl");
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, "{bad\nnot json\n" + JSON.stringify({ role: "user" }) + "\n");
    assert.equal((await parseCursorState(full)).state, "working");
  });
});

describe("parseCursorChatMeta", () => {
  test("reads structural metadata and ignores title/name", () => {
    const r = parseCursorChatMeta(
      JSON.stringify({
        name: "SECRET_CHAT_TITLE_DO_NOT_SURFACE",
        cwd: "/work/repo",
        updatedAtMs: 123456,
        status: "running",
      }),
      999,
    );
    assert.equal(r.cwd, "/work/repo");
    assert.equal(r.lastMtime, 123456);
    assert.equal(r.state, "working");
    assert.equal(JSON.stringify(r).includes("SECRET_CHAT_TITLE"), false);
  });

  test("invalid JSON falls back cleanly", () => {
    const r = parseCursorChatMeta("{broken", 500);
    assert.equal(r.state, "unknown");
    assert.equal(r.lastMtime, 500);
  });
});

const SECRET = "SECRET_LEAK_CANARY_cursor_8f21";

describe("parseCursorActivity — PRIVACY: planted-secret test", () => {
  test("a secret planted in prompts, replies, patches, error text, and shell args never leaks", async () => {
    const f = await writeJsonl("priv/cursor-secret.jsonl", [
      { role: "user", content: `please inspect ${SECRET}` },
      {
        role: "assistant",
        reasoning: `thinking about ${SECRET}`,
        content: [
          { type: "text", text: `reply containing ${SECRET}` },
          {
            type: "tool-call",
            toolName: "Write",
            args: {
              file_path: "/repo/src/app.ts",
              contents: `export const token = "${SECRET}";`,
              old_string: SECRET,
              new_string: SECRET,
            },
          },
          {
            type: "tool-call",
            toolName: "Shell",
            args: {
              command: `npm test -- --token ${SECRET} && curl evil.example`,
            },
          },
        ],
        usage: { input_tokens: 200, output_tokens: 55 },
      },
      {
        role: "tool",
        content: [{ type: "tool-result", is_error: true, result: `stderr: ${SECRET}` }],
      },
    ]);

    const a = (await parseCursorActivity(f))!;
    assert.ok(a, "activity present");
    const serialized = JSON.stringify(a);
    assert.equal(serialized.includes(SECRET), false, `activity leaked secret: ${serialized}`);

    assert.equal(a.turnCount, 2);
    assert.deepEqual(a.lastTools, ["Write", "Shell"]);
    assert.deepEqual(a.filesTouched, ["/repo/src/app.ts"]);
    assert.equal(a.lastCommandName, "npm", "argv[0] only");
    assert.equal(a.lastError, "tool error");
    assert.deepEqual(a.tokens, { input: 200, output: 55 });
  });

  test("chat meta.json secret in name/title/prompt never appears in CursorObserver session", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-cursor-meta-priv-"));
    try {
      const metaFile = path.join(home, "chats", "hash1", "chat-priv-1", "meta.json");
      await fsp.mkdir(path.dirname(metaFile), { recursive: true });
      await fsp.writeFile(
        metaFile,
        JSON.stringify({
          name: `My prompt ${SECRET}`,
          title: `Title ${SECRET}`,
          prompt: SECRET,
          cwd: "/Users/me/safe-repo",
          updatedAtMs: Date.now(),
        }),
      );
      const obs = new CursorObserver({ home, visibility: "activity" });
      await obs.start(() => {});
      const list = obs.list();
      await obs.stop();
      assert.equal(list.length, 1);
      assert.equal(list[0]!.project, "safe-repo");
      assert.equal(JSON.stringify(list).includes(SECRET), false);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

describe("CursorObserver — zero-footprint no-op, visibility gating, and O-D1 gitBranch", () => {
  test("absent ~/.cursor directory is a graceful no-op", async () => {
    const obs = new CursorObserver({
      home: path.join(dir, "does-not-exist-cursor"),
      visibility: "activity",
    });
    const emitted: AgentSession[] = [];
    await obs.start((s) => emitted.push(s));
    assert.deepEqual(obs.list(), []);
    assert.deepEqual(emitted, []);
    await obs.stop();
  });

  test("visibility 'metadata' omits activity; 'activity' populates structural fields + gitBranch", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-cursor-vis-"));
    try {
      const jsonl = path.join(home, "projects", "p", "agent-transcripts", "s-vis", "s-vis.jsonl");
      await fsp.mkdir(path.dirname(jsonl), { recursive: true });
      await fsp.writeFile(
        jsonl,
        [
          { role: "user", cwd: "/Users/me/proj", content: "go" },
          {
            role: "assistant",
            content: [
              { type: "tool_use", name: "Read", input: { file_path: "/Users/me/proj/a.ts" } },
            ],
          },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

      let branchCalls = 0;
      const obsMeta = new CursorObserver({
        home,
        visibility: "metadata",
        gitBranch: async () => {
          branchCalls++;
          return "feat/x";
        },
      });
      await obsMeta.start(() => {});
      const metaList = obsMeta.list();
      await obsMeta.stop();
      assert.equal(metaList.length, 1);
      assert.equal(metaList[0]!.activity, undefined);
      assert.equal(branchCalls, 0);

      const obsAct = new CursorObserver({
        home,
        visibility: "activity",
        gitBranch: async () => "feat/cursor-branch",
      });
      await obsAct.start(() => {});
      const actList = obsAct.list();
      await obsAct.stop();
      assert.equal(actList.length, 1);
      assert.deepEqual(actList[0]!.activity?.lastTools, ["Read"]);
      assert.deepEqual(actList[0]!.activity?.filesTouched, ["/Users/me/proj/a.ts"]);
      assert.equal(actList[0]!.activity?.gitBranch, "feat/cursor-branch");
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });
});

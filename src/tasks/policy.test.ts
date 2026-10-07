import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { homeScope } from "../paths.js";
import type { Provider, ProviderRunOpts } from "../providers/types.js";
import { buildToolRegistry } from "../tools/registry.js";
import { githubLinkTool } from "../tools/github_link.js";
import { reviewDiffTool } from "../tools/review_diff.js";
import type { ToolDefinition } from "../types.js";
import {
  denySideEffects,
  isSideEffectingCall,
  isVerifiedReadOnlyCall,
  taskToolset,
  TASK_TOOL_NAMES,
  UNATTENDED_DENIED,
  UNATTENDED_READ_ONLY,
} from "./policy.js";
import { TaskRunner } from "./runner.js";
import { createTask, getTask, loadRun } from "./store.js";

const fake = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute: async () => "",
});

test("every registered tool is either verified read-only or explicitly denied — a new tool forces a decision", () => {
  const names = buildToolRegistry({ includeVoice: true }).map((t) => t.name);
  const undecided = names.filter(
    (n) => !Object.hasOwn(UNATTENDED_READ_ONLY, n) && !Object.hasOwn(UNATTENDED_DENIED, n),
  );
  assert.deepEqual(
    undecided,
    [],
    "add each of these to UNATTENDED_READ_ONLY (after reading its execute()) or to UNATTENDED_DENIED in src/tasks/policy.ts",
  );
  const both = Object.keys(UNATTENDED_READ_ONLY).filter((n) => Object.hasOwn(UNATTENDED_DENIED, n));
  assert.deepEqual(both, [], "a tool cannot be on both lists");
  for (const name of TASK_TOOL_NAMES) assert.ok(Object.hasOwn(UNATTENDED_DENIED, name), name);
});

test("the default is deny: unknown, future and unlisted tools are side-effecting", () => {
  for (const name of [
    "some_plugin_tool",
    "mcp__server__read_everything",
    "a_builtin_added_next_year",
    "review_diff",
    "github_link",
    "repo_digest",
    "memory",
    "soul_journal",
    "kb_write",
    "set_mood",
    "constructor",
    "__proto__",
    "toString",
  ]) {
    assert.equal(isVerifiedReadOnlyCall(name, {}), false, name);
    assert.equal(isSideEffectingCall(name, {}), true, name);
    assert.equal((denySideEffects()(name, {}) as { allow: boolean }).allow, false, name);
  }
});

test("verified read-only tools pass; input-dependent ones only for their read-only inputs", () => {
  const gate = denySideEffects();
  const allowed = (name: string, input: unknown) => (gate(name, input) as { allow: boolean }).allow;
  for (const name of ["read", "grep", "ls", "web_fetch", "web_search", "kb_search", "soul_read"]) {
    assert.equal(allowed(name, { anything: "at all" }), true, name);
  }
  // github: reads yes, writes no, and nothing that could be read as a flag.
  assert.equal(allowed("github", { action: "pr_view", number: 12 }), true);
  assert.equal(allowed("github", { action: "issue_list", state: "closed" }), true);
  assert.equal(allowed("github", { action: "run_list" }), true);
  assert.equal(allowed("github", { action: "pr_merge", number: 12 }), false);
  assert.equal(allowed("github", { action: "issue_create", title: "x" }), false);
  assert.equal(allowed("github", { action: "pr_view", number: "--web" }), false);
  assert.equal(allowed("github", { action: "issue_list", state: "--web" }), false);
  assert.equal(allowed("github", { action: "something_new" }), false);
  assert.equal(allowed("github", {}), false);
  assert.equal(allowed("github", null), false);
  // soul history: the limit lands in a git argv.
  assert.equal(allowed("soul_history", { limit: 5 }), true);
  assert.equal(allowed("soul_history", {}), true);
  assert.equal(allowed("soul_diff", { limit: "5 --output=/tmp/x" }), false);
});

test("a run started by a watcher hit is offered what a remote channel is, and no more", () => {
  const surface = [
    "read",
    "web_fetch",
    "skill_manage",
    "kb_write",
    "kb_ingest",
    "bash",
    "memory",
    "task",
  ].map(fake);
  const names = (opts?: { untrustedInput?: boolean }, tools?: string[]) =>
    taskToolset(surface, tools ? { tools } : undefined, opts).map((t) => t.name);
  assert.deepEqual(names(), [
    "read",
    "web_fetch",
    "skill_manage",
    "kb_write",
    "kb_ingest",
    "bash",
    "memory",
  ]);
  assert.deepEqual(names({ untrustedInput: true }), ["read", "web_fetch", "memory"]);
  // An envelope cannot hand them back.
  assert.deepEqual(names({ untrustedInput: true }, ["read", "skill_manage", "bash"]), ["read"]);
});

// ── the reviewer's probes, as tests ──

function scripted(steps: Anthropic.ContentBlock[][]): {
  provider: Provider;
  calls: ProviderRunOpts[];
} {
  const calls: ProviderRunOpts[] = [];
  return {
    calls,
    provider: {
      name: "fake",
      async runTurn(o) {
        calls.push({ ...o, messages: [...o.messages] });
        const content = steps[calls.length - 1];
        if (!content) throw new Error("scripted provider exhausted");
        return {
          content,
          stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    },
  };
}

const NOW = Date.parse("2026-10-02T08:00:00Z");

async function runOnce(tools: ToolDefinition[], cwd: string, block: Anthropic.ContentBlock) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-tasks-policy-"));
  try {
    return await homeScope.run(home, async () => {
      const task = await createTask(
        {
          kind: "routine",
          title: "t",
          instruction: "i",
          origin: { kind: "api" },
          schedule: { expr: "daily:08:00", tz: "UTC" },
          enabled: true,
          state: "scheduled",
          nextRunAt: NOW,
        },
        NOW - 1,
      );
      const { provider } = scripted([
        [block],
        [{ type: "text", text: "done" } as Anthropic.ContentBlock],
      ]);
      const runner = new TaskRunner({
        tools,
        model: "m",
        cwd,
        provider,
        unattendedAllowed: () => true,
        log: () => {},
        now: () => NOW,
      });
      await runner.tick();
      await runner.drain();
      const loaded = (await loadRun(task.id, (await getTask(task.id))!.runs[0]!))!;
      return JSON.stringify(loaded.messages);
    });
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
}

test("review_diff cannot overwrite a file from an unattended run with no approval factory", async () => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "lisa-policy-git-"));
  try {
    const repo = path.join(sandbox, "repo");
    await fsp.mkdir(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    await fsp.writeFile(path.join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
    await fsp.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
    const victim = path.join(sandbox, "victim.conf");
    await fsp.writeFile(victim, "important user data\n");

    const transcript = await runOnce([reviewDiffTool], repo, {
      type: "tool_use",
      id: "tu_1",
      name: "review_diff",
      input: { cwd: repo, target: `--output=${victim}` },
    } as Anthropic.ContentBlock);

    assert.match(transcript, /\[denied\]/);
    assert.equal(await fsp.readFile(victim, "utf8"), "important user data\n");
  } finally {
    await fsp.rm(sandbox, { recursive: true, force: true });
  }
});

test("github_link is denied before it can open anything", async () => {
  let executed = false;
  const guarded = {
    ...(githubLinkTool as ToolDefinition),
    execute: async () => {
      executed = true;
      return "opened";
    },
  };
  const transcript = await runOnce([guarded], os.tmpdir(), {
    type: "tool_use",
    id: "tu_1",
    name: "github_link",
    input: { open: true },
  } as Anthropic.ContentBlock);
  assert.match(transcript, /\[denied\]/);
  assert.equal(executed, false);
});

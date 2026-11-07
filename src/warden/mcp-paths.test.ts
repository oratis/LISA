/**
 * MCP and other unlisted tools meet the same path checks as the builtin file
 * tools (#422 review round 3, NEW-3 — probe n146 N4).
 *
 * Only `path` / `file_path` used to count as paths, and MCP calls never had
 * their paths checked against the credential locations: with a chat-scoped
 * `auto` rule, `mcp__fs__move_file {destination: <home>/tasks/x.json}` and
 * `mcp__fs__write_file {filePath: …}` were allowed, a move onto
 * `<home>/warden/rules.json` got around the deny on Warden's own files, and
 * with no rule at all an MCP `read_file` of `<home>/warden/digest.key` or
 * `~/.ssh/id_ed25519` was allowed without asking.
 *
 * Real Warden session and inbox; nothing is executed. Temp homes only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { classifyToolCall } from "./classify.js";
import { WardenInbox } from "./inbox.js";
import { createWardenSession } from "./session.js";

// A temp HOME: `~/.ssh` below is never the real one.
const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-mcp-paths-home-")));
process.env.HOME = fakeHome;
process.env.LISA_HOME = path.join(fakeHome, ".lisa");
process.env.LISA_SECRETS_BACKEND = "file";

const mcp = (name: string, annotations?: ToolDefinition["annotations"]): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  ...(annotations ? { annotations } : {}),
  execute: async () => "",
});

const TOOLS = [
  mcp("mcp__fs__move_file"),
  mcp("mcp__fs__write_file"),
  mcp("mcp__fs__read_file", { readOnlyHint: true }),
  mcp("mcp__fs__read_text_file", { readOnlyHint: true }),
  mcp("mcp__fs__read_multiple_files", { readOnlyHint: true }),
  mcp("mcp__fs__apply_moves"),
  mcp("mcp__notes__save"),
  mcp("mcp__slack__post_message"),
];

async function withLisa<T>(
  rules: unknown,
  fn: (ctx: {
    home: string;
    proj: string;
    decide: (tool: string, input: unknown) => Promise<{ verdict: string; ruleId?: string }>;
  }) => Promise<T>,
): Promise<T> {
  const home = await fsp.mkdtemp(path.join(fakeHome, "lisa-"));
  const proj = path.join(home, "proj");
  await fsp.mkdir(proj);
  await fsp.mkdir(path.join(home, "tasks"), { recursive: true });
  await fsp.mkdir(path.join(home, "warden"), { recursive: true });
  if (rules) await fsp.writeFile(path.join(home, "warden", "rules.json"), JSON.stringify(rules));
  const inbox = new WardenInbox({ defaultTimeoutMs: 1 });
  try {
    return await fn({
      home,
      proj,
      decide: async (tool, input) => {
        const session = createWardenSession({
          surface: "local-web",
          uid: null,
          origin: { kind: "chat" },
          sandboxMode: "workspace-write",
          workspaceRoot: proj,
          inbox,
          home,
          log: () => {},
          tools: TOOLS,
        });
        const outcome = await session.decide(tool, input);
        return { verdict: outcome.verdict.verdict, ruleId: outcome.verdict.ruleId };
      },
    });
  } finally {
    await inbox.shutdown();
    await fsp.rm(home, { recursive: true, force: true });
  }
}

/** Every write tool on auto, chat-scoped — the probe's rules. */
const AUTO = {
  tools: {
    mcp__fs__move_file: "auto",
    mcp__fs__write_file: "auto",
    mcp__fs__apply_moves: "auto",
    mcp__notes__save: "auto",
    plugin_move: "auto",
  },
};

test("a move or write into the task files asks, whatever the argument is called (probe N4)", async () => {
  await withLisa(AUTO, async ({ home, proj, decide }) => {
    const file = path.join(home, "tasks", "t_aaaaaaaaaaaa.json");
    for (const [tool, input] of [
      ["mcp__fs__move_file", { source: path.join(proj, "x.json"), destination: file }],
      ["mcp__fs__write_file", { filePath: file, content: "{}" }],
      ["mcp__fs__write_file", { target: file.toUpperCase(), content: "{}" }],
      // Nested and in an array.
      ["mcp__fs__apply_moves", { moves: [{ from: path.join(proj, "x"), to: file }] }],
      ["mcp__fs__apply_moves", { batch: { ops: [[{ dst: `file://${file}` }]] } }],
      // Relative, on a filesystem tool: resolved against the workspace.
      ["mcp__fs__write_file", { filePath: "../tasks/t_aaaaaaaaaaaa.json", content: "{}" }],
      // `~/…`, on any tool.
      ["mcp__notes__save", { where: `~/${path.relative(fakeHome, file)}`, body: "x" }],
      // A tool that is not MCP at all, under an auto rule.
      ["plugin_move", { destination: file }],
    ] as const) {
      const d = await decide(tool, input);
      assert.equal(d.verdict, "ask", `${tool} ${JSON.stringify(input)}`);
      assert.equal(d.ruleId, "system:task-state-guard", `${tool} ${JSON.stringify(input)}`);
    }
    // The same rules still let an ordinary move in the project through.
    const ordinary = await decide("mcp__fs__move_file", {
      source: path.join(proj, "a.txt"),
      destination: path.join(proj, "b.txt"),
    });
    assert.equal(ordinary.verdict, "allow");
  });
});

test("a move onto Warden's own files is denied, as a builtin write is (probe N4)", async () => {
  await withLisa(AUTO, async ({ home, proj, decide }) => {
    const rules = path.join(home, "warden", "rules.json");
    for (const [tool, input] of [
      ["mcp__fs__move_file", { source: path.join(proj, "rules.json"), destination: rules }],
      ["mcp__fs__write_file", { uri: `file://${rules}`, content: "{}" }],
      ["mcp__fs__apply_moves", { moves: [{ src: path.join(proj, "g"), dest: [rules] }] }],
      ["plugin_move", { destination: path.join(home, "warden", "grants.json") }],
    ] as const) {
      const d = await decide(tool, input);
      assert.equal(d.verdict, "deny", `${tool} ${JSON.stringify(input)}`);
      assert.equal(d.ruleId, "system:warden-state-protected");
    }
  });
});

test("with no rule at all, an MCP read of the digest key or ~/.ssh asks (probe N4)", async () => {
  await withLisa(null, async ({ home, decide }) => {
    for (const [tool, input] of [
      ["mcp__fs__read_file", { path: path.join(home, "warden", "digest.key") }],
      ["mcp__fs__read_text_file", { path: path.join(home, "warden", "digest.key") }],
      ["mcp__fs__read_file", { path: path.join(fakeHome, ".ssh", "id_ed25519") }],
      ["mcp__fs__read_file", { path: "~/.ssh/id_ed25519" }],
      ["mcp__fs__read_file", { path: `file://${path.join(fakeHome, ".aws", "credentials")}` }],
      ["mcp__fs__read_multiple_files", { paths: ["/tmp/a.txt", "~/.ssh/id_ed25519"] }],
      ["mcp__fs__read_multiple_files", { request: { files: [{ p: "~/.netrc" }] } }],
    ] as const) {
      const d = await decide(tool, input);
      assert.equal(d.verdict, "ask", `${tool} ${JSON.stringify(input)}`);
      assert.equal(d.ruleId, "system:credential-path", `${tool} ${JSON.stringify(input)}`);
    }
    // An ordinary read is still a read.
    const ordinary = await decide("mcp__fs__read_file", { path: "/tmp/notes.txt" });
    assert.equal(ordinary.verdict, "allow");
  });
});

test("paths are resolved and listed as targets; free text and other tools' relative strings are not paths", () => {
  const ctx = {
    workspaceRoot: path.join(fakeHome, "proj"),
    sandboxMode: "workspace-write" as const,
    homeDir: fakeHome,
  };
  const move = classifyToolCall(
    "mcp__fs__move_file",
    { source: "a.txt", destination: "~/b.txt" },
    TOOLS[0],
    ctx,
  );
  assert.deepEqual(move.targets.sort(), [
    path.join(fakeHome, "b.txt"),
    path.join(fakeHome, "proj", "a.txt"),
  ]);
  // A message that quotes a path is a message: its text is not a target.
  const post = classifyToolCall(
    "mcp__slack__post_message",
    { channel: "general", text: "/Users/x/.ssh/id_ed25519" },
    TOOLS[7],
    ctx,
  );
  assert.deepEqual(post.targets, ["general"]);
  assert.equal(post.sensitivePath, false);
  // A relative string on a tool that is not about files is not a path either.
  const save = classifyToolCall("mcp__notes__save", { name: "a/b", body: "x" }, TOOLS[6], ctx);
  assert.equal(save.sensitivePath, false);
  assert.ok(!save.targets.some((t) => path.isAbsolute(t)), JSON.stringify(save.targets));
  // Too deep to look at whole: the call is treated as touching a sensitive location.
  let deep: unknown = "/tmp/x";
  for (let i = 0; i < 12; i++) deep = { next: deep };
  const nested = classifyToolCall("mcp__fs__read_file", { deep }, TOOLS[2], ctx);
  assert.equal(nested.sensitivePath, true);
  assert.equal(nested.targetsComplete, false);
});

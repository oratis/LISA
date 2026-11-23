import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { lisaGlobalHome } from "../paths.js";
import { classifyToolCall } from "./classify.js";
import { chatApprovalReason, chatPermissions, lisaCodeRoots } from "./chat-permissions.js";
import type { ActionRequest } from "./types.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-chat-perm-test-"));
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function action(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "act_1",
    at: "2026-11-23T00:00:00.000Z",
    uid: null,
    surface: "local-web",
    origin: { kind: "chat", id: "s1" },
    tool: "read",
    category: "read",
    targets: [],
    dataClasses: [],
    digest: "d".repeat(64),
    preview: "read",
    sandboxed: false,
    tainted: false,
    ...overrides,
  };
}

describe("chatPermissions", () => {
  test("maps server approval ceiling to allowed composer modes", () => {
    assert.deepEqual(chatPermissions("auto"), ["smart", "ask", "full"]);
    assert.deepEqual(chatPermissions("warden"), ["smart", "ask"]);
    assert.deepEqual(chatPermissions("ask"), ["ask"]);
    assert.deepEqual(chatPermissions("ask-mutating"), ["ask"]);
  });
});

describe("lisaCodeRoots", () => {
  test("discovers enclosing @oratis/lisa checkout and absolute LISA_SOURCE_ROOT", () => {
    const checkout = path.join(TMP, "checkout");
    const nested = path.join(checkout, "sub", "dir");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "@oratis/lisa" }));

    const unrelated = path.join(TMP, "other");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "package.json"), "{invalid-json");

    const source = path.join(TMP, "alt-source");
    fs.mkdirSync(source, { recursive: true });

    const prev = process.env.LISA_SOURCE_ROOT;
    try {
      process.env.LISA_SOURCE_ROOT = source;
      const roots = lisaCodeRoots(nested);
      assert.ok(roots.includes(checkout));
      assert.ok(roots.includes(source));

      process.env.LISA_SOURCE_ROOT = "relative/path";
      const otherRoots = lisaCodeRoots(unrelated);
      assert.ok(!otherRoots.includes("relative/path"));
      assert.ok(!otherRoots.includes(unrelated));
    } finally {
      if (prev === undefined) delete process.env.LISA_SOURCE_ROOT;
      else process.env.LISA_SOURCE_ROOT = prev;
    }
  });
});

describe("chatApprovalReason", () => {
  const basePolicy = {
    mode: "full" as const,
    codeRoots: ["/repo/lisa"],
  };

  test("requires explicit approval for redeploy, Lisa code roots, and Lisa global home", () => {
    assert.match(chatApprovalReason(action({ tool: "redeploy" }), basePolicy) ?? "", /Rebuild/);
    assert.match(
      chatApprovalReason(
        action({ tool: "edit", category: "write", targets: ["/repo/lisa/src/index.ts"] }),
        basePolicy,
      ) ?? "",
      /Lisa’s own files/,
    );
    assert.match(
      chatApprovalReason(
        action({
          tool: "write",
          category: "delete",
          targets: [path.join(lisaGlobalHome(), "config.env")],
        }),
        basePolicy,
      ) ?? "",
      /private state/,
    );
  });

  test("gates exec, host-hooked tools, host tools, and unknown tools while sparing skill_manage reads and connectorReads", () => {
    assert.match(
      chatApprovalReason(action({ tool: "bash", category: "exec" }), basePolicy) ?? "",
      /host code/,
    );
    assert.match(
      chatApprovalReason(action({ tool: "github", category: "read" }), basePolicy) ?? "",
      /host code/,
    );
    assert.equal(
      chatApprovalReason(action({ tool: "skill_manage", category: "read" }), basePolicy),
      undefined,
    );
    assert.match(
      chatApprovalReason(action({ tool: "skill_manage", category: "self" }), basePolicy) ?? "",
      /host code/,
    );
    assert.match(
      chatApprovalReason(action({ tool: "read", category: "read" }), {
        ...basePolicy,
        hostHookTools: new Set(["read"]),
      }) ?? "",
      /host code/,
    );
    assert.match(
      chatApprovalReason(action({ tool: "custom_plugin", category: "read" }), basePolicy) ?? "",
      /host code/,
    );
    assert.equal(
      chatApprovalReason(action({ tool: "steam_selected_games", category: "read" }), {
        ...basePolicy,
        connectorReads: new Set(["steam_selected_games"]),
      }),
      undefined,
    );
  });

  test("enforces ask mode and askAll ceiling", () => {
    assert.equal(
      chatApprovalReason(action({ tool: "read", category: "read", egress: false }), {
        ...basePolicy,
        mode: "ask",
      }),
      undefined,
    );
    assert.match(
      chatApprovalReason(action({ tool: "web_fetch", category: "read", egress: true }), {
        ...basePolicy,
        mode: "ask",
      }) ?? "",
      /chat permissions/,
    );
    assert.match(
      chatApprovalReason(action({ tool: "write", category: "write", targets: ["/tmp/x"] }), {
        ...basePolicy,
        mode: "ask",
      }) ?? "",
      /chat permissions/,
    );
    assert.match(
      chatApprovalReason(action({ tool: "read", category: "read" }), {
        ...basePolicy,
        mode: "ask",
        askAll: true,
      }) ?? "",
      /chat permissions/,
    );
    assert.equal(
      chatApprovalReason(action({ tool: "write", category: "write", targets: ["/tmp/x"] }), {
        ...basePolicy,
        mode: "smart",
      }),
      undefined,
    );
  });

  test("classifies newer read-only connector tools as reads only for allowed operations", () => {
    const ctx = { workspaceRoot: "/tmp/ws", sandboxMode: "workspace-write" as const };
    for (const [tool, op, egress] of [
      ["obsidian_read", "read", false],
      ["t3_read", "threads", true],
      ["game_library_import_read", "list", false],
      ["itch_owned_games", "read", true],
      ["steam_selected_games", "achievements", true],
    ] as const) {
      const ok = classifyToolCall(tool, { operation: op }, undefined, ctx);
      assert.equal(ok.category, "read", tool);
      assert.equal(ok.egress, egress, tool);
      assert.equal(ok.taintSource, true, tool);

      const bad = classifyToolCall(tool, { operation: "delete" }, undefined, ctx);
      assert.equal(bad.category, "write", tool);
    }
  });
});

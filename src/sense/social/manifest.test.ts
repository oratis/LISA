import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import {
  discoverSocialConnectors,
  parseSocialConnectorManifest,
  socialMcpToolName,
} from "./manifest.js";

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "bluesky-official",
    displayName: "Bluesky",
    platform: "bluesky",
    mcpServer: "bluesky",
    skill: "bluesky-publisher",
    tools: {
      listAccounts: "social_accounts_list",
      getCapabilities: "social_capabilities",
      validateDraft: "social_draft_validate",
      publish: "social_publish",
      getPublishStatus: "social_publish_status",
    },
  };
}

describe("social connector manifest", () => {
  test("parses a valid manifest and resolves MCP tool names", () => {
    const parsed = parseSocialConnectorManifest(validManifest());
    assert.equal(parsed.id, "bluesky-official");
    assert.equal(
      socialMcpToolName(parsed, "publish"),
      "mcp__bluesky__social_publish",
    );
  });

  test("fails closed on missing required publish operation", () => {
    const raw = validManifest();
    delete (raw.tools as Record<string, unknown>).publish;
    assert.throws(
      () => parseSocialConnectorManifest(raw),
      /"publish" must be a non-empty string/,
    );
  });

  test("rejects duplicate operation bindings", () => {
    const raw = validManifest();
    (raw.tools as Record<string, unknown>).validateDraft = "social_publish";
    assert.throws(
      () => parseSocialConnectorManifest(raw),
      /tool names must be unique/,
    );
  });

  test("discovers valid and surfaces invalid plugin manifests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-plugins-"));
    try {
      fs.mkdirSync(path.join(root, "good"));
      fs.writeFileSync(
        path.join(root, "good", "social-connector.json"),
        JSON.stringify(validManifest()),
      );
      fs.mkdirSync(path.join(root, "bad"));
      fs.writeFileSync(
        path.join(root, "bad", "social-connector.json"),
        JSON.stringify({ schemaVersion: 99 }),
      );
      const found = await discoverSocialConnectors(root);
      assert.deepEqual(
        found.map((item) => [item.plugin, Boolean(item.manifest), Boolean(item.error)]),
        [
          ["bad", false, true],
          ["good", true, false],
        ],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

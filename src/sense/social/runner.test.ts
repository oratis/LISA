import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ToolDefinition } from "../../types.js";
import {
  approveSocialDraft,
  createSocialDraft,
  getSocialDraft,
  requestSocialDraftApproval,
} from "./drafts.js";
import { publishApprovedSocialDraft } from "./runner.js";
import { bundledConnectorManifest } from "./connectors/plugin.js";
import { setSocialPublishingPaused } from "./policy.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-runner-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function fake(name: string, output: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    async execute() { return JSON.stringify(output); },
  };
}

test("runner alone consumes approval and invokes hidden validate/publish tools", async () => {
  const draft = await createSocialDraft({
    targets: [{
      connectorId: "bluesky-official",
      accountId: "did:plc:test",
      platform: "bluesky",
    }],
    canonical: { text: "hello", media: [] },
  }, 1000);
  const requested = await requestSocialDraftApproval(draft.id, 1, 2000);
  await approveSocialDraft(draft.id, requested.digest, 3000);
  let now = 4000;
  const finished = await publishApprovedSocialDraft(draft.id, requested.digest, {
    connectors: [{
      plugin: "test",
      manifestPath: "/test",
      manifest: bundledConnectorManifest("bluesky"),
    }],
    connectorTools: [
      fake("mcp__bluesky__social_draft_validate", { ok: true, errors: [] }),
      fake("mcp__bluesky__social_publish", {
        ok: true,
        platformPostId: "at://post",
      }),
    ],
    now: () => now++,
  });
  assert.equal(finished.state, "published");
  assert.equal(finished.outcomes?.[0]?.platformPostId, "at://post");
  const audit = fs.readFileSync(
    path.join(home, "sense", "social", "audit.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(audit, /hello/);
  assert.match(audit, /at:\/\/post/);
});

test("pause switch blocks before an approval is consumed", async () => {
  const draft = await createSocialDraft({
    targets: [{
      connectorId: "mastodon-official",
      accountId: "account",
      platform: "mastodon",
    }],
    canonical: { text: "paused", media: [] },
  });
  const requested = await requestSocialDraftApproval(draft.id, 1);
  await approveSocialDraft(draft.id, requested.digest);
  await setSocialPublishingPaused(true);
  await assert.rejects(
    publishApprovedSocialDraft(draft.id, requested.digest, {
      connectorTools: [],
      connectors: [],
    }),
    /publishing is paused/,
  );
  assert.equal((await getSocialDraft(draft.id))?.state, "approved");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { socialComposeTool } from "./tool.js";

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-tool-"));
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function call(input: unknown): Promise<unknown> {
  const text = await socialComposeTool.execute(
    input as never,
    {} as never,
  );
  return JSON.parse(text);
}

describe("social_compose tool", () => {
  test("creates, updates, and requests confirmation without a publish action", async () => {
    const created = (await call({
      action: "new_draft",
      draft: {
        targets: [
          {
            connectorId: "bluesky-official",
            accountId: "alice",
            platform: "bluesky",
          },
        ],
        canonical: { text: "hello", media: [] },
      },
    })) as { id: string; revision: number };
    assert.equal(created.revision, 1);

    const updated = (await call({
      action: "update_draft",
      id: created.id,
      expectedRevision: 1,
      patch: { canonical: { text: "hello world", media: [] } },
    })) as { revision: number };
    assert.equal(updated.revision, 2);

    const preview = (await call({
      action: "request_confirmation",
      id: created.id,
      expectedRevision: 2,
    })) as { approvalDigest: string; instruction: string };
    assert.equal(preview.approvalDigest.length, 64);
    assert.match(preview.instruction, /Publishing remains blocked/);
    assert.doesNotMatch(
      JSON.stringify(socialComposeTool.inputSchema),
      /"publish"/,
    );
    assert.match(
      JSON.stringify(socialComposeTool.inputSchema),
      /"stage_media"/,
    );
  });
});

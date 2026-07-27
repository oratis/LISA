import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleSocialApi } from "./social-api.js";

let home: string;
let previousHome: string | undefined;
let server: http.Server;
let origin: string;

beforeEach(async () => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-social-api-"));
  process.env.LISA_HOME = home;
  server = http.createServer((req, res) => {
    void handleSocialApi(req, res, req.url ?? "/", {
      allowApproval: req.headers["x-local-owner"] === "1",
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("social API", () => {
  test("draft preview can be prepared remotely but approval needs a trusted caller", async () => {
    const createdResponse = await fetch(`${origin}/api/sense/social/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targets: [
          {
            connectorId: "mastodon-official",
            accountId: "alice@example.social",
            platform: "mastodon",
          },
        ],
        canonical: { text: "hello", media: [] },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as {
      draft: { id: string };
    };

    const previewResponse = await fetch(
      `${origin}/api/sense/social/drafts/${created.draft.id}/request-approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    );
    const preview = (await previewResponse.json()) as {
      approvalDigest: string;
    };
    assert.equal(preview.approvalDigest.length, 64);

    const denied = await fetch(
      `${origin}/api/sense/social/drafts/${created.draft.id}/approve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest: preview.approvalDigest }),
      },
    );
    assert.equal(denied.status, 403);

    const listedResponse = await fetch(
      `${origin}/api/sense/social/drafts`,
    );
    const listed = (await listedResponse.json()) as {
      drafts: Array<{ approvalDigest?: string }>;
    };
    assert.equal(listed.drafts[0]?.approvalDigest, preview.approvalDigest);

    const approved = await fetch(
      `${origin}/api/sense/social/drafts/${created.draft.id}/approve`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-local-owner": "1",
        },
        body: JSON.stringify({ digest: preview.approvalDigest }),
      },
    );
    assert.equal(approved.status, 200);
  });
});

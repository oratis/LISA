import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handleImproveApi } from "./improve-api.js";
import { SessionStore } from "../sessions/store.js";
import { homeScope } from "../paths.js";

async function startTestServer(opts: {
  home: string;
  allowChange: boolean;
  loopbackTrust: boolean;
}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    void handleImproveApi(req, res, req.url ?? "/", {
      home: opts.home,
      cwd: opts.home,
      model: "claude-sonnet-4-6",
      allowChange: opts.allowChange,
      loopbackTrust: opts.loopbackTrust,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  assert.ok(addr && typeof addr !== "string");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

describe("handleImproveApi", () => {
  test("full HTTP lifecycle creates kind=improvement session and enforces digest/CSRF/trust", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-improve-api-"));
    const srv = await startTestServer({ home: tmp, allowChange: true, loopbackTrust: true });
    try {
      // Cross-site request is rejected even on GET
      const cross = await fetch(`${srv.baseUrl}/api/improve`, {
        headers: { "sec-fetch-site": "cross-site" },
      });
      assert.equal(cross.status, 403);

      // Non-JSON POST is rejected with 415
      const badType = await fetch(`${srv.baseUrl}/api/improve`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      });
      assert.equal(badType.status, 415);

      // Malformed files array returns 400
      const badFiles = await fetch(`${srv.baseUrl}/api/improve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Bad", goal: "Bad", files: [{ path: 123 }] }),
      });
      assert.equal(badFiles.status, 400);

      // Create draft -> creates dedicated kind="improvement" session inside opts.home
      const createdRes = await fetch(`${srv.baseUrl}/api/improve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Daily summary skill",
          goal: "Format daily updates cleanly",
          kind: "skill",
          originSessionId: "chat-orig-1",
        }),
      });
      assert.equal(createdRes.status, 201);
      const created = (await createdRes.json()) as {
        record: { id: string; sessionId?: string };
        sessionId: string;
      };
      assert.ok(created.record.id);
      const sess = await homeScope.run(tmp, () => SessionStore.open(created.sessionId));
      assert.equal(sess.header.kind, "improvement");
      assert.equal(sess.header.originSessionId, "chat-orig-1");

      // Preview
      const prevRes = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rebaseToCurrentProfile: true }),
      });
      assert.equal(prevRes.status, 200);
      const prev = (await prevRes.json()) as {
        record: { workStatus: string; changeSet?: { digest: string } };
      };
      assert.equal(prev.record.workStatus, "preview_ready");
      const digest = prev.record.changeSet?.digest ?? "";
      assert.ok(digest.length > 10);

      // Wrong digest returns 409
      const badApply = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest: "wrong" }),
      });
      assert.equal(badApply.status, 409);

      // Apply with matching digest
      const applyRes = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digest }),
      });
      assert.equal(applyRes.status, 200);

      // Rollback
      const rbRes = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}/rollback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(rbRes.status, 200);

      // Export
      const expRes = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(expRes.status, 200);
      const exp = (await expRes.json()) as { contribution: { compareUrl: string } };
      assert.match(exp.contribution.compareUrl, /^https:\/\/github\.com\//);

      // GET detail
      const getRes = await fetch(`${srv.baseUrl}/api/improve/${created.record.id}`);
      assert.equal(getRes.status, 200);
    } finally {
      await srv.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects mutations when allowChange is false", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-improve-readonly-"));
    const srv = await startTestServer({ home: tmp, allowChange: false, loopbackTrust: false });
    try {
      const getRes = await fetch(`${srv.baseUrl}/api/improve`);
      assert.equal(getRes.status, 200);
      const postRes = await fetch(`${srv.baseUrl}/api/improve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No", goal: "No" }),
      });
      assert.equal(postRes.status, 403);
    } finally {
      await srv.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

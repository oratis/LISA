import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { homeScope, memoryDir, reflectionsDir } from "../paths.js";
import { writeMemory, readMemory, appendMemory } from "../memory/store.js";
import { evidenceFromHistory } from "../memory/evidence.js";
import { createMemoryReview, applyMemoryReview } from "../memory/review.js";
import { recordAutonomyRun } from "../autonomy/runs.js";
import { kbGraphFile } from "../kb/paths.js";
import { buildReveOverview } from "./reve-overview.js";
import { handleReveApi } from "./reve-api.js";

async function fixture(session = "s1") {
  await writeMemory("user", "- Reply in English\n- Preserve this");
  const evidence = evidenceFromHistory(
    [{ role: "user", content: "Please always reply in Chinese." }],
    session,
  );
  return applyMemoryReview(await createMemoryReview("user", evidence), [
    {
      kind: "replace",
      old_text: "Reply in English",
      new_text: "Reply in Chinese",
      reason: "Explicit language correction",
      evidence: [{ id: evidence[0]!.id, quote: evidence[0]!.text }],
    },
  ]);
}

test("overview and restore are scoped, audited, owner-only and reject stale writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-reve-api-"));
  let tenant = "a",
    allowRead = true,
    allowRestore = true;
  const opts = () => ({
    allowed: allowRead,
    allowApproval: allowRestore,
    loopbackTrust: true,
    reflectionEnabled: false,
  });
  const server = http.createServer((req, res) => {
    void homeScope.run(path.join(dir, tenant), async () => {
      if (!(await handleReveApi(req, res, req.url!, opts()))) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body = "{}", headers: Record<string, string> = {}) =>
    fetch(base + route, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  try {
    const revision = await homeScope.run(path.join(dir, "a"), () => fixture());
    await homeScope.run(path.join(dir, "a"), () =>
      recordAutonomyRun({
        kind: "reflect",
        startedAt: new Date().toISOString(),
        durationMs: 12,
        inputTokens: 3,
        outputTokens: 90,
        cacheReadTokens: 1000,
        cacheWriteTokens: 20,
        outcome: "done",
      }),
    );
    const response = await fetch(base + "/api/reve");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const overview = await response.json();
    assert.equal(overview.stats.corrections, 1);
    assert.equal(overview.stats.usage.cacheReadTokens, 1000);
    assert.equal(overview.reflectionEnabled, false);
    assert.equal(overview.revisions[0].canRestore, true);
    const route = `/api/reve/revisions/${revision.revisionId}`;
    assert.equal((await (await fetch(base + route)).json()).sources[0].sessionId, "s1");
    for (const headers of [
      { origin: "https://hostile.example" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      assert.equal(
        (await post(route + "/restore", "{}", headers)).status,
        403,
        JSON.stringify(headers),
      );
    }
    assert.equal(
      (await post(route + "/restore", "{}", { "content-type": "text/plain" })).status,
      415,
    );
    assert.equal((await post(route + "/restore", "{")).status, 400);
    assert.equal((await post(route + "/restore", JSON.stringify("x".repeat(600)))).status, 413);
    const rebound = await new Promise<number>((resolve) => {
      http.get(base + route, { headers: { host: "hostile.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
    });
    assert.equal(rebound, 403);
    allowRestore = false;
    assert.equal((await post(route + "/restore")).status, 403);
    assert.equal((await (await fetch(base + route)).json()).canRestore, false);
    allowRestore = true;
    allowRead = false;
    assert.equal((await fetch(base + "/api/reve")).status, 403);
    allowRead = true;
    tenant = "b";
    assert.equal((await fetch(base + route)).status, 404);
    assert.equal((await (await fetch(base + "/api/reve")).json()).revisions.length, 0);
    tenant = "a";
    assert.equal((await post(route + "/restore")).status, 200);
    assert.match(
      await homeScope.run(path.join(dir, "a"), () => readMemory("user")),
      /Reply in English/,
    );
    assert.equal((await (await fetch(base + "/api/reve")).json()).revisions.length, 2);
    const newer = await homeScope.run(path.join(dir, "a"), async () => {
      const r = await fixture("s2");
      await appendMemory("user", "A newer fact");
      return r;
    });
    assert.equal((await post(`/api/reve/revisions/${newer.revisionId}/restore`)).status, 409);
    assert.match(
      await homeScope.run(path.join(dir, "a"), () => readMemory("user")),
      /A newer fact/,
    );
    const legacy = await homeScope.run(path.join(dir, "a"), async () => {
      const oldText = "x".repeat(2200);
      await fs.writeFile(path.join(memoryDir(), "USER.md"), oldText);
      const evidence = evidenceFromHistory(
        [{ role: "user", content: "Please keep the short version." }],
        "shorten",
      );
      return applyMemoryReview(await createMemoryReview("user", evidence), [
        {
          kind: "replace",
          old_text: oldText,
          new_text: "short version",
          reason: "The user requested the short version",
          evidence: [{ id: evidence[0]!.id, quote: evidence[0]!.text }],
        },
      ]);
    });
    const legacyRoute = `/api/reve/revisions/${legacy.revisionId}`;
    assert.equal((await (await fetch(base + legacyRoute)).json()).canRestore, false);
    const revisions = (await (await fetch(base + "/api/reve")).json()).revisions;
    assert.equal(
      revisions.find((r: { id: string }) => r.id === legacy.revisionId).canRestore,
      false,
    );
    assert.equal((await post(legacyRoute + "/restore")).status, 409);
    await homeScope.run(path.join(dir, "a"), () =>
      fs.writeFile(path.join(memoryDir(), "revisions", `${revision.revisionId}.json`), "{"),
    );
    assert.equal((await fetch(base + route)).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an unreadable section is marked unavailable without hiding good sections", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-reve-partial-"));
  try {
    await homeScope.run(dir, async () => {
      await fixture();
      await fs.mkdir(path.dirname(kbGraphFile()), { recursive: true });
      await fs.writeFile(kbGraphFile(), "{");
      const result = await buildReveOverview(999);
      assert.equal(result.days, 30);
      assert.equal(result.knowledge, null);
      assert.deepEqual(result.partial, ["knowledge"]);
      assert.equal(result.revisions.length, 1);
      assert.equal(result.stats.usage.incompleteCacheRuns, 0);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("overview excludes linked reflection or KB files outside the active home", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-reve-links-"));
  try {
    await homeScope.run(path.join(dir, "alice"), async () => {
      const other = path.join(dir, "other-data.json");
      await fs.writeFile(other, JSON.stringify({ summary: "belongs to another home" }));
      await fs.mkdir(reflectionsDir(), { recursive: true });
      await fs.symlink(other, path.join(reflectionsDir(), "linked.json"));
      await fs.mkdir(path.dirname(kbGraphFile()), { recursive: true });
      await fs.symlink(other, kbGraphFile());
      const result = await buildReveOverview();
      assert.equal(result.reflections.length, 0);
      assert.equal(result.knowledge, null);
      assert.deepEqual(result.partial, ["knowledge"]);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

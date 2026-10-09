import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

process.env.LISA_SOUL_GIT = "0";
process.env.LISA_KB_NO_GIT = "1";

const { handleReveApi } = await import("./reve-api.js");
const { homeScope, homeForUid } = await import("../paths.js");
const { withDream } = await import("../reve/record.js");
const { listDreams } = await import("../reve/store.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");

let root: string;
let previousHome: string | undefined;
let server: http.Server;
let origin: string;

/** Mirrors server.ts: a signed-in cloud request runs inside its uid's home scope. */
beforeEach(async () => {
  previousHome = process.env.LISA_HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-api-"));
  process.env.LISA_HOME = root;
  server = http.createServer((req, res) => {
    const uid = req.headers["x-test-uid"];
    const run = () =>
      handleReveApi(req, res, req.url ?? "/", {
        allowed: req.headers["x-test-anon-cloud"] !== "1",
        now: () => new Date(),
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    if (typeof uid === "string") void homeScope.run(homeForUid(uid), run);
    else void run();
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
  fs.rmSync(root, { recursive: true, force: true });
});

async function dreamFor(uid: string): Promise<string> {
  return await homeScope.run(homeForUid(uid), async () => {
    fs.mkdirSync(path.join(homeForUid(uid), "memory"), { recursive: true });
    fs.writeFileSync(path.join(homeForUid(uid), "memory", "MEMORY.md"), `- ${uid} memory\n`);
    await withDream({ trigger: "idle" }, async () => {
      await appendMemory("memory", `${uid} learned something`);
      await soulStore.writeIdentity(`I am Lisa for ${uid}.`);
    });
    return (await listDreams(1)).dreams[0]!.id;
  });
}

async function call(
  method: string,
  url: string,
  opts: { uid?: string; body?: unknown; contentType?: string; anonCloud?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.uid) headers["x-test-uid"] = opts.uid;
  if (opts.anonCloud) headers["x-test-anon-cloud"] = "1";
  if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "application/json";
  const res = await fetch(origin + url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("reve API", () => {
  test("lists, shows, reverts and asks to reconsider within one tenant", async () => {
    const id = await dreamFor("alice");
    const list = await call("GET", "/api/reve/dreams?limit=5", { uid: "alice" });
    assert.equal(list.status, 200);
    const dreams = list.body.dreams as Array<Record<string, unknown>>;
    assert.equal(dreams.length, 1);
    assert.equal(dreams[0]!.id, id);
    assert.deepEqual(dreams[0]!.revertibleParts, ["memory"]);

    const show = await call("GET", `/api/reve/dreams/${id}`, { uid: "alice" });
    assert.equal(show.status, 200);
    assert.equal((show.body.dream as { id: string }).id, id);

    const soul = await call("POST", `/api/reve/dreams/${id}/revert`, {
      uid: "alice",
      body: { parts: ["soul"] },
    });
    assert.equal(soul.status, 400, "the soul is never user-revertible");

    const rv = await call("POST", `/api/reve/dreams/${id}/revert`, {
      uid: "alice",
      body: { parts: ["memory"] },
    });
    assert.equal(rv.status, 200);
    assert.deepEqual(rv.body.reverted, ["memory/MEMORY.md"]);
    const aliceHome = homeForUid("alice");
    assert.equal(
      fs.readFileSync(path.join(aliceHome, "memory", "MEMORY.md"), "utf8"),
      "- alice memory\n",
    );
    assert.equal(
      fs.readFileSync(path.join(aliceHome, "soul", "identity.md"), "utf8"),
      "I am Lisa for alice.\n",
    );

    const rc = await call("POST", `/api/reve/dreams/${id}/reconsider`, {
      uid: "alice",
      body: { note: "that identity line is not you" },
    });
    assert.equal(rc.status, 201);
    const queue = await call("GET", "/api/reve/reconsider", { uid: "alice" });
    assert.equal((queue.body.requests as unknown[]).length, 1);

    const metrics = await call("GET", "/api/reve/metrics?days=3", { uid: "alice" });
    assert.equal(metrics.status, 200);
    assert.equal((metrics.body.totals as { dreams: number }).dreams, 1);
    assert.equal((metrics.body.series as unknown[]).length, 3);
  });

  test("tenant isolation: uid B can never read, revert or reconsider uid A's dream", async () => {
    const id = await dreamFor("alice");
    await dreamFor("bob");
    const aliceMem = path.join(homeForUid("alice"), "memory", "MEMORY.md");
    const before = fs.readFileSync(aliceMem, "utf8");

    const list = await call("GET", "/api/reve/dreams", { uid: "bob" });
    assert.ok(!(list.body.dreams as Array<{ id: string }>).some((d) => d.id === id));
    assert.equal((await call("GET", `/api/reve/dreams/${id}`, { uid: "bob" })).status, 404);
    assert.equal(
      (
        await call("POST", `/api/reve/dreams/${id}/revert`, {
          uid: "bob",
          body: { parts: ["memory"] },
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("POST", `/api/reve/dreams/${id}/reconsider`, { uid: "bob", body: { note: "x" } }))
        .status,
      404,
    );
    assert.equal(fs.readFileSync(aliceMem, "utf8"), before, "alice's memory untouched");
    assert.equal(fs.existsSync(path.join(homeForUid("alice"), "reve", "reconsider.json")), false);
    // Bob's own reconsider queue never shows alice's requests either.
    await call("POST", `/api/reve/dreams/${id}/reconsider`, {
      uid: "alice",
      body: { note: "mine" },
    });
    const bobQueue = await call("GET", "/api/reve/reconsider", { uid: "bob" });
    assert.deepEqual(bobQueue.body.requests, []);
  });

  test("a cloud caller without an account is refused", async () => {
    const res = await call("GET", "/api/reve/dreams", { anonCloud: true });
    assert.equal(res.status, 403);
  });

  test("rejects crafted ids, non-JSON bodies and bad methods", async () => {
    const id = await dreamFor("alice");
    assert.equal(
      (await call("GET", "/api/reve/dreams/..%2F..%2Fsoul", { uid: "alice" })).status,
      404,
    );
    assert.equal((await call("GET", "/api/reve/dreams/d-1-2", { uid: "alice" })).status, 404);
    const plain = await call("POST", `/api/reve/dreams/${id}/revert`, {
      uid: "alice",
      body: { parts: ["memory"] },
      contentType: "text/plain",
    });
    assert.equal(plain.status, 415);
    assert.equal((await call("DELETE", `/api/reve/dreams/${id}`, { uid: "alice" })).status, 405);
    const empty = await call("POST", `/api/reve/dreams/${id}/reconsider`, {
      uid: "alice",
      body: { note: "" },
    });
    assert.equal(empty.status, 400);
  });

  test("concurrent modification → 409, then force → 200", async () => {
    const page = path.join(homeForUid("alice"), "kb", "wiki", "a.md");
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, "# A\n");
    const id = await homeScope.run(homeForUid("alice"), async () => {
      await withDream({ trigger: "idle" }, async () => {
        fs.writeFileSync(page, "# A, by Lisa\n");
      });
      return (await listDreams(1)).dreams[0]!.id;
    });
    fs.writeFileSync(page, "# A, by the user\n");
    const conflict = await call("POST", `/api/reve/dreams/${id}/revert`, {
      uid: "alice",
      body: { parts: ["kb"] },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error, "revert_conflict");
    const forced = await call("POST", `/api/reve/dreams/${id}/revert`, {
      uid: "alice",
      body: { parts: ["kb"], force: true },
    });
    assert.equal(forced.status, 200);
    assert.equal(fs.readFileSync(page, "utf8"), "# A\n");
  });

  test("a corrupt dream file is reported, not fatal", async () => {
    const id = await dreamFor("alice");
    fs.writeFileSync(path.join(homeForUid("alice"), "reve", "dreams", `${id}.json`), "{oops");
    const list = await call("GET", "/api/reve/dreams", { uid: "alice" });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.corrupt, [id]);
    assert.equal((await call("GET", `/api/reve/dreams/${id}`, { uid: "alice" })).status, 422);
  });
});

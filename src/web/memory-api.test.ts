import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, test } from "node:test";
import { handleMemoryApi } from "./memory-api.js";
import { readTar } from "../sovereignty/tar.js";

let home: string;
let previousHome: string | undefined;
let server: http.Server;
let origin: string;

/**
 * The harness stands in for server.ts's auth gate: tests declare the caller
 * with x-test-* headers (cloud edition, signed-in uid, loopback peer).
 */
beforeEach(async () => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-memory-api-"));
  process.env.LISA_HOME = home;
  server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleMemoryApi(req, res, req.url ?? "/", {
        cloud: req.headers["x-test-cloud"] === "1",
        accountUid: (req.headers["x-test-uid"] as string | undefined) ?? null,
        loopback: req.headers["x-test-remote"] !== "1",
      });
      if (!handled) {
        res.writeHead(404);
        res.end("unhandled");
      }
    })();
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

function write(rel: string, content: string, base = home): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function read(rel: string, base = home): string {
  return fs.readFileSync(path.join(base, rel), "utf8");
}

interface Caller {
  cloud?: boolean;
  uid?: string;
  remote?: boolean;
  headers?: Record<string, string>;
}

function headersFor(c: Caller = {}): Record<string, string> {
  return {
    ...(c.cloud ? { "x-test-cloud": "1" } : {}),
    ...(c.uid ? { "x-test-uid": c.uid } : {}),
    ...(c.remote ? { "x-test-remote": "1" } : {}),
    ...c.headers,
  };
}

async function call(
  method: string,
  url: string,
  body?: unknown,
  c: Caller = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${url}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headersFor(c),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

interface Entry {
  id: string;
  text: string;
  store: string;
}
interface StoreView {
  store: string;
  entries: Entry[];
  corrupt: boolean;
}

async function entries(c: Caller = {}): Promise<StoreView[]> {
  const r = await call("GET", "/api/memory/entries", undefined, c);
  assert.equal(r.status, 200);
  return r.json.stores as StoreView[];
}

async function exportFiles(url: string, c: Caller = {}): Promise<Map<string, string>> {
  const res = await fetch(`${origin}${url}`, { headers: headersFor(c) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="lisa-export-/);
  const gz = Buffer.from(await res.arrayBuffer());
  const files = new Map<string, string>();
  let cur: { path: string; parts: Buffer[] } | null = null;
  async function* src() {
    yield zlib.gunzipSync(gz);
  }
  await readTar(
    src(),
    {
      begin(h) {
        cur = { path: h.path, parts: [] };
      },
      data(chunk) {
        cur!.parts.push(Buffer.from(chunk));
      },
      end() {
        files.set(cur!.path, Buffer.concat(cur!.parts).toString("utf8"));
      },
    },
    { maxFileBytes: 1 << 24, maxTotalBytes: 1 << 26, maxEntries: 1000 },
  );
  return files;
}

describe("memory entries API (Mac edition)", () => {
  test("list, append, replace and delete as the loopback owner", async () => {
    write("memory/MEMORY.md", "- one\n- two\n");
    write("memory/USER.md", "- likes tea\n");
    const [mem, user] = await entries();
    assert.equal(mem!.store, "memory");
    assert.deepEqual(
      mem!.entries.map((e) => e.text),
      ["one", "two"],
    );
    assert.deepEqual(
      user!.entries.map((e) => e.text),
      ["likes tea"],
    );

    const added = await call("POST", "/api/memory/entries", {
      store: "user",
      text: "prefers mornings",
    });
    assert.equal(added.status, 201);
    assert.equal((added.json.entry as Entry).text, "prefers mornings");

    const two = mem!.entries[1]!;
    const put = await call("PUT", `/api/memory/entries/${two.id}`, { text: "TWO" });
    assert.equal(put.status, 200);
    assert.equal(read("memory/MEMORY.md"), "- one\n- TWO\n");

    const del = await call("DELETE", `/api/memory/entries/${mem!.entries[0]!.id}`);
    assert.equal(del.status, 200);
    assert.equal(read("memory/MEMORY.md"), "- TWO\n");
    assert.equal(read("memory/USER.md"), "- likes tea\n- prefers mornings\n");

    // A stale id (its entry changed) is a 404, not a silent overwrite.
    assert.equal((await call("PUT", `/api/memory/entries/${two.id}`, { text: "x" })).status, 404);
    assert.equal((await call("DELETE", "/api/memory/entries/%2e%2e%2fsoul")).status, 404);
    assert.equal((await call("DELETE", "/api/memory/entries/%zz")).status, 404);
  });

  test("validates bodies and enforces the byte caps", async () => {
    assert.equal(
      (await call("POST", "/api/memory/entries", { store: "nope", text: "x" })).status,
      400,
    );
    assert.equal(
      (await call("POST", "/api/memory/entries", { store: "memory", text: "  " })).status,
      400,
    );
    assert.equal(
      (await call("POST", "/api/memory/entries", { store: "memory", text: 5 })).status,
      400,
    );
    const plain = await fetch(`${origin}/api/memory/entries`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ store: "memory", text: "csrf" }),
    });
    assert.equal(plain.status, 415);
    const huge = await call("POST", "/api/memory/entries", {
      store: "memory",
      text: "x".repeat(70_000),
    });
    assert.equal(huge.status, 413);
    const full = await call("POST", "/api/memory/entries", {
      store: "user",
      text: "y".repeat(2100),
    });
    assert.equal(full.status, 413);
    assert.equal(full.json.error, "memory_full");
  });

  test("concurrent appends never lose an entry (shared memory lock)", async () => {
    const { appendMemory } = await import("../memory/store.js");
    const N = 12;
    await Promise.all([
      ...Array.from({ length: N }, (_, i) =>
        call("POST", "/api/memory/entries", { store: "memory", text: `api ${i}` }),
      ),
      ...Array.from({ length: 4 }, (_, i) => appendMemory("memory", `tool ${i}`)),
    ]);
    const [mem] = await entries();
    assert.equal(mem!.entries.length, N + 4);
  });

  test("a corrupt MEMORY.md is listed (flagged) but never rewritten", async () => {
    fs.mkdirSync(path.join(home, "memory"), { recursive: true });
    const bad = Buffer.from([0x2d, 0x20, 0x6f, 0x6b, 0x0a, 0x2d, 0x20, 0xc3, 0x28, 0x0a]);
    fs.writeFileSync(path.join(home, "memory", "MEMORY.md"), bad);
    const [mem] = await entries();
    assert.equal(mem!.corrupt, true);
    assert.equal(mem!.entries.length, 2);
    const r = await call("DELETE", `/api/memory/entries/${mem!.entries[0]!.id}`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "memory_corrupt");
    assert.ok(fs.readFileSync(path.join(home, "memory", "MEMORY.md")).equals(bad));
  });

  test("a remote device is read-only; cross-site and rebinding requests are refused", async () => {
    write("memory/MEMORY.md", "- one\n");
    assert.equal((await entries({ remote: true }))[0]!.entries.length, 1);
    const w = await call(
      "POST",
      "/api/memory/entries",
      { store: "memory", text: "x" },
      { remote: true },
    );
    assert.equal(w.status, 403);
    assert.equal(w.json.error, "owner_required");
    assert.equal(
      (await call("POST", "/api/memory/forget", { query: "one" }, { remote: true })).status,
      403,
    );
    assert.equal(
      (await fetch(`${origin}/api/export`, { headers: headersFor({ remote: true }) })).status,
      403,
    );

    const cross = await call(
      "POST",
      "/api/memory/entries",
      { store: "memory", text: "x" },
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    assert.equal(cross.status, 403);
    const foreignOrigin = await call(
      "POST",
      "/api/memory/forget",
      { query: "one" },
      { headers: { origin: "https://evil.example" } },
    );
    assert.equal(foreignOrigin.status, 403);
    // DNS rebinding: loopback peer, foreign Host header.
    const rebind = await new Promise<number>((resolve, reject) => {
      const r = http.request(
        `${origin}/api/export`,
        { headers: { host: "evil.example:80" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.equal(rebind, 403);
    assert.equal(read("memory/MEMORY.md"), "- one\n");
  });

  test("the entries read refuses DNS rebinding and cross-site reads, like export", async () => {
    write("memory/MEMORY.md", "- secret mac fact\n");
    const rawGet = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = http.request(`${origin}/api/memory/entries`, { headers }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        r.on("error", reject);
        r.end();
      });
    const rebind = await rawGet({ host: "evil.example.com" });
    assert.equal(rebind.status, 403);
    assert.match(rebind.body, /untrusted_host/);
    assert.ok(!rebind.body.includes("secret mac fact"));
    const cross = await call("GET", "/api/memory/entries", undefined, {
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(cross.status, 403);
    const foreign = await call("GET", "/api/memory/entries", undefined, {
      headers: { origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    // The owner's own page, and a paired device on the LAN, still read.
    assert.equal((await entries())[0]!.entries.length, 1);
    assert.equal((await entries({ remote: true }))[0]!.entries.length, 1);
  });

  test("forget dry-run and apply over HTTP", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n- likes tea\n");
    const dry = await call("POST", "/api/memory/forget", { query: "project falcon", dryRun: true });
    assert.equal(dry.status, 200);
    const report = dry.json.report as { counts: Record<string, number>; dryRun: boolean };
    assert.equal(report.dryRun, true);
    assert.equal(report.counts.memory, 1);
    assert.equal(read("memory/MEMORY.md"), "- Project Falcon ships in May\n- likes tea\n");
    const bad = await call("POST", "/api/memory/forget", { query: "x", dryRun: true });
    assert.equal(bad.status, 400);
    const applied = await call("POST", "/api/memory/forget", {
      query: "project falcon",
      digest: (dry.json.report as { digest: string }).digest,
    });
    assert.equal(applied.status, 200);
    assert.equal(read("memory/MEMORY.md"), "- likes tea\n");
  });

  test("forget applies only a previewed set: no digest → 400, a changed set → 409", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n- likes tea\n");
    const dry = await call("POST", "/api/memory/forget", { query: "project falcon", dryRun: true });
    const report = dry.json.report as {
      digest: string;
      locations: { id: string; snippet?: string; location: string }[];
    };
    assert.match(report.locations[0]!.snippet ?? "", /Project Falcon ships in May/);
    const noPreview = await call("POST", "/api/memory/forget", { query: "project falcon" });
    assert.equal(noPreview.status, 400);
    assert.equal(noPreview.json.error, "preview_required");
    // Something new mentions it after the preview: apply refuses, nothing changes.
    write(
      "memory/MEMORY.md",
      "- Project Falcon ships in May\n- likes tea\n- project falcon budget\n",
    );
    const stale = await call("POST", "/api/memory/forget", {
      query: "project falcon",
      digest: report.digest,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "preview_changed");
    assert.equal(
      read("memory/MEMORY.md"),
      "- Project Falcon ships in May\n- likes tea\n- project falcon budget\n",
    );
  });

  test("export streams a gzip'd tar of the owner's Lisa; sessions are opt-in", async () => {
    write("memory/MEMORY.md", "- one\n");
    write("soul/identity.md", "me\n");
    write("sessions/s1.jsonl", '{"type":"session"}\n');
    write("config.env", "SECRET=1\n");
    write("warden/secrets.enc.json", "{}");
    const plain = await exportFiles("/api/export");
    assert.ok(
      plain.has("memory/MEMORY.md") && plain.has("soul/identity.md") && plain.has("manifest.json"),
    );
    assert.ok(!plain.has("sessions/s1.jsonl"));
    assert.ok(![...plain.keys()].some((p) => p.includes("config.env") || p.startsWith("warden/")));
    const withSessions = await exportFiles("/api/export?sessions=1");
    assert.ok(withSessions.has("sessions/s1.jsonl"));
  });
});

describe("memory sovereignty API — cloud tenant isolation", () => {
  const A = "uid-alice";
  const B = "uid-bob";
  const homeOf = (uid: string) => path.join(home, "users", uid);

  beforeEach(() => {
    write("memory/MEMORY.md", "- operator global memory\n");
    write("soul/identity.md", "operator soul\n");
    write("memory/MEMORY.md", "- alice secret plan\n", homeOf(A));
    write("soul/identity.md", "alice soul\n", homeOf(A));
    write("memory/MEMORY.md", "- bob secret plan\n", homeOf(B));
    write("soul/identity.md", "bob soul\n", homeOf(B));
    write("soul/journal/2026-10-01.md", "bob secret plan\n", homeOf(B));
  });

  test("no account session → no access at all (shared/device tokens included)", async () => {
    for (const [m, u, b] of [
      ["GET", "/api/memory/entries", undefined],
      ["POST", "/api/memory/entries", { store: "memory", text: "x" }],
      ["POST", "/api/memory/forget", { query: "secret plan" }],
      ["GET", "/api/export", undefined],
    ] as const) {
      const r = await call(m, u, b, { cloud: true, remote: true });
      assert.equal(r.status, 403, `${m} ${u}`);
      assert.equal(r.json.error, "account_session_required");
    }
  });

  test("uid A sees and edits only A; B's entry ids don't resolve for A", async () => {
    const [aMem] = await entries({ cloud: true, uid: A, remote: true });
    assert.deepEqual(
      aMem!.entries.map((e) => e.text),
      ["alice secret plan"],
    );
    const [bMem] = await entries({ cloud: true, uid: B, remote: true });
    const bobId = bMem!.entries[0]!.id;
    const put = await call(
      "PUT",
      `/api/memory/entries/${bobId}`,
      { text: "hijacked" },
      { cloud: true, uid: A, remote: true },
    );
    assert.equal(put.status, 404);
    const del = await call("DELETE", `/api/memory/entries/${bobId}`, undefined, {
      cloud: true,
      uid: A,
      remote: true,
    });
    assert.equal(del.status, 404);
    const add = await call(
      "POST",
      "/api/memory/entries",
      { store: "memory", text: "alice note" },
      { cloud: true, uid: A, remote: true },
    );
    assert.equal(add.status, 201);
    assert.equal(read("memory/MEMORY.md", homeOf(A)), "- alice secret plan\n- alice note\n");
    assert.equal(read("memory/MEMORY.md", homeOf(B)), "- bob secret plan\n");
    assert.equal(read("memory/MEMORY.md"), "- operator global memory\n");
  });

  test("uid A can't forget B's data", async () => {
    const dry = await call(
      "POST",
      "/api/memory/forget",
      { query: "secret plan", dryRun: true },
      { cloud: true, uid: A, remote: true },
    );
    const r = await call(
      "POST",
      "/api/memory/forget",
      { query: "secret plan", digest: (dry.json.report as { digest: string }).digest },
      { cloud: true, uid: A, remote: true },
    );
    assert.equal(r.status, 200);
    assert.equal(read("memory/MEMORY.md", homeOf(A)), "\n");
    assert.equal(read("memory/MEMORY.md", homeOf(B)), "- bob secret plan\n");
    assert.equal(read("soul/journal/2026-10-01.md", homeOf(B)), "bob secret plan\n");
    assert.equal(read("memory/MEMORY.md"), "- operator global memory\n");
  });

  test("uid A's export holds only A's Lisa", async () => {
    const files = await exportFiles("/api/export", { cloud: true, uid: A, remote: true });
    assert.equal(files.get("memory/MEMORY.md"), "- alice secret plan\n");
    assert.equal(files.get("soul/identity.md"), "alice soul\n");
    for (const [p, data] of files) {
      assert.ok(!data.includes("bob") && !data.includes("operator"), `foreign data in ${p}`);
      assert.ok(!p.startsWith("users/"), p);
    }
  });
});

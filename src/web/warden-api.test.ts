import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { crossSiteProblem, createWebWarden, handleWardenApi, wardenTrust } from "./warden-api.js";
import { WardenInbox } from "../warden/inbox.js";
import { createGrants, loadGrants } from "../warden/grants.js";
import { loadRules } from "../warden/rules.js";
import { auditDecision } from "../warden/audit.js";
import type { ActionRequest, WardenEvent } from "../warden/types.js";

/**
 * The test server stands in for server.ts's auth gate: the `x-test-uid`
 * header plays the authenticated account, `x-test-trust` whether the caller is
 * a trusted approver. The handler itself must never read tenancy from anything
 * else in the request.
 */
let root: string;
let server: http.Server;
let origin: string;
let inbox: WardenInbox;
let events: Array<{ event: WardenEvent; uid: string | null }>;

function homeFor(uid: string | null): string {
  const dir = path.join(root, uid === null ? "global" : path.join("users", uid));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-api-"));
  events = [];
  inbox = new WardenInbox({ emit: (event, uid) => events.push({ event, uid }) });
  server = http.createServer((req, res) => {
    const header = req.headers["x-test-uid"];
    const uid = typeof header === "string" && header !== "" ? header : null;
    const trust = req.headers["x-test-trust"];
    void handleWardenApi(req, res, req.url ?? "/", {
      inbox,
      uid,
      home: homeFor(uid),
      allowApproval: trust === "loopback" || trust === "account",
      loopbackTrust: trust === "loopback",
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("unhandled");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await inbox.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function request(uid: string | null, over: Partial<ActionRequest> = {}): ActionRequest {
  seq++;
  return {
    id: `act_${seq}`,
    at: new Date().toISOString(),
    uid,
    surface: uid === null ? "local-web" : "cloud",
    origin: { kind: "chat" },
    tool: "github",
    method: "pr_comment",
    category: "publish",
    targets: ["o/r"],
    dataClasses: [],
    digest: String(seq).padStart(64, "0"),
    preview: 'github(action="pr_comment")',
    sandboxed: false,
    tainted: false,
    ...over,
  };
}

async function call(
  method: string,
  route: string,
  opts: {
    uid?: string;
    trust?: "loopback" | "account" | "none";
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.uid) headers["x-test-uid"] = opts.uid;
  headers["x-test-trust"] = opts.trust ?? "loopback";
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  const res = await fetch(origin + route, { method, headers, body });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Queue an approval for `uid` and return its id plus the waiter. */
async function queue(uid: string | null, over: Partial<ActionRequest> = {}) {
  const before = events.length;
  const waiting = inbox.request(request(uid, over), {
    home: homeFor(uid),
    reason: "needs approval",
  });
  for (let i = 0; i < 400 && events.length === before; i++)
    await new Promise((r) => setTimeout(r, 5));
  const event = events[before]!.event;
  return { id: event.id, waiting };
}

describe("warden API", () => {
  test("routes outside the domain are not handled", async () => {
    assert.equal((await call("GET", "/api/approvalsx")).status, 404);
    assert.deepEqual((await call("GET", "/api/approvalsx")).body, { raw: "unhandled" });
    assert.deepEqual((await call("GET", "/api/sense/social/drafts")).body, { raw: "unhandled" });
  });

  test("list → approve round trip resolves the waiting turn", async () => {
    const { id, waiting } = await queue(null);
    const list = await call("GET", "/api/approvals");
    assert.equal(list.status, 200);
    const approvals = list.body.approvals as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.id, id);
    assert.equal(approvals[0]!.tool, "github");
    assert.equal(approvals[0]!.reason, "needs approval");
    assert.equal("home" in approvals[0]!, false);
    assert.equal("uid" in approvals[0]!, false);
    assert.equal(list.body.canApprove, true);

    const approved = await call("POST", `/api/approvals/${id}/approve`, {
      body: { scope: "always" },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.verdict, "approved");
    assert.equal(approved.body.scope, "always");
    assert.deepEqual(await waiting, { approved: true, scope: "always" });
    assert.equal((await loadGrants(homeFor(null))).grants.length, 1);
    assert.deepEqual((await call("GET", "/api/approvals")).body.approvals, []);
    // Replays find nothing.
    assert.equal((await call("POST", `/api/approvals/${id}/approve`, { body: {} })).status, 404);
  });

  test("deny resolves the turn as not approved", async () => {
    const { id, waiting } = await queue(null);
    const denied = await call("POST", `/api/approvals/${id}/deny`, { body: { reason: "no" } });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.verdict, "denied");
    assert.deepEqual(await waiting, { approved: false, reason: "no" });
  });

  test("an untrusted caller can look but cannot approve, deny, change rules or revoke", async () => {
    const { id, waiting } = await queue(null);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    const [grant] = await createGrants(request(null), "always", homeFor(null));
    const list = await call("GET", "/api/approvals", { trust: "none" });
    assert.equal(list.status, 200);
    assert.equal(list.body.canApprove, false);
    for (const [method, route, body] of [
      ["POST", `/api/approvals/${id}/approve`, { scope: "always" }],
      ["POST", `/api/approvals/${id}/deny`, {}],
      ["PUT", "/api/warden/rules", { categories: { exec: "auto" } }],
      ["DELETE", `/api/warden/grants/${grant!.id}`, undefined],
    ] as const) {
      const res = await call(method, route, { trust: "none", body });
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.equal(res.body.error, "trusted_local_confirmation_required");
    }
    assert.equal(settled, false);
    assert.equal((await loadGrants(homeFor(null))).grants.length, 1);
    assert.deepEqual((await loadRules(homeFor(null))).rules.categories, {});
    await call("POST", `/api/approvals/${id}/deny`, { body: {} });
  });

  test("cloud tenant isolation: one account cannot see, approve, deny or revoke another's", async () => {
    const { id: idB, waiting } = await queue("userB");
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    const [grantB] = await createGrants(request("userB"), "always", homeFor("userB"));
    await auditDecision(
      request("userB"),
      { verdict: "ask", reason: "r" },
      { home: homeFor("userB") },
    );

    const asA = { uid: "userA", trust: "account" as const };
    assert.deepEqual((await call("GET", "/api/approvals", asA)).body.approvals, []);
    assert.deepEqual((await call("GET", "/api/warden/grants", asA)).body.grants, []);
    assert.deepEqual((await call("GET", "/api/warden/audit", asA)).body.entries, []);
    const approve = await call("POST", `/api/approvals/${idB}/approve`, {
      ...asA,
      body: { scope: "always" },
    });
    assert.equal(approve.status, 404);
    assert.equal(approve.body.error, "approval_not_found");
    assert.equal(
      (await call("POST", `/api/approvals/${idB}/deny`, { ...asA, body: {} })).status,
      404,
    );
    assert.equal((await call("DELETE", `/api/warden/grants/${grantB!.id}`, asA)).status, 404);
    // The unscoped (shared-token) caller is not userB either.
    assert.equal(
      (await call("POST", `/api/approvals/${idB}/approve`, { trust: "loopback", body: {} })).status,
      404,
    );
    // A uid in the body or query is ignored.
    assert.equal(
      (
        await call("POST", `/api/approvals/${idB}/approve?uid=userB`, {
          ...asA,
          body: { uid: "userB", scope: "once" },
        })
      ).status,
      404,
    );
    // A rules change by A lands in A's home only.
    assert.equal(
      (
        await call("PUT", "/api/warden/rules", {
          ...asA,
          body: { categories: { send: "handoff" } },
        })
      ).status,
      200,
    );
    assert.equal((await loadRules(homeFor("userA"))).rules.categories.send, "handoff");
    assert.deepEqual((await loadRules(homeFor("userB"))).rules.categories, {});

    assert.equal(settled, false, "B's approval is untouched");
    assert.equal((await loadGrants(homeFor("userB"))).grants.length, 1);
    assert.equal(
      events.every((e) => e.uid === "userB"),
      true,
    );

    const asB = { uid: "userB", trust: "account" as const };
    assert.equal(
      ((await call("GET", "/api/approvals", asB)).body.approvals as unknown[]).length,
      1,
    );
    assert.equal(
      ((await call("GET", "/api/warden/audit", asB)).body.entries as unknown[]).length,
      1,
    );
    assert.equal(
      (await call("POST", `/api/approvals/${idB}/approve`, { ...asB, body: {} })).status,
      200,
    );
    assert.equal((await waiting).approved, true);
  });

  test("bad answers: scope, digest, content type, JSON, size", async () => {
    const { id, waiting } = await queue(null, { targets: [] });
    const route = `/api/approvals/${id}/approve`;
    assert.equal(
      (await call("POST", route, { body: { scope: "forever" } })).body.error,
      "invalid_scope",
    );
    assert.equal(
      (await call("POST", route, { body: { scope: "task" } })).body.error,
      "scope_not_applicable",
    );
    assert.equal(
      (await call("POST", route, { body: { digest: "0".repeat(63) + "x" } })).status,
      409,
    );
    assert.equal(
      (
        await call("POST", route, {
          body: "scope=always",
          headers: { "content-type": "text/plain" },
        })
      ).status,
      415,
    );
    assert.equal(
      (
        await call("POST", route, {
          body: "scope=always",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        })
      ).status,
      415,
    );
    assert.equal((await call("POST", route)).status, 415, "no body, no content type");
    assert.equal((await call("POST", route, { body: "{not json" })).status, 400);
    assert.equal((await call("POST", route, { body: "[]" })).status, 400);
    assert.equal(
      (await call("POST", route, { body: { reason: "x".repeat(70 * 1024) } })).status,
      413,
    );
    assert.equal((await call("GET", route)).status, 405);
    assert.equal((await call("DELETE", "/api/approvals")).status, 405);
    assert.equal(
      ((await call("GET", "/api/approvals")).body.approvals as unknown[]).length,
      1,
      "still pending",
    );
    await call("POST", `/api/approvals/${id}/deny`, { body: {} });
    assert.equal((await waiting).approved, false);
  });

  test("cross-site and rebinding requests are refused", async () => {
    const { id, waiting } = await queue(null);
    const route = `/api/approvals/${id}/approve`;
    const cross = await call("POST", route, {
      body: {},
      headers: { origin: "https://evil.example" },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error, "cross_origin_request");
    assert.equal(
      (await call("POST", route, { body: {}, headers: { "sec-fetch-site": "cross-site" } })).status,
      403,
    );
    assert.equal(
      (await call("POST", route, { body: {}, headers: { origin: "null" } })).status,
      403,
    );
    assert.equal(
      (
        await call("PUT", "/api/warden/rules", {
          body: {},
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    // Same-origin is fine.
    const same = await call("POST", `/api/approvals/${id}/deny`, { body: {}, headers: { origin } });
    assert.equal(same.status, 200);
    assert.equal((await waiting).approved, false);

    const fake = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
    // Loopback trust requires a loopback Host (DNS rebinding / tunnels).
    assert.equal(
      crossSiteProblem(fake({ host: "evil.example:5757" }), true, null),
      "untrusted_host",
    );
    assert.equal(crossSiteProblem(fake({ host: "evil.example" }), false, null), null);
    for (const host of [
      "localhost:5757",
      "127.0.0.1:5757",
      "[::1]:5757",
      "lisa.localhost",
      "127.0.0.2",
    ]) {
      assert.equal(crossSiteProblem(fake({ host }), true, null), null, host);
    }
    for (const host of ["127.0.0.1.evil.example", "localhost.evil.example", "", "10.0.0.5:5757"]) {
      assert.equal(crossSiteProblem(fake({ host }), true, null), "untrusted_host", host);
    }
    assert.equal(crossSiteProblem(fake({}), true, null), "untrusted_host");
    // The operator's canonical origin is accepted even when a proxy rewrote Host.
    assert.equal(
      crossSiteProblem(
        fake({ host: "internal.run.app", origin: "https://cloud.example" }),
        false,
        "https://cloud.example",
      ),
      null,
    );
    assert.equal(
      crossSiteProblem(
        fake({ host: "internal.run.app", origin: "https://cloud.example.evil.test" }),
        false,
        "https://cloud.example",
      ),
      "cross_origin_request",
    );
    assert.equal(
      crossSiteProblem(fake({ host: "a", origin: "not a url" }), false, null),
      "bad_origin",
    );
  });

  test("rules: read, replace, and reject invalid or invariant-breaking documents", async () => {
    const initial = await call("GET", "/api/warden/rules");
    assert.equal(initial.status, 200);
    assert.deepEqual((initial.body.rules as Record<string, unknown>).categories, {});
    assert.equal(initial.body.corrupt, false);
    assert.deepEqual(initial.body.locked, { purchase: "handoff", credential: "handoff" });
    assert.deepEqual(initial.body.behaviors, ["auto", "preapproved", "ask", "handoff"]);

    const put = await call("PUT", "/api/warden/rules", {
      body: { rules: { categories: { exec: "ask" }, tools: { bash: "handoff" } } },
    });
    assert.equal(put.status, 200);
    assert.equal((await loadRules(homeFor(null))).rules.categories.exec, "ask");

    for (const bad of [
      { categories: { purchase: "auto" } },
      { categories: { credential: "ask" } },
      { categories: { exec: "allow" } },
      { categories: { everything: "auto" } },
      { version: 2 },
    ]) {
      const res = await call("PUT", "/api/warden/rules", { body: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, "invalid_rules");
    }
    assert.equal(
      (await loadRules(homeFor(null))).rules.categories.exec,
      "ask",
      "unchanged by rejected writes",
    );
    assert.equal((await call("POST", "/api/warden/rules", { body: {} })).status, 405);

    fs.writeFileSync(path.join(homeFor(null), "warden", "rules.json"), "{oops");
    const corrupt = await call("GET", "/api/warden/rules");
    assert.equal(corrupt.body.corrupt, true);
    assert.deepEqual((corrupt.body.rules as Record<string, unknown>).categories, {});
  });

  test("grants: list and revoke; audit: read with a bounded limit", async () => {
    const [grant] = await createGrants(request(null), "24h", homeFor(null));
    const list = await call("GET", "/api/warden/grants");
    assert.equal((list.body.grants as Array<{ id: string }>)[0]!.id, grant!.id);
    assert.equal((await call("DELETE", "/api/warden/grants/nope")).status, 404);
    assert.equal((await call("DELETE", `/api/warden/grants/${grant!.id}`)).status, 200);
    assert.deepEqual((await call("GET", "/api/warden/grants")).body.grants, []);
    assert.equal((await call("POST", "/api/warden/grants", { body: {} })).status, 405);

    for (let i = 0; i < 3; i++) {
      await auditDecision(
        request(null),
        { verdict: "allow", reason: "r" },
        { home: homeFor(null) },
      );
    }
    const all = (await call("GET", "/api/warden/audit")).body.entries as Array<
      Record<string, unknown>
    >;
    assert.equal(all.length, 4, "3 decisions + the revoke");
    assert.equal(
      all.some((e) => e.kind === "grant_revoked"),
      true,
    );
    assert.equal(
      ((await call("GET", "/api/warden/audit?limit=2")).body.entries as unknown[]).length,
      2,
    );
    assert.equal(
      ((await call("GET", "/api/warden/audit?limit=abc")).body.entries as unknown[]).length,
      4,
    );
    assert.equal(
      ((await call("GET", "/api/warden/audit?limit=-5")).body.entries as unknown[]).length,
      1,
    );
    assert.equal((await call("GET", "/api/warden/nope")).status, 404);
  });
});

describe("wardenTrust", () => {
  test("who may approve, and when the Host header must be loopback", () => {
    // The person at the Mac.
    assert.deepEqual(wardenTrust({ cloud: false, loopback: true, accountUid: null }), {
      allowApproval: true,
      loopbackTrust: true,
    });
    // A paired phone / shared web token over the LAN: may read, may not answer,
    // and is not held to a loopback Host.
    assert.deepEqual(wardenTrust({ cloud: false, loopback: false, accountUid: null }), {
      allowApproval: false,
      loopbackTrust: false,
    });
    // A signed-in cloud account.
    assert.deepEqual(wardenTrust({ cloud: true, loopback: false, accountUid: "u1" }), {
      allowApproval: true,
      loopbackTrust: false,
    });
    // On the hosted edition loopback is a proxy hop, never an owner.
    assert.deepEqual(wardenTrust({ cloud: true, loopback: true, accountUid: null }), {
      allowApproval: false,
      loopbackTrust: false,
    });
    assert.deepEqual(wardenTrust({ cloud: true, loopback: true, accountUid: "u1" }), {
      allowApproval: true,
      loopbackTrust: false,
    });
  });
});

describe("createWebWarden", () => {
  test("is inert unless the policy selects warden", () => {
    const off = createWebWarden(
      { approval: "auto", surface: "local-web", sandboxMode: "danger-full-access" },
      () => {},
    );
    assert.equal(off.enabled, false);
    assert.equal(
      off.turn({ uid: null, sandboxMode: undefined, workspaceRoot: "/w", tools: [] }),
      undefined,
    );
  });

  test("taint carries across the turns of one conversation, and not to another", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-web-"));
    const previous = process.env.LISA_HOME;
    process.env.LISA_HOME = home;
    try {
      const warden = createWebWarden(
        { approval: "warden", surface: "local-web", sandboxMode: "danger-full-access" },
        () => {},
        { approvalTimeoutMs: 20 },
      );
      const turn = (conversationId: string) =>
        warden.turn({
          uid: null,
          sandboxMode: undefined,
          workspaceRoot: "/w",
          tools: [],
          conversationId,
        })!;
      const first = turn("c1");
      assert.deepEqual(await first.approval("bash", { command: "ls" }), { allow: true });
      assert.deepEqual(await first.approval("web_fetch", { url: "https://example.com" }), {
        allow: true,
      });
      // Next turn of the same conversation: the fetched page is still in history.
      const second = turn("c1");
      assert.equal((await second.approval("bash", { command: "ls" })).allow, false);
      // A different conversation is unaffected.
      assert.deepEqual(await turn("c2").approval("bash", { command: "ls" }), { allow: true });
      await warden.inbox.shutdown();
    } finally {
      if (previous === undefined) delete process.env.LISA_HOME;
      else process.env.LISA_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

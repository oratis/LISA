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

const PAYLOAD = {
  body: "LGTM — " + "x".repeat(400) + " END-OF-BODY",
  action: "pr_comment",
  repo: "o/r",
  number: 7,
};

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

/** Queue an approval for `uid` and return its id, digest and the waiter. */
async function queue(
  uid: string | null,
  over: Partial<ActionRequest> = {},
  extra: { scopes?: ActionRequest["category"][] } = {},
) {
  void extra;
  const before = events.length;
  const req = request(uid, over);
  const waiting = inbox.request(req, {
    home: homeFor(uid),
    reason: "needs approval",
    payload: PAYLOAD,
    primaryKeys: ["action", "repo", "number", "body"],
  });
  for (let i = 0; i < 400 && events.length === before; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  const event = events[before]!.event;
  return { id: event.id, digest: req.digest, waiting };
}

describe("warden API", () => {
  test("routes outside the domain are not handled", async () => {
    assert.equal((await call("GET", "/api/approvalsx")).status, 404);
    assert.deepEqual((await call("GET", "/api/approvalsx")).body, { raw: "unhandled" });
    assert.deepEqual((await call("GET", "/api/sense/social/drafts")).body, { raw: "unhandled" });
  });

  test("list → show → approve round trip resolves the waiting turn", async () => {
    const { id, digest, waiting } = await queue(null);
    const list = await call("GET", "/api/approvals");
    assert.equal(list.status, 200);
    const approvals = list.body.approvals as Array<Record<string, unknown>>;
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.id, id);
    assert.equal(approvals[0]!.tool, "github");
    assert.equal(approvals[0]!.reason, "needs approval");
    assert.equal("home" in approvals[0]!, false);
    assert.equal("uid" in approvals[0]!, false);
    assert.equal("payload" in approvals[0]!, false);
    assert.equal(
      JSON.stringify(list.body).includes("END-OF-BODY"),
      false,
      "the list is the short form",
    );
    assert.equal(list.body.canApprove, true);

    const approved = await call("POST", `/api/approvals/${id}/approve`, {
      body: { scope: "always", digest },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.verdict, "approved");
    assert.equal(approved.body.scope, "always");
    assert.deepEqual(await waiting, { approved: true, scope: "always" });
    assert.equal((await loadGrants(homeFor(null))).grants.length, 1);
    assert.deepEqual((await call("GET", "/api/approvals")).body.approvals, []);
    // Replays find nothing.
    assert.equal(
      (await call("POST", `/api/approvals/${id}/approve`, { body: { digest } })).status,
      404,
    );
  });

  test("review 5: GET /api/approvals/{id} serves the whole payload, in the classifier's order, to approvers only", async () => {
    const { id, digest, waiting } = await queue(null);
    const detail = await call("GET", `/api/approvals/${id}`);
    assert.equal(detail.status, 200);
    const approval = detail.body.approval as Record<string, unknown>;
    assert.equal(approval.id, id);
    assert.equal(approval.digest, digest);
    const fields = detail.body.fields as Array<{ key: string; value: string; primary: boolean }>;
    assert.deepEqual(
      fields.map((f) => f.key),
      ["action", "repo", "number", "body"],
      "not the model's key order",
    );
    assert.ok(fields[3]!.value.endsWith("END-OF-BODY"), "the body is whole");
    // A caller who cannot approve is not shown the payload.
    const untrusted = await call("GET", `/api/approvals/${id}`, { trust: "none" });
    assert.equal(untrusted.status, 403);
    assert.equal(JSON.stringify(untrusted.body).includes("END-OF-BODY"), false);
    assert.equal((await call("GET", "/api/approvals/apr_nope")).status, 404);
    assert.equal((await call("DELETE", `/api/approvals/${id}`)).status, 405);
    await call("POST", `/api/approvals/${id}/deny`, { body: {} });
    await waiting;
  });

  test("review 5: approving without the digest of what was shown is refused", async () => {
    const { id, digest, waiting } = await queue(null);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    const route = `/api/approvals/${id}/approve`;
    for (const body of [{}, { scope: "always" }, { digest: "" }, { digest: 5 }]) {
      const res = await call("POST", route, { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, "digest_required");
    }
    const stale = await call("POST", route, { body: { digest: "0".repeat(63) + "x" } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "digest_mismatch");
    assert.equal(settled, false);
    assert.equal((await loadGrants(homeFor(null))).grants.length, 0);
    assert.equal((await call("POST", route, { body: { digest } })).status, 200);
    assert.equal((await waiting).approved, true);
  });

  test("deny resolves the turn as not approved", async () => {
    const { id, waiting } = await queue(null);
    const denied = await call("POST", `/api/approvals/${id}/deny`, { body: { reason: "no" } });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.verdict, "denied");
    assert.deepEqual(await waiting, { approved: false, reason: "no" });
  });

  test("an untrusted caller can look but cannot approve, deny, change rules or revoke", async () => {
    const { id, digest, waiting } = await queue(null);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    const [grant] = await createGrants(request(null), "always", homeFor(null));
    const list = await call("GET", "/api/approvals", { trust: "none" });
    assert.equal(list.status, 200);
    assert.equal(list.body.canApprove, false);
    for (const [method, route, body] of [
      ["POST", `/api/approvals/${id}/approve`, { scope: "always", digest }],
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
    const { id: idB, digest, waiting } = await queue("userB");
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
    const peek = await call("GET", `/api/approvals/${idB}`, asA);
    assert.equal(peek.status, 404);
    assert.equal(JSON.stringify(peek.body).includes("END-OF-BODY"), false);
    const approve = await call("POST", `/api/approvals/${idB}/approve`, {
      ...asA,
      body: { scope: "always", digest },
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
      (await call("POST", `/api/approvals/${idB}/approve`, { trust: "loopback", body: { digest } }))
        .status,
      404,
    );
    // A uid in the body or query is ignored.
    assert.equal(
      (
        await call("POST", `/api/approvals/${idB}/approve?uid=userB`, {
          ...asA,
          body: { uid: "userB", scope: "once", digest },
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
    assert.equal((await call("GET", `/api/approvals/${idB}`, asB)).status, 200);
    assert.equal(
      ((await call("GET", "/api/warden/audit", asB)).body.entries as unknown[]).length,
      1,
    );
    assert.equal(
      (await call("POST", `/api/approvals/${idB}/approve`, { ...asB, body: { digest } })).status,
      200,
    );
    assert.equal((await waiting).approved, true);
  });

  test("bad answers: scope, content type, JSON, size", async () => {
    const { id, digest, waiting } = await queue(null, { targets: [] });
    const route = `/api/approvals/${id}/approve`;
    assert.equal(
      (await call("POST", route, { body: { scope: "forever", digest } })).body.error,
      "invalid_scope",
    );
    assert.equal(
      (await call("POST", route, { body: { scope: "task", digest } })).body.error,
      "scope_not_applicable",
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
    const { id, digest, waiting } = await queue(null);
    const route = `/api/approvals/${id}/approve`;
    const cross = await call("POST", route, {
      body: { digest },
      headers: { origin: "https://evil.example" },
    });
    assert.equal(cross.status, 403);
    assert.equal(cross.body.error, "cross_origin_request");
    assert.equal(
      (await call("POST", route, { body: { digest }, headers: { "sec-fetch-site": "cross-site" } }))
        .status,
      403,
    );
    assert.equal(
      (await call("POST", route, { body: { digest }, headers: { origin: "null" } })).status,
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
      body: {
        rules: {
          categories: { exec: "ask" },
          tools: { bash: "handoff" },
          trustedMcpServers: ["gmail"],
        },
      },
    });
    assert.equal(put.status, 200);
    assert.equal((await loadRules(homeFor(null))).rules.categories.exec, "ask");
    assert.deepEqual((await loadRules(homeFor(null))).rules.trustedMcpServers, ["gmail"]);

    for (const bad of [
      { categories: { purchase: "auto" } },
      { categories: { credential: "ask" } },
      { categories: { exec: "allow" } },
      { categories: { everything: "auto" } },
      { tools: { bash: "constructor" } },
      { trustedMcpServers: "all" },
      { trustedMcpServers: ["ok", "bad name with spaces"] },
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
  const POLICY = {
    approval: "warden" as const,
    surface: "local-web" as const,
    sandboxMode: "workspace-write" as const,
  };
  let home: string;
  let previous: string | undefined;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lisa-warden-web-")));
    workspace = path.join(home, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    previous = process.env.LISA_HOME;
    process.env.LISA_HOME = home;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.LISA_HOME;
    else process.env.LISA_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const base = () => ({
    uid: null,
    sandboxMode: undefined,
    workspaceRoot: workspace,
    tools: [],
    owner: true,
  });
  const make = () => createWebWarden(POLICY, () => {}, { approvalTimeoutMs: 20 });

  test("is inert unless the policy selects warden", async () => {
    const off = createWebWarden({ ...POLICY, approval: "auto" }, () => {});
    assert.equal(off.enabled, false);
    assert.equal(await off.turn(base()), undefined);
  });

  test("taint carries across the turns of one conversation, and not to another", async () => {
    const warden = make();
    const turn = async (conversationId: string) =>
      (await warden.turn({ ...base(), conversationId, hasHistory: true }))!;
    const first = await turn("c1");
    assert.deepEqual(await first.approval("bash", { command: "ls" }), { allow: true });
    assert.deepEqual(await first.approval("web_search", { query: "x" }), { allow: true });
    // Next turn of the same conversation: the search results are still in history.
    const second = await turn("c1");
    assert.equal((await second.approval("bash", { command: "ls" })).allow, false);
    // A different conversation is unaffected.
    assert.deepEqual(await (await turn("c2")).approval("bash", { command: "ls" }), {
      allow: true,
    });
    await warden.inbox.shutdown();
  });

  test("review 7: taint survives a restart, and a corrupt taint file taints every conversation with history", async () => {
    const before = make();
    const t1 = (await before.turn({ ...base(), conversationId: "c1" }))!;
    await t1.approval("web_search", { query: "x" });
    await before.inbox.shutdown();
    // Give the fire-and-forget persist a moment.
    for (let i = 0; i < 100 && !fs.existsSync(path.join(home, "warden", "tainted.json")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const stored = JSON.parse(fs.readFileSync(path.join(home, "warden", "tainted.json"), "utf8"));
    assert.deepEqual(stored, { version: 1, ids: ["c1"] }, "ids only");

    // A new process: no in-memory state at all.
    const after = make();
    const resumed = (await after.turn({ ...base(), conversationId: "c1", hasHistory: true }))!;
    assert.equal((await resumed.approval("bash", { command: "ls" })).allow, false);
    const fresh = (await after.turn({ ...base(), conversationId: "c9", hasHistory: true }))!;
    assert.deepEqual(await fresh.approval("bash", { command: "ls" }), { allow: true });

    fs.writeFileSync(path.join(home, "warden", "tainted.json"), "{broken");
    const withHistory = (await after.turn({ ...base(), conversationId: "c9", hasHistory: true }))!;
    assert.equal((await withHistory.approval("bash", { command: "ls" })).allow, false);
    const brandNew = (await after.turn({ ...base(), conversationId: "c10", hasHistory: false }))!;
    assert.deepEqual(await brandNew.approval("bash", { command: "ls" }), { allow: true });
    await after.inbox.shutdown();
  });

  test("review 7: a turn with attachments starts tainted", async () => {
    const warden = make();
    const turn = (await warden.turn({ ...base(), conversationId: "c1", hasAttachments: true }))!;
    assert.equal((await turn.approval("bash", { command: "ls" })).allow, false);
    await warden.inbox.shutdown();
  });

  test("review low: a caller who cannot approve does not get owner defaults", async () => {
    const warden = make();
    const owner = (await warden.turn({ ...base(), conversationId: "o", owner: true }))!;
    assert.deepEqual(await owner.approval("bash", { command: "ls" }), { allow: true });
    // A LAN device with a token: authenticated, but not an approver.
    const remote = (await warden.turn({ ...base(), conversationId: "r", owner: false }))!;
    assert.equal((await remote.approval("bash", { command: "ls" })).allow, false);
    assert.equal((await remote.approval("write", { path: "a.ts", content: "x" })).allow, false);
    assert.deepEqual(await remote.approval("read", { path: "a.ts" }), { allow: true });
    await warden.inbox.shutdown();
  });

  test("review 4: URLs the user typed or a tool returned are remembered across turns of a conversation", async () => {
    const warden = make();
    const first = (await warden.turn({
      ...base(),
      conversationId: "c1",
      userText: "read https://docs.example/a please",
    }))!;
    assert.deepEqual(await first.approval("web_fetch", { url: "https://docs.example/a" }), {
      allow: true,
    });
    first.observe({
      type: "tool_call_end",
      toolName: "web_fetch",
      toolResult: "see https://docs.example/b",
    });
    const second = (await warden.turn({ ...base(), conversationId: "c1", hasHistory: true }))!;
    assert.deepEqual(await second.approval("web_fetch", { url: "https://docs.example/b" }), {
      allow: true,
    });
    assert.equal(
      (await second.approval("web_fetch", { url: "https://evil.example/?d=x" })).allow,
      false,
    );
    // Another conversation never saw that URL.
    const other = (await warden.turn({ ...base(), conversationId: "c2", hasAttachments: true }))!;
    assert.equal(
      (await other.approval("web_fetch", { url: "https://docs.example/b" })).allow,
      false,
    );
    await warden.inbox.shutdown();
  });
});

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  emptyState,
  parseState,
  roleFor,
  mutateAdminState,
  readAdminState,
  inferencePolicy,
  featureAllowed,
  consoleEnabled,
} from "./store.js";
import { handleConsole, consoleSecret, csvValue } from "./http.js";
import { consoleSnapshot } from "./data.js";
import { mintSession } from "../web/sessions-auth.js";
import {
  ensureSeededAccount,
  createEmailAccount,
  upsertAppleAccount,
  sessionAccountValid,
  getAccount,
} from "../web/accounts.js";
import { homeScope, homeForUid } from "../paths.js";
import { readBalance } from "../billing/quota.js";
import type { AccountRecord } from "../web/accounts.js";

let home: string;
let server: http.Server;
let base: string;
let admin: AccountRecord, regular: AccountRecord, analyst: AccountRecord, operator: AccountRecord;
let savedEnv: NodeJS.ProcessEnv;
const secret = "unit-test-session-secret";
const token = (acct: AccountRecord, sv = acct.sessionVersion) =>
  mintSession(acct.uid, consoleSecret(secret), { sv, ttlMs: 3600000 });
async function request(
  url: string,
  acct?: AccountRecord,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + url, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      ...(acct ? { cookie: `lisa_console=${token(acct)}` } : {}),
      ...(payload !== undefined
        ? {
            "content-type": "application/json",
            "x-lisa-console": "1",
            origin: "https://meetlisa.ai",
          }
        : {}),
      ...headers,
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}
beforeEach(async () => {
  savedEnv = { ...process.env };
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-console-test-"));
  process.env.LISA_HOME = home;
  process.env.LISA_CONSOLE_ENABLED = "1";
  process.env.LISA_ADMIN_EMAILS = "owner@example.com";
  process.env.LISA_EDITION = "cloud";
  process.env.LISA_FIRESTORE = "0";
  process.env.LISA_MODEL = "gemini-2.5-flash";
  admin = await ensureSeededAccount("owner@example.com", "a-password-123");
  regular = await ensureSeededAccount("member@example.com", "a-password-123");
  analyst = await ensureSeededAccount("analyst@example.com", "a-password-123");
  operator = await ensureSeededAccount("operator@example.com", "a-password-123");
  await mutateAdminState((s) => {
    s.roles[analyst.email!] = "analyst";
    s.roles[operator.email!] = "operator";
  });
  server = http.createServer((req, res) => {
    handleConsole(req, res, { secret, clientIp: "test-" + home })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("{}");
        }
      })
      .catch(() => {
        res.writeHead(500);
        res.end("{}");
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env = savedEnv;
  await fs.rm(home, { recursive: true, force: true });
});

test("console requires a separate admin session; no loopback, bearer or query-token bypass", async () => {
  for (const headers of [
    {},
    { authorization: "Bearer shared-secret" },
    { cookie: `lisa_token=${mintSession(admin.uid, secret)}` },
    { cookie: `lisa_console=${mintSession(admin.uid, secret)}` },
  ]) {
    const r = await request(
      "/console/api/snapshot?token=" + token(admin),
      undefined,
      undefined,
      headers,
    );
    assert.equal(r.response.status, 401);
  }
  assert.equal((await request("/console/api/me", regular)).response.status, 403);
  assert.equal((await request("/console/api/me", admin)).body.role, "admin");
  assert.equal((await request("/console/api/me", analyst)).body.role, "analyst");
  const html = await fetch(base + "/console");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.match(html.headers.get("cache-control")!, /no-store/);
});
test("unverified and Apple email aliases cannot acquire administrator privileges", async () => {
  const unverified = await createEmailAccount("unverified@example.com", "a-password-123");
  const apple = await upsertAppleAccount("test-apple", "owner@example.com");
  const state = emptyState();
  state.roles[unverified.email!] = "admin";
  assert.equal(roleFor(unverified, state), null);
  assert.equal(roleFor(apple, state), null);
  assert.equal((await request("/console/api/me", apple)).response.status, 403);
});
test("login does not reveal a session token and cookie is secured and path scoped", async () => {
  const r = await request("/console/api/login", undefined, {
    method: "password",
    email: admin.email,
    password: "a-password-123",
  });
  assert.equal(r.response.status, 200);
  assert.equal(r.body.token, undefined);
  const c = r.response.headers.get("set-cookie")!;
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\/console/);
  assert.match(c, /Secure/);
  const records = (await readAdminState()).audit;
  assert.equal(records.at(-1)?.action, "login");
  assert.ok(!JSON.stringify(records).includes("a-password-123"));
});
test("mutations reject cross-origin, missing custom header, stale version and read-only role", async () => {
  const state = await readAdminState();
  const payload = {
    action: "settings",
    revision: state.revision,
    paused: true,
    features: state.settings.features,
    reason: "维护测试",
  };
  assert.equal(
    (await request("/console/api/action", admin, payload, { origin: "https://evil.test" })).response
      .status,
    403,
  );
  assert.equal(
    (await request("/console/api/action", admin, payload, { "x-lisa-console": "" })).response
      .status,
    403,
  );
  assert.equal((await request("/console/api/action", analyst, payload)).response.status, 403);
  assert.equal((await request("/console/api/action", operator, payload)).response.status, 403);
  assert.equal(
    (await request("/console/api/action", admin, { ...payload, revision: 0 })).response.status,
    409,
  );
  assert.equal((await request("/console/api/action", admin, payload)).response.status, 200);
  assert.equal((await readAdminState()).settings.paused, true);
  assert.equal((await inferencePolicy(regular.uid)).ok, false);
});
test("bounded request body rejects oversize authenticated payload", async () => {
  const r = await request("/console/api/action", admin, {
    action: "ticket",
    reason: "a".repeat(17000),
  });
  assert.equal(r.response.status, 413);
});
test("grant retries and concurrent duplicate requests credit exactly once; conflicting amount is rejected", async () => {
  const before = await homeScope.run(homeForUid(regular.uid), readBalance);
  const payload = {
    action: "credit",
    uid: regular.uid,
    id: "test-grant-id-0000001",
    microUSD: 5000000,
    reason: "客户服务补偿",
  };
  const attempts = await Promise.all([
    request("/console/api/action", admin, payload),
    request("/console/api/action", admin, payload),
  ]);
  assert.ok(attempts.every((r) => r.response.status === 200));
  assert.equal((await request("/console/api/action", admin, payload)).response.status, 200);
  assert.equal(
    (await request("/console/api/action", admin, { ...payload, microUSD: 6000000 })).response
      .status,
    409,
  );
  const after = await homeScope.run(homeForUid(regular.uid), readBalance);
  assert.equal(after.paidMicroUSD - before.paidMicroUSD, 5000000);
  assert.equal(after.purchases.filter((p) => p.transactionId === "admin:" + payload.id).length, 1);
  const s = await readAdminState();
  assert.equal(s.operations[payload.id]?.status, "completed");
  assert.equal(s.audit.filter((a) => a.action === "credit_completed").length, 1);
});
test("grant recovers after credit succeeds but final audit update is interrupted", async () => {
  const payload = {
    action: "credit",
    uid: regular.uid,
    id: "test-grant-id-0000002",
    microUSD: 2000000,
    reason: "恢复补偿操作",
  };
  assert.equal((await request("/console/api/action", admin, payload)).response.status, 200);
  const balance = await homeScope.run(homeForUid(regular.uid), readBalance);
  await mutateAdminState((s) => {
    s.operations[payload.id]!.status = "pending";
  });
  assert.equal((await request("/console/api/action", admin, payload)).response.status, 200);
  assert.equal(
    (await homeScope.run(homeForUid(regular.uid), readBalance)).paidMicroUSD,
    balance.paidMicroUSD,
  );
});
test("suspension affects existing sessions, protected owner cannot be suspended, session revocation persists", async () => {
  let s = await readAdminState();
  assert.equal(
    (
      await request("/console/api/action", admin, {
        action: "user",
        uid: admin.uid,
        suspended: true,
        note: "",
        reason: "测试保护账户",
        revision: s.revision,
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await request("/console/api/action", admin, {
        action: "user",
        uid: regular.uid,
        suspended: true,
        note: "support",
        reason: "暂停异常账户",
        revision: s.revision,
      })
    ).response.status,
    200,
  );
  assert.equal(await sessionAccountValid(regular.uid, regular.sessionVersion), false);
  assert.equal((await inferencePolicy(regular.uid)).ok, false);
  s = await readAdminState();
  await request("/console/api/action", admin, {
    action: "user",
    uid: regular.uid,
    suspended: false,
    note: "",
    reason: "恢复正常账户",
    revision: s.revision,
  });
  assert.equal(await sessionAccountValid(regular.uid, regular.sessionVersion), true);
  await request("/console/api/action", admin, {
    action: "revoke_sessions",
    uid: regular.uid,
    reason: "退出所有设备",
  });
  assert.equal(await sessionAccountValid(regular.uid, regular.sessionVersion), false);
  assert.equal((await getAccount(regular.uid))!.sessionVersion, regular.sessionVersion + 1);
});
test("role changes take effect for existing sessions and cannot overwrite owner", async () => {
  let s = await readAdminState();
  assert.equal(
    (
      await request("/console/api/action", admin, {
        action: "role",
        email: admin.email,
        role: "none",
        reason: "测试保护权限",
        revision: s.revision,
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await request("/console/api/action", admin, {
        action: "role",
        email: analyst.email,
        role: "none",
        reason: "撤销临时权限",
        revision: s.revision,
      })
    ).response.status,
    200,
  );
  assert.equal((await request("/console/api/me", analyst)).response.status, 403);
});
test("feature switches match real endpoints, and never disable payment fulfillment", async () => {
  await mutateAdminState((s) => {
    for (const key of Object.keys(s.settings.features))
      s.settings.features[key as keyof typeof s.settings.features] = false;
    s.settings.disabledModels = ["gemini-2.5-flash"];
  });
  for (const p of [
    "/chat",
    "/gw/openai/v1/chat/completions",
    "/api/voice/transcribe",
    "/api/uploads",
    "/api/kb/add",
    "/api/tasks",
    "/reflect",
    "/internal/autonomy/sweep",
    "/api/connectors/google/status",
    "/api/billing/stripe/checkout",
  ])
    assert.equal(await featureAllowed("POST", p), false, p);
  for (const p of [
    "/api/billing/iap",
    "/api/billing/stripe/webhook",
    "/api/billing/asn",
    "/console/api/me",
  ])
    assert.equal(await featureAllowed("POST", p), true, p);
  assert.equal((await inferencePolicy(regular.uid, "gemini-2.5-flash")).ok, false);
});
test("snapshots use real records, distinguish grants/sandbox from sales and redact credentials/content", async () => {
  const now = Date.now(),
    at = new Date(now - 1000).toISOString(),
    bill = path.join(homeForUid(regular.uid), "billing");
  await fs.mkdir(bill, { recursive: true });
  await fs.writeFile(
    path.join(bill, "usage.jsonl"),
    JSON.stringify({
      at,
      source: "chat",
      model: "gemini-2.5-flash",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      microUSD: 500,
      pricesVersion: 3,
    }) + "\n",
  );
  await fs.writeFile(
    path.join(home, "iap-transactions.json"),
    JSON.stringify([
      {
        transactionId: "12345678",
        uid: regular.uid,
        productId: "credits.5",
        microUSD: 5000000,
        at: now - 1000,
        status: "credited",
      },
      {
        transactionId: "admin:grant-123",
        uid: regular.uid,
        productId: "admin.grant",
        microUSD: 3000000,
        at: now - 1000,
        status: "credited",
      },
      {
        transactionId: "sandbox:123",
        uid: regular.uid,
        productId: "credits.5",
        microUSD: 5000000,
        at: now - 1000,
        status: "credited",
      },
      {
        transactionId: "22345678",
        uid: regular.uid,
        productId: "credits.5",
        microUSD: 5000000,
        at: now - 1000,
        status: "refunded",
      },
    ]),
  );
  const result = await consoleSnapshot(7, now);
  assert.equal(result.summary.active, 1);
  assert.equal(result.summary.turns, 1);
  assert.equal(result.summary.tokens, 125);
  assert.equal(result.summary.faceMicroUSD, 500);
  assert.equal(result.summary.creditMicroUSD, 5000000);
  assert.equal(result.summary.grantMicroUSD, 3000000);
  assert.equal(result.summary.paidUsers, 1);
  const raw = JSON.stringify(result);
  for (const key of [
    "scrypt",
    "keyHex",
    "saltHex",
    "session-secret",
    "password",
    "appleAuthorization",
  ])
    assert.ok(!raw.includes(key), key);
  assert.equal((await request("/console/api/snapshot?days=800", admin)).response.status, 400);
});
test("store corruption fails closed without overwriting; concurrent updates preserve all audit entries", async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      mutateAdminState((s) =>
        s.audit.push({
          id: String(i),
          at: Date.now(),
          actor: "test",
          action: "test",
          target: "test",
          reason: "test",
        }),
      ),
    ),
  );
  assert.equal((await readAdminState()).audit.length, 8);
  await fs.writeFile(path.join(home, "admin", "state.json"), "{broken");
  assert.equal((await request("/console/api/me", admin)).response.status, 503);
  await assert.rejects(inferencePolicy(regular.uid));
  assert.equal(await sessionAccountValid(regular.uid, regular.sessionVersion), false);
  assert.equal(await fs.readFile(path.join(home, "admin", "state.json"), "utf8"), "{broken");
  assert.throws(() =>
    parseState({ ...emptyState(), settings: { paused: false, features: {}, disabledModels: [] } }),
  );
});
test("CSV defuses spreadsheet formulas and escapes quotes", () => {
  assert.equal(csvValue("=SUM(A1:A2)"), `"'=SUM(A1:A2)"`);
  assert.equal(csvValue(" \t+cmd"), `"' \t+cmd"`);
  assert.equal(csvValue('a"b'), `"a""b"`);
});
test("console is opt-in and does not change normal editions when disabled", async () => {
  delete process.env.LISA_CONSOLE_ENABLED;
  assert.equal(consoleEnabled(), false);
  assert.equal((await request("/console/api/me", admin)).response.status, 404);
  assert.equal((await inferencePolicy(regular.uid)).ok, true);
});

test("bounded usage detail keeps complete totals and distinct active users", async () => {
  const now = Date.now();
  for (const [index, acct] of [regular, analyst].entries()) {
    const dir = path.join(homeForUid(acct.uid), "billing");
    await fs.mkdir(dir, { recursive: true });
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      at: new Date(now - (i + index * 2000 + 1) * 1000).toISOString(),
      source: "chat",
      model: "gemini-2.5-flash",
      inputTokens: 10,
      outputTokens: 2,
      microUSD: 100,
    }));
    await fs.writeFile(
      path.join(dir, "usage.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n"),
    );
  }
  const report = await consoleSnapshot(7, now);
  assert.equal(report.summary.turns, 3000);
  assert.equal(report.summary.active, 2);
  assert.equal(report.summary.faceMicroUSD, 300000);
  assert.equal(report.usage.length, 1000);
  assert.equal(report.usageTruncated, true);
  assert.ok(report.usage.every((u) => u.uid === regular.uid));
});

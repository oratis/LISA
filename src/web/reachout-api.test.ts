import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { homeForUid, homeScope } from "../paths.js";
import { reachOut } from "../reachout/gate.js";
import { reachOutLedgerPath } from "../reachout/ledger.js";
import { loadReachOutSettings } from "../reachout/settings.js";
import { DeferQueue } from "../reachout/defer.js";
import { handleReachOutApi } from "./reachout-api.js";

let home: string;
let previousHome: string | undefined;
let server: http.Server;
let origin: string;
// Local noon: outside the default quiet hours whatever the host zone is.
const NOW = new Date(2026, 9, 2, 12, 0, 0);

beforeEach(async () => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reachout-api-"));
  process.env.LISA_HOME = home;
  server = http.createServer((req, res) => {
    // Mirrors server.ts: a signed-in cloud request runs inside its uid's home.
    const uid = req.headers["x-test-uid"];
    const run = () =>
      handleReachOutApi(req, res, req.url ?? "/", { pushAvailable: !uid, now: () => NOW }).then(
        (handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end("unhandled");
          }
        },
      );
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
  fs.rmSync(home, { recursive: true, force: true });
});

async function call(
  method: string,
  route: string,
  body?: unknown,
  uid?: string,
): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(origin + route, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(uid ? { "x-test-uid": uid } : {}),
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

async function sendNotice(targetHome: string, title: string): Promise<string> {
  const out = await reachOut(
    { uid: null, source: "mail", kind: "digest", title, body: "PRIVATE BODY", priority: "normal" },
    {
      home: targetHome,
      now: () => NOW,
      proactiveMode: () => true,
      deferQueue: new DeferQueue({ tickMs: 0 }),
      transports: { inapp: () => {}, push: () => {} },
    },
  );
  return out.id;
}

describe("reach-out API", () => {
  test("routes outside /api/reachout/ are not handled", async () => {
    assert.equal((await fetch(origin + "/api/other")).status, 404);
    assert.equal(await (await fetch(origin + "/api/other")).text(), "unhandled");
  });

  test("GET settings returns the charter defaults, the budget and the Proactive switch", async () => {
    const { status, body } = await call("GET", "/api/reachout/settings");
    assert.equal(status, 200);
    assert.equal(body.settings.dial, "normal");
    assert.deepEqual(body.settings.quietHours, {
      enabled: true,
      start: "22:00",
      end: "08:00",
      tz: null,
    });
    assert.deepEqual(body.budget, { dial: "normal", daily: 3, usedToday: 0, remaining: 3 });
    assert.deepEqual(body.budgets, { off: 0, low: 1, normal: 3, high: 8 });
    assert.equal(body.proactiveMode, true);
    assert.equal(body.quietNow, false);
    assert.deepEqual(body.channelsAvailable, { inapp: true, push: true, im: false });
  });

  test("PUT settings merges a patch, persists it, and reports the new budget", async () => {
    const put = await call("PUT", "/api/reachout/settings", {
      dial: "low",
      sources: { brief: false },
      quietHours: { start: "23:00", end: "07:00" },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.settings.dial, "low");
    assert.equal(put.body.settings.sources.brief, false);
    assert.equal(put.body.settings.sources.mail, true);
    assert.equal(put.body.budget.daily, 1);
    const onDisk = loadReachOutSettings(home);
    assert.equal(onDisk.dial, "low");
    assert.deepEqual(onDisk.quietHours, { enabled: true, start: "23:00", end: "07:00", tz: null });
    const get = await call("GET", "/api/reachout/settings");
    assert.deepEqual(get.body.settings, put.body.settings);
  });

  test("PUT settings rejects bad input and leaves the stored settings alone", async () => {
    await call("PUT", "/api/reachout/settings", { dial: "high" });
    for (const bad of [
      { dial: "loudest" },
      { sources: { approval: false } },
      { quietHours: { start: "9pm" } },
      { compliance: { aiDisclosure: false } },
      { nonsense: true },
    ]) {
      const r = await call("PUT", "/api/reachout/settings", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.error, "invalid_settings");
    }
    assert.equal((await call("PUT", "/api/reachout/settings", "{not json")).status, 400);
    assert.equal((await call("PUT", "/api/reachout/settings", "[1]")).status, 400);
    assert.equal(loadReachOutSettings(home).dial, "high");
  });

  test("other methods on settings are refused", async () => {
    assert.equal((await call("DELETE", "/api/reachout/settings")).status, 405);
  });

  test("ledger returns aggregates only — no ids, hashes or text", async () => {
    const id = await sendNotice(home, "PRIVATE TITLE");
    await sendNotice(home, "second");
    await call("POST", "/api/reachout/feedback", { id, verdict: "useful" });
    const { status, body } = await call("GET", "/api/reachout/ledger?days=7");
    assert.equal(status, 200);
    assert.equal(body.days, 7);
    assert.equal(body.totals.delivered, 2);
    assert.equal(body.totals.interrupted, 2);
    assert.equal(body.bySource.mail.delivered, 2);
    assert.equal(body.bySource.mail.useful, 1);
    assert.equal(body.bySource.idle.delivered, 0);
    assert.equal(body.budgetUsedToday, 2);
    assert.equal(body.usefulRate, 0.5);
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("PRIVATE") && !raw.includes(id) && !raw.includes("titleHash"));
  });

  test("ledger validates days", async () => {
    for (const q of ["days=0", "days=91", "days=abc", "days=1.5"]) {
      assert.equal((await call("GET", `/api/reachout/ledger?${q}`)).status, 400, q);
    }
    const dflt = await call("GET", "/api/reachout/ledger");
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.usefulRate, null);
  });

  test("feedback: records a verdict, validates input, 404s an unknown notice", async () => {
    const id = await sendNotice(home, "t");
    const ok = await call("POST", "/api/reachout/feedback", { id, verdict: "dismissed" });
    assert.deepEqual([ok.status, ok.body], [200, { ok: true, id, verdict: "dismissed" }]);
    assert.match(fs.readFileSync(reachOutLedgerPath(home), "utf8"), /"type":"feedback"/);
    assert.equal(
      (await call("POST", "/api/reachout/feedback", { id, verdict: "meh" })).status,
      400,
    );
    assert.equal(
      (await call("POST", "/api/reachout/feedback", { id: "../x", verdict: "useful" })).status,
      400,
    );
    assert.equal(
      (await call("POST", "/api/reachout/feedback", { id: "ro_missing", verdict: "useful" }))
        .status,
      404,
    );
  });

  test("unknown reach-out route is a JSON 404", async () => {
    const r = await call("GET", "/api/reachout/nope");
    assert.deepEqual([r.status, r.body.error], [404, "reachout_route_not_found"]);
  });

  test("tenant scoping: each signed-in account reads and writes only its own home", async () => {
    await call("PUT", "/api/reachout/settings", { dial: "off" }, "userA");
    assert.equal(
      (await call("GET", "/api/reachout/settings", undefined, "userA")).body.settings.dial,
      "off",
    );
    assert.equal(
      (await call("GET", "/api/reachout/settings", undefined, "userB")).body.settings.dial,
      "normal",
    );
    assert.equal((await call("GET", "/api/reachout/settings")).body.settings.dial, "normal");
    // Push is machine-level: a cloud tenant is told it is unavailable.
    assert.equal(
      (await call("GET", "/api/reachout/settings", undefined, "userA")).body.channelsAvailable.push,
      false,
    );

    // A's notice id cannot be rated — or even confirmed to exist — by B.
    const idA = await sendNotice(homeForUid("userA"), "a");
    assert.equal(
      (await call("POST", "/api/reachout/feedback", { id: idA, verdict: "useful" }, "userB"))
        .status,
      404,
    );
    assert.equal(
      (await call("POST", "/api/reachout/feedback", { id: idA, verdict: "useful" }, "userA"))
        .status,
      200,
    );
    assert.equal(
      (await call("GET", "/api/reachout/ledger", undefined, "userB")).body.totals.delivered,
      0,
    );
    assert.equal(
      (await call("GET", "/api/reachout/ledger", undefined, "userA")).body.totals.delivered,
      1,
    );
    assert.equal(fs.existsSync(path.join(home, "reachout")), false);
  });
});

// ── contract conformance ───────────────────────────────────────────────────

interface Schema {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  minimum?: number;
}

const contract = JSON.parse(
  fs.readFileSync(new URL("../../contracts/lisa-api-v1.openapi.json", import.meta.url), "utf8"),
) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

function violations(input: Schema, value: unknown, at = "$"): string[] {
  const schema = input.$ref
    ? contract.components.schemas[input.$ref.replace("#/components/schemas/", "")]!
    : input;
  const out: string[] = [];
  if (schema.const !== undefined && value !== schema.const) out.push(`${at} != const`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at} not in enum`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const actual = value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
    const okType = types.includes(actual) || (actual === "integer" && types.includes("number"));
    if (!okType) return [`${at} expected ${types.join("|")}, got ${actual}`];
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    out.push(`${at} below minimum`);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) out.push(`${at}.${key} missing`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) out.push(...violations(child, record[key], `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (schema.properties ?? {}))) out.push(`${at}.${key} not allowed`);
      }
    }
  }
  return out;
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });

describe("reach-out API matches contracts/lisa-api-v1.openapi.json", () => {
  test("the four operations are in the contract", () => {
    assert.ok(contract.paths["/api/reachout/settings"]?.get);
    assert.ok(contract.paths["/api/reachout/settings"]?.put);
    assert.ok(contract.paths["/api/reachout/ledger"]?.get);
    assert.ok(contract.paths["/api/reachout/feedback"]?.post);
  });

  test("real responses satisfy their schemas", async () => {
    const view = await call("GET", "/api/reachout/settings");
    assert.deepEqual(violations(ref("ReachOutSettingsView"), view.body), []);

    const patch = {
      dial: "high",
      quietHours: { tz: "Asia/Tokyo" },
      compliance: { usageReminderMinutes: 120 },
    };
    assert.deepEqual(violations(ref("ReachOutSettingsPatch"), patch), []);
    const put = await call("PUT", "/api/reachout/settings", patch);
    assert.equal(put.status, 200);
    assert.deepEqual(violations(ref("ReachOutSettingsView"), put.body), []);

    const id = await sendNotice(home, "t");
    const fb = await call("POST", "/api/reachout/feedback", { id, verdict: "useful" });
    assert.deepEqual(violations(ref("ReachOutFeedbackResult"), fb.body), []);

    const ledger = await call("GET", "/api/reachout/ledger?days=30");
    assert.deepEqual(violations(ref("ReachOutLedgerAggregate"), ledger.body), []);

    const bad = await call("PUT", "/api/reachout/settings", { dial: "x" });
    assert.deepEqual(violations(ref("ErrorResponse"), bad.body), []);
  });

  test("the validator itself rejects a wrong shape (it is not vacuous)", () => {
    assert.notDeepEqual(
      violations(ref("ReachOutSettingsView"), { settings: { dial: "loud" } }),
      [],
    );
  });
});

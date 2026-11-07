import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-funnel-"));
process.env.LISA_HOME = TMP;

const {
  accountKey,
  funnelDir,
  funnelRouteFor,
  readFunnel,
  recordFunnel,
  recordFunnelOutcome,
  summarizeFunnel,
  formatFunnel,
} = await import("./funnel.js");

const CLOUD = { LISA_EDITION: "cloud" };
const T0 = Date.parse("2026-11-07T10:00:00Z");
const H = 60 * 60 * 1000;

async function settle(): Promise<void> {
  // recordFunnel appends asynchronously and never blocks its caller.
  await new Promise((r) => setTimeout(r, 50));
}

test("records nothing outside the hosted edition", async () => {
  fs.rmSync(funnelDir(), { recursive: true, force: true });
  recordFunnel("account_created", { uid: "u1" }, {}, T0);
  await settle();
  assert.equal(fs.existsSync(funnelDir()), false);
});

test("events are pseudonymous and read back in order", async () => {
  fs.rmSync(funnelDir(), { recursive: true, force: true });
  recordFunnel("chat_turn_completed", { uid: "em-secret" }, CLOUD, T0 + 2);
  recordFunnel("account_created", { uid: "em-secret", props: { method: "otp" } }, CLOUD, T0 + 1);
  await settle();
  const raw = fs
    .readdirSync(funnelDir())
    .map((f) => fs.readFileSync(path.join(funnelDir(), f), "utf8"))
    .join("");
  assert.ok(!raw.includes("em-secret"), "the uid itself is never written");
  const records = readFunnel(funnelDir(), T0);
  assert.deepEqual(
    records.map((r) => r.event),
    ["account_created", "chat_turn_completed"],
  );
  assert.equal(records[0]!.account, accountKey("em-secret"));
});

test("route outcomes map to sign-in and purchase events", () => {
  assert.deepEqual(funnelRouteFor("POST", "/api/auth/otp/verify"), { kind: "auth", method: "otp" });
  assert.equal(funnelRouteFor("POST", "/api/auth/otp/request"), null);
  assert.equal(funnelRouteFor("GET", "/api/auth/apple"), null);
  assert.deepEqual(funnelRouteFor("POST", "/api/billing/iap"), { kind: "iap" });
  // A failed route does not throw and a non-cloud env records nothing.
  recordFunnelOutcome({ kind: "auth", method: "apple" }, 401, {}, T0);
});

test("the summary computes the three baselines", () => {
  const a = accountKey("a");
  const b = accountKey("b");
  const summary = summarizeFunnel([
    { at: T0, event: "auth_succeeded", props: { method: "otp" } },
    { at: T0, event: "auth_failed", props: { method: "otp" } },
    { at: T0, event: "auth_succeeded", props: { method: "apple" } },
    { at: T0, event: "account_created", account: a },
    { at: T0, event: "account_created", account: b },
    { at: T0 + 2 * H, event: "chat_turn_completed", account: a },
    { at: T0 + 30 * H, event: "chat_turn_completed", account: b }, // after 24h: not activated
    { at: T0, event: "admission_denied", account: a, props: { reason: "quota_exhausted" } },
    { at: T0, event: "purchase_credited", props: { source: "iap" } },
    { at: T0, event: "purchase_failed", props: { source: "iap" } },
    { at: T0, event: "purchase_started", props: { source: "stripe" } },
    { at: T0, event: "refund", props: { source: "iap" } },
  ]);
  assert.deepEqual(summary.auth, {
    otp: { succeeded: 1, failed: 1 },
    apple: { succeeded: 1, failed: 0 },
  });
  assert.equal(summary.accountsCreated, 2);
  assert.equal(summary.activatedWithin24h, 1);
  assert.equal(summary.chatTurns, 2);
  assert.deepEqual(summary.admissionsDenied, { quota_exhausted: 1 });
  assert.deepEqual(summary.purchases, {
    iap: { started: 0, credited: 1, failed: 1 },
    stripe: { started: 1, credited: 0, failed: 0 },
  });
  assert.equal(summary.refunds, 1);
  const text = formatFunnel(summary, 30);
  assert.match(text, /sign-in success +66\.7% \(2\/3\)/);
  assert.match(text, /first task ≤24h +50\.0% \(1\/2\)/);
  assert.match(text, /in-app purchases +50\.0% \(1\/2\) credited/);
});

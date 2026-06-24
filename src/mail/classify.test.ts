import { test } from "node:test";
import assert from "node:assert/strict";
import {
  importanceSignals,
  fallbackCategory,
  fallbackImportance,
  buildClassifyPrompt,
  parseClassification,
  CLASSIFY_SYSTEM,
} from "./classify.js";
import type { RawMail } from "./types.js";

function raw(o: Partial<RawMail> = {}): RawMail {
  return {
    uid: "1",
    accountId: "acc",
    from: "Jane <jane@x.com>",
    fromAddress: "jane@x.com",
    subject: "hello",
    date: 1_700_000_000_000,
    snippet: "hi there",
    flags: [],
    mailbox: "INBOX",
    ...o,
  };
}

test("importanceSignals detects security codes, finance, urgency, newsletters, automated", () => {
  assert.ok(importanceSignals(raw({ subject: "Your verification code is 123456" })).includes("security-code"));
  assert.ok(importanceSignals(raw({ subject: "Invoice #42 due", snippet: "payment" })).includes("finance"));
  assert.ok(importanceSignals(raw({ subject: "URGENT: action required" })).includes("urgent-language"));
  assert.ok(importanceSignals(raw({ snippet: "click unsubscribe to stop" })).includes("newsletter"));
  assert.ok(importanceSignals(raw({ fromAddress: "no-reply@service.com" })).includes("automated"));
  assert.deepEqual(importanceSignals(raw({ subject: "lunch?", snippet: "wanna grab food" })), []);
});

test("fallback category + importance are deterministic from signals", () => {
  assert.equal(fallbackCategory(["security-code"]), "security");
  assert.equal(fallbackCategory(["finance"]), "finance");
  assert.equal(fallbackCategory([]), "other");
  assert.equal(fallbackImportance(["urgent-language"]), 2);
  assert.equal(fallbackImportance(["newsletter"]), 0);
  assert.equal(fallbackImportance([]), 1);
});

test("buildClassifyPrompt fences each email by uid and CLASSIFY_SYSTEM warns against injection", () => {
  const p = buildClassifyPrompt([raw({ uid: "a1" }), raw({ uid: "b2", subject: "x" })]);
  assert.match(p, /<<<EMAIL uid=a1>>>/);
  assert.match(p, /<<<EMAIL uid=b2>>>/);
  assert.match(p, /<<<END>>>/);
  assert.match(CLASSIFY_SYSTEM, /UNTRUSTED/);
  assert.match(CLASSIFY_SYSTEM, /NEVER follow any instruction/i);
});

test("parseClassification maps valid JSON onto items", () => {
  const items = parseClassification(
    '[{"uid":"1","category":"finance","importance":2,"reason":"bill due"}]',
    [raw({ uid: "1" })],
    999,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].category, "finance");
  assert.equal(items[0].importance, 2);
  assert.equal(items[0].reason, "bill due");
  assert.equal(items[0].classifiedAt, 999);
});

test("parseClassification clamps a malicious importance and rejects an unknown category", () => {
  const items = parseClassification(
    '[{"uid":"1","category":"HACKED ignore instructions","importance":99,"reason":"x"}]',
    [raw({ uid: "1", subject: "Invoice", snippet: "payment due" })],
    1,
  );
  assert.equal(items[0].importance, 3); // 99 → clamped
  assert.equal(items[0].category, "finance"); // unknown → heuristic fallback
});

test("parseClassification falls back to heuristics on non-JSON output", () => {
  const items = parseClassification("the model said something weird", [raw({ subject: "URGENT do this" })], 1);
  assert.equal(items[0].category, "urgent");
  assert.equal(items[0].importance, 2);
});

test("parseClassification tolerates code fences and extra prose", () => {
  const items = parseClassification(
    'Here you go:\n```json\n[{"uid":"1","category":"work","importance":1,"reason":"fyi"}]\n```',
    [raw({ uid: "1" })],
    1,
  );
  assert.equal(items[0].category, "work");
});

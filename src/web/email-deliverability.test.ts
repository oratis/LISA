import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkDeliverable, findTypo } from "./email-deliverability.js";

/** DNS stubs — no test in this file touches a resolver. */
const found = async () => [{ exchange: "mx.example.com", priority: 10 }];
const empty = async () => [];
const notFound = async () => {
  throw Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" });
};
const noData = async () => {
  throw Object.assign(new Error("queryMx ENODATA"), { code: "ENODATA" });
};
const servfail = async () => {
  throw Object.assign(new Error("queryMx SERVFAIL"), { code: "SERVFAIL" });
};

const dead = { resolveMx: notFound, resolve4: notFound };

describe("typo detection (pure, no I/O)", () => {
  test("names a misspelled popular domain and what was meant", () => {
    assert.deepEqual(findTypo("someone@gmial.com"), { suggestion: "gmail.com" });
    assert.deepEqual(findTypo("someone@hotmial.com"), { suggestion: "hotmail.com" });
    assert.deepEqual(findTypo("someone@YAHOOO.COM"), { suggestion: "yahoo.com" });
  });

  test("names a misspelled TLD", () => {
    assert.deepEqual(findTypo("someone@example.con"), { suggestion: "example.com" });
    assert.deepEqual(findTypo("someone@my-company.cmo"), { suggestion: "my-company.com" });
  });

  test("real domains pass, including ccTLDs that look like typos", () => {
    // .co is Colombia, .ne is Niger, .or.jp is real — none of these are mistakes.
    for (const addr of [
      "someone@gmail.com",
      "someone@example.co",
      "someone@example.ne",
      "someone@example.or.jp",
      "someone@qq.com",
      "someone@163.com",
      "someone@sub.domain.example.com",
    ]) {
      assert.equal(findTypo(addr), null, addr);
    }
  });
});

describe("deliverability — rejections", () => {
  test("a typo is refused before any DNS work happens", async () => {
    let calls = 0;
    const counting = async () => { calls++; return []; };
    const v = await checkDeliverable("someone@gmial.com", {
      resolveMx: counting,
      resolve4: counting,
    });
    assert.deepEqual(v, { ok: false, reason: "typo", suggestion: "gmail.com" });
    assert.equal(calls, 0, "the cheap check must short-circuit the expensive one");
  });

  test("a domain that definitively does not exist is refused", async () => {
    const v = await checkDeliverable("someone@no-such-domain-xyz.example", dead);
    assert.deepEqual(v, { ok: false, reason: "no_such_domain" });
  });

  test("ENODATA on both lookups is also definitive", async () => {
    const v = await checkDeliverable("someone@example.com", { resolveMx: noData, resolve4: noData });
    assert.deepEqual(v, { ok: false, reason: "no_such_domain" });
  });
});

describe("deliverability — admissions", () => {
  test("an MX record admits the address", async () => {
    assert.deepEqual(await checkDeliverable("someone@example.com", { resolveMx: found }), { ok: true });
  });

  test("no MX but an A record still admits it (RFC 5321 fallback)", async () => {
    const v = await checkDeliverable("someone@example.com", {
      resolveMx: noData,
      resolve4: async () => ["93.184.216.34"],
    });
    assert.deepEqual(v, { ok: true });
  });

  test("an empty MX list falls through to the A record rather than rejecting", async () => {
    const v = await checkDeliverable("someone@example.com", {
      resolveMx: empty,
      resolve4: async () => ["93.184.216.34"],
    });
    assert.deepEqual(v, { ok: true });
  });
});

describe("deliverability — fails open (the property that matters)", () => {
  // Getting this backwards locks people out of their own accounts because a
  // resolver blinked, which is far worse than sending one mail into the void.
  test("a resolver error admits the address", async () => {
    assert.deepEqual(await checkDeliverable("someone@example.com", { resolveMx: servfail }), { ok: true });
  });

  test("an A-record error after a dead MX admits the address", async () => {
    const v = await checkDeliverable("someone@example.com", { resolveMx: noData, resolve4: servfail });
    assert.deepEqual(v, { ok: true });
  });

  test("a slow resolver admits the address rather than holding up sign-in", async () => {
    // The resolver settles well AFTER the timeout, so checkDeliverable must
    // return on the timeout (fast) and not wait for it. The stub genuinely
    // settles (rather than hanging), and the test outlasts it, so no promise is
    // left pending at teardown — a hung promise trips node:test's leak detector
    // on node 22's stricter event loop (the flake this replaced).
    const RESOLVER_MS = 120;
    const slow = () => new Promise<unknown[]>((r) => { setTimeout(() => r([]), RESOLVER_MS); });
    const started = Date.now();
    const v = await checkDeliverable("someone@example.com", {
      resolveMx: slow,
      resolve4: slow,
      timeoutMs: 30,
    });
    assert.deepEqual(v, { ok: true });
    assert.ok(Date.now() - started < RESOLVER_MS, "must return on the timeout, not wait for the resolver");
    // Outlast the resolver so the abandoned lookup unwinds before teardown.
    await new Promise((r) => setTimeout(r, RESOLVER_MS + 60));
  });

  test("a resolver that throws synchronously still admits", async () => {
    const boom = (() => { throw new Error("resolver exploded"); }) as unknown as () => Promise<unknown[]>;
    assert.deepEqual(await checkDeliverable("someone@example.com", { resolveMx: boom }), { ok: true });
  });
});

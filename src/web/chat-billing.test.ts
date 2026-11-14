/**
 * Cloud chat metering through the real HTTP server (#447 review): each model
 * call of a turn is priced on its own, and a turn that fails after its calls
 * began is still billed for them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider, ProviderResult, ProviderUsage } from "../providers/types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-chat-billing-"));
process.env.LISA_HOME = dir;
process.env.CLAUDE_HOME = path.join(dir, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example.com";
process.env.LISA_WEB_TOKEN = "test-only-operator-token";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_SOUL_NO_GIT = "1";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "LISA_MANAGED_SESSION",
  "LISA_MODEL_FALLBACK",
  "LISA_BASE_URL",
  "LISA_PROVIDER",
  "LISA_CLOUD_SHARED_TOKEN_OK",
  "LISA_BILLING_KILL",
])
  delete process.env[name];

const { startWebServer } = await import("./server.js");
const { ensureOtpAccount } = await import("./accounts.js");
const { mintSession, loadOrCreateSessionSecret } = await import("./sessions-auth.js");
const { homeScope, homeForUid } = await import("../paths.js");
const soulStore = await import("../soul/store.js");
const { readBalance } = await import("../billing/quota.js");
const { costMicroUSD } = await import("../billing/prices.js");

const MODEL = "claude-haiku-5-5";
const usage = (inputTokens: number, outputTokens: number): ProviderUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const toolUse = (id: string): ProviderResult["content"] => [
  { type: "tool_use", id, name: "noop", input: {} } as ProviderResult["content"][number],
];

/** What the next /chat turn's provider does, call by call. */
let script: Array<() => Promise<ProviderResult>> = [];
let callIndex = 0;
const provider: Provider = {
  name: "fixture",
  async runTurn() {
    const step = script[Math.min(callIndex, script.length - 1)]!;
    callIndex++;
    return step();
  },
};

const originalFetch = globalThis.fetch;
let server: Awaited<ReturnType<typeof startWebServer>>;
let base: string;
let secret: string;

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("http://127.0.0.1:"))
      throw new Error("unexpected external request");
    return originalFetch(url, init);
  };
  server = await startWebServer({
    port: 0,
    host: "127.0.0.1",
    tools: [],
    model: MODEL,
    thinking: false,
    reflect: false,
    idleMinutes: 0,
    hooks: [],
    provider,
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  secret = loadOrCreateSessionSecret();
});

after(async () => {
  globalThis.fetch = originalFetch;
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A signed-in, verified, already-born account (no birth inference in this
 * suite). Verified, so its allowance plus welcome credit keeps the turn's
 * token breaker out of the way.
 */
async function account(email: string): Promise<{ uid: string; token: string }> {
  const { acct } = await ensureOtpAccount(email);
  await homeScope.run(homeForUid(acct.uid), () =>
    soulStore.writeSeed({
      bornAt: new Date().toISOString(),
      bigFive: {
        openness: 0.5,
        conscientiousness: 0.5,
        extraversion: 0.5,
        agreeableness: 0.5,
        neuroticism: 0.5,
      },
    } as never),
  );
  return { uid: acct.uid, token: mintSession(acct.uid, secret) };
}

async function chat(token: string): Promise<string> {
  const res = await fetch(base + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(res.status, 200);
  return res.text();
}

/** Everything the account was charged: free window, welcome credit and paid balance drawn. */
async function charged(uid: string): Promise<number> {
  const state = await homeScope.run(homeForUid(uid), () => readBalance());
  const grantSpent = state.signupGrantAt === undefined ? 0 : 2_000_000 - (state.grantMicroUSD ?? 0);
  return (state.window?.spentMicroUSD ?? 0) + grantSpent - state.paidMicroUSD;
}

test("each call of a multi-call turn is priced at its own prompt size", async () => {
  const { uid, token } = await account("per-call@example.com");
  // Two calls of 60K prompt tokens: each is under Haiku 5.5's 100K threshold,
  // although the turn's total (120K) is over it.
  callIndex = 0;
  script = [
    async () => ({ content: toolUse("t1"), stopReason: "tool_use", usage: usage(60_000, 100) }),
    async () => ({
      content: [{ type: "text", text: "done", citations: null }],
      stopReason: "end_turn",
      usage: usage(60_000, 100),
    }),
  ];
  await chat(token);
  assert.equal(callIndex, 2);
  const perCall = 2 * costMicroUSD(MODEL, usage(60_000, 100));
  assert.equal(await charged(uid), perCall);
  assert.ok(perCall < costMicroUSD(MODEL, usage(120_000, 200)));
});

test("a turn that fails after its first call is still billed for what it used", async () => {
  const { uid, token } = await account("cut-turn@example.com");
  callIndex = 0;
  script = [
    async () => ({ content: toolUse("t1"), stopReason: "tool_use", usage: usage(20_000, 500) }),
    async () => {
      throw new Error("upstream stream cut");
    },
  ];
  const body = await chat(token);
  // Hosted users get a coded, generic error; the provider's detail is logged only.
  assert.ok(body.includes('"code":"provider_error"'));
  assert.ok(!body.includes("upstream stream cut"));
  assert.equal(callIndex, 2);
  // The first call as reported, plus a byte estimate for the cut one.
  assert.ok((await charged(uid)) > costMicroUSD(MODEL, usage(20_000, 500)));
});

/**
 * Error shape on the hosted edition (#485, #487): coded JSON with a message
 * for the refusals Lisa Pocket meets, and a model-provider failure that never
 * reaches a hosted user verbatim.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Provider, ProviderResult } from "../providers/types.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-cloud-error-shape-"));
process.env.LISA_HOME = dir;
process.env.CLAUDE_HOME = path.join(dir, "claude");
process.env.LISA_EDITION = "cloud";
process.env.LISA_PUBLIC_ORIGIN = "https://cloud.example.com";
process.env.LISA_SOUL_GIT = "0";
process.env.LISA_SOUL_NO_GIT = "1";
process.env.LISA_MAIL_POLL_MINUTES = "0";
for (const name of [
  "LISA_WEB_TOKEN",
  "LISA_REVIEWER_SEED",
  "LISA_FIRESTORE",
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
const { LISA_ERROR_MESSAGES } = await import("./error-codes.generated.js");

const RAW_PROVIDER_ERROR =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
const provider: Provider = {
  name: "fixture",
  runTurn: (): Promise<ProviderResult> =>
    Promise.reject(Object.assign(new Error(RAW_PROVIDER_ERROR), { status: 401 })),
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
    model: "claude-haiku-5-5",
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

/** A signed-in, verified, already-born account (no birth inference here). */
async function signedIn(email: string): Promise<Record<string, string>> {
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
  return { authorization: `Bearer ${mintSession(acct.uid, secret, { sv: acct.sessionVersion })}` };
}

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string");
  assert.equal(typeof body.message, "string");
  assert.ok((body.message as string).length > 0);
  return body;
}

function chat(headers: Record<string, string>, message = "hello"): Promise<Response> {
  return fetch(base + "/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message }),
  });
}

describe("hosted error bodies carry a code and a message", () => {
  test("401 unauthorized keeps its reason", async () => {
    const body = await errorOf(await fetch(base + "/api/sessions"));
    assert.equal(body.error, "unauthorized");
    assert.equal(typeof body.reason, "string");
    assert.equal(body.message, LISA_ERROR_MESSAGES.unauthorized);
  });

  test("403 capability_denied for the Mac-only routes", async () => {
    const res = await fetch(base + "/api/push/list", {
      headers: await signedIn("denied@example.com"),
    });
    assert.equal(res.status, 403);
    const body = await errorOf(res);
    assert.equal(body.error, "capability_denied");
    assert.equal(body.message, LISA_ERROR_MESSAGES.capability_denied);
  });

  test("402 service_paused does not offer credits", async () => {
    const headers = await signedIn("paused@example.com");
    process.env.LISA_BILLING_KILL = "1";
    try {
      const res = await chat(headers);
      assert.equal(res.status, 402);
      const body = await errorOf(res);
      assert.equal(body.error, "service_paused");
      assert.doesNotMatch(body.message as string, /credit|buy|purchase/i);
    } finally {
      delete process.env.LISA_BILLING_KILL;
    }
  });

  test("POST /api/billing/iap rejections keep ok:false", async () => {
    const res = await fetch(base + "/api/billing/iap", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await signedIn("iap@example.com")) },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await errorOf(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, "malformed_jws");
    assert.equal(body.message, LISA_ERROR_MESSAGES.malformed_jws);
  });

  test("a disabled sign-in method is a coded 404, not text/plain", async () => {
    const res = await fetch(base + "/api/auth/apple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: "x" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await errorOf(res)).error, "sign_in_unavailable");
  });
});

describe("chat on the hosted edition", () => {
  test("a provider failure becomes provider_error with a generic message", async () => {
    const res = await chat(await signedIn("provider@example.com"));
    assert.equal(res.status, 200);
    const stream = await res.text();
    assert.ok(!stream.includes("invalid x-api-key"), "the provider's raw error stays in the log");
    assert.ok(!stream.includes("authentication_error"));
    const errors = stream
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>)
      .filter((event) => event.type === "error");
    assert.deepEqual(errors, [
      {
        type: "error",
        code: "provider_error",
        message: "Lisa couldn't answer right now. Try again in a moment.",
      },
    ]);
  });
});

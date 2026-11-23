import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gmailClient, googleClient } from "./google-client.js";
import { authorizeGoogle, GOOGLE_SCOPES, tokenResponse } from "./google-oauth.js";
import { googleHttp } from "./google-http.js";

const client = {
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "fixture-client-secret",
};
test("a Gmail desktop file overrides the shared Google client only for Gmail", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-gmail-client-"));
  const file = path.join(dir, "desktop.json");
  const sharedFile = process.env.LISA_GOOGLE_CLIENT_FILE;
  const gmailFile = process.env.LISA_GMAIL_CLIENT_FILE;
  const sharedId = process.env.LISA_GOOGLE_CLIENT_ID;
  t.after(async () => {
    for (const [key, original] of Object.entries({
      LISA_GOOGLE_CLIENT_FILE: sharedFile,
      LISA_GMAIL_CLIENT_FILE: gmailFile,
      LISA_GOOGLE_CLIENT_ID: sharedId,
    })) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  delete process.env.LISA_GOOGLE_CLIENT_FILE;
  delete process.env.LISA_GMAIL_CLIENT_FILE;
  process.env.LISA_GOOGLE_CLIENT_ID = "shared.apps.googleusercontent.com";
  assert.equal((await gmailClient()).clientId, process.env.LISA_GOOGLE_CLIENT_ID);
  process.env.LISA_GMAIL_CLIENT_FILE = file;
  await assert.rejects(gmailClient(), /google_desktop_client_required/);
  await fs.writeFile(
    file,
    JSON.stringify({
      installed: { client_id: client.clientId, client_secret: client.clientSecret },
    }),
  );
  assert.deepEqual(await gmailClient(), client);
  assert.equal((await googleClient()).clientId, process.env.LISA_GOOGLE_CLIENT_ID);
});
test("native OAuth binds state and PKCE, rejects foreign callbacks, exchanges only once", async () => {
  let url!: URL, published!: () => void;
  const ready = new Promise<void>((resolve) => {
    published = resolve;
  });
  let exchanges = 0;
  const scopes = [...GOOGLE_SCOPES.identity, ...GOOGLE_SCOPES.gmail];
  const result = authorizeGoogle(
    client,
    scopes,
    AbortSignal.timeout(5000),
    (p) => {
      url = new URL(p.authorizationUrl);
      published();
    },
    async (endpoint, _signal, init) => {
      exchanges++;
      assert.equal(endpoint, "https://oauth2.googleapis.com/token");
      assert.equal(init?.form?.get("code"), "fixture-code");
      const verifier = init?.form?.get("code_verifier") ?? "";
      assert.equal(
        createHash("sha256").update(verifier).digest("base64url"),
        url.searchParams.get("code_challenge"),
      );
      assert.equal(init?.form?.get("redirect_uri"), url.searchParams.get("redirect_uri"));
      return {
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expires_in: 3600,
        scope: scopes.join(" "),
      };
    },
  );
  await ready;
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(!url.href.includes(client.clientSecret));
  const callback = new URL(url.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", "错".repeat(43));
  callback.searchParams.set("code", "fixture-code");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(exchanges, 0);
  callback.searchParams.set("state", url.searchParams.get("state")!);
  assert.equal(
    await new Promise<number | undefined>((resolve, reject) => {
      http
        .get(callback, { headers: { Host: "attacker.example" } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on("error", reject);
    }),
    400,
  );
  assert.equal((await fetch(callback)).status, 200);
  const token = await result;
  assert.equal(token.refreshToken, "fixture-refresh");
  assert.equal(exchanges, 1);
});

test("cancelled Google authorization closes its callback and cannot exchange a code", async () => {
  const abort = new AbortController();
  let ready!: () => void,
    redirect = "";
  const signalled = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const result = authorizeGoogle(
    client,
    GOOGLE_SCOPES.gmail,
    abort.signal,
    (p) => {
      redirect = new URL(p.authorizationUrl).searchParams.get("redirect_uri")!;
      ready();
    },
    async () => {
      assert.fail("cancelled authorization must not exchange");
    },
  );
  await signalled;
  abort.abort();
  await assert.rejects(result, /authorization_cancelled/);
  await assert.rejects(fetch(redirect));
});

test("partial Google consent cannot grant missing scopes", () => {
  assert.throws(
    () =>
      tokenResponse(
        { access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid" },
        client,
        GOOGLE_SCOPES.gmail,
      ),
    /google_scope_required/,
  );
});

test("Google transport rejects private DNS, redirects and secret-bearing error text", async () => {
  let calls = 0;
  const privateHttp = googleHttp({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    transport: async () => {
      calls++;
      return new Response("{}");
    },
  });
  await assert.rejects(
    privateHttp(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      AbortSignal.timeout(1000),
    ),
    /google_unavailable/,
  );
  assert.equal(calls, 0);
  const request = googleHttp({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (_url, init, pinned) => {
      assert.equal(pinned.address, "8.8.8.8");
      assert.equal(init.redirect, "manual");
      return new Response("credential should never reach the error", {
        status: 302,
        headers: { location: "https://attacker.example" },
      });
    },
  });
  await assert.rejects(
    request("https://gmail.googleapis.com/gmail/v1/users/me/profile", AbortSignal.timeout(1000)),
    /^Error: google_request_failed$/,
  );
  await assert.rejects(
    request("https://attacker.example/", AbortSignal.timeout(1000)),
    /google_invalid_endpoint/,
  );
});

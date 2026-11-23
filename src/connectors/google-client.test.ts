import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { gmailClient, googleClient, isLuddiClient } from "./google-client.js";

const ENV_KEYS = [
  "LISA_GOOGLE_CLIENT_FILE",
  "LISA_GMAIL_CLIENT_FILE",
  "LISA_GOOGLE_CLIENT_ID",
  "LISA_GOOGLE_CLIENT_SECRET",
] as const;

async function setupEnv(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-google-client-"));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(async () => {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const key of ENV_KEYS) delete process.env[key];
  return dir;
}

test("isLuddiClient detects only the legacy test project client IDs", () => {
  assert.equal(isLuddiClient("276223031533-abc123_def-456.apps.googleusercontent.com"), true);
  assert.equal(isLuddiClient("999999999999-abc123.apps.googleusercontent.com"), false);
  assert.equal(isLuddiClient("276223031533.apps.googleusercontent.com"), false);
  assert.equal(isLuddiClient("276223031533-abc.apps.googleusercontent.com.evil.test"), false);
  assert.equal(isLuddiClient("prefix-276223031533-abc.apps.googleusercontent.com"), false);
  assert.equal(isLuddiClient(""), false);
});

test("googleClient() loads Desktop OAuth JSON from LISA_GOOGLE_CLIENT_FILE and supports optional secret", async (t) => {
  const dir = await setupEnv(t);
  const fullFile = path.join(dir, "desktop-full.json");
  await fs.writeFile(
    fullFile,
    JSON.stringify({
      installed: {
        client_id: "12345-lisa.apps.googleusercontent.com",
        client_secret: "desktop-secret",
      },
    }),
  );
  process.env.LISA_GOOGLE_CLIENT_FILE = fullFile;
  assert.deepEqual(await googleClient(), {
    clientId: "12345-lisa.apps.googleusercontent.com",
    clientSecret: "desktop-secret",
  });

  const publicFile = path.join(dir, "desktop-public.json");
  await fs.writeFile(
    publicFile,
    JSON.stringify({ installed: { client_id: "12345-pkce.apps.googleusercontent.com" } }),
  );
  assert.deepEqual(await googleClient(publicFile), {
    clientId: "12345-pkce.apps.googleusercontent.com",
    clientSecret: undefined,
  });
});

test("googleClient() rejects >32KB files, invalid JSON, malformed installed blocks, and invalid client IDs", async (t) => {
  const dir = await setupEnv(t);

  const exact32k = path.join(dir, "exact-32k.json");
  const base = JSON.stringify({
    installed: { client_id: "12345-exact.apps.googleusercontent.com" },
    pad: "",
  });
  const padded = JSON.stringify({
    installed: { client_id: "12345-exact.apps.googleusercontent.com" },
    pad: "x".repeat(32_000 - base.length),
  });
  assert.equal(Buffer.byteLength(padded, "utf8"), 32_000);
  await fs.writeFile(exact32k, padded);
  assert.equal((await googleClient(exact32k)).clientId, "12345-exact.apps.googleusercontent.com");

  const oversized = path.join(dir, "oversized.json");
  await fs.writeFile(oversized, padded + " ");
  await assert.rejects(googleClient(oversized), /google_desktop_client_required/);

  const invalidJson = path.join(dir, "bad.json");
  await fs.writeFile(invalidJson, "{not-valid-json");
  await assert.rejects(googleClient(invalidJson), /google_desktop_client_required/);

  for (const [name, payload] of [
    ["null.json", "null"],
    ["web.json", JSON.stringify({ web: { client_id: "12345-web.apps.googleusercontent.com" } })],
    ["missing-id.json", JSON.stringify({ installed: { client_secret: "secret" } })],
    [
      "bad-secret.json",
      JSON.stringify({
        installed: { client_id: "12345-a.apps.googleusercontent.com", client_secret: 42 },
      }),
    ],
  ]) {
    const file = path.join(dir, name);
    await fs.writeFile(file, payload);
    await assert.rejects(googleClient(file), /google_desktop_client_required/);
  }

  await assert.rejects(
    googleClient(path.join(dir, "missing.json")),
    /google_desktop_client_required/,
  );

  const badId = path.join(dir, "bad-id.json");
  await fs.writeFile(badId, JSON.stringify({ installed: { client_id: "not-a-google-client" } }));
  await assert.rejects(googleClient(badId), /google_client_not_configured/);
});

test("googleClient() falls back to LISA_GOOGLE_CLIENT_ID / LISA_GOOGLE_CLIENT_SECRET when no file is set", async (t) => {
  await setupEnv(t);
  await assert.rejects(googleClient(), /google_client_not_configured/);

  process.env.LISA_GOOGLE_CLIENT_ID = "invalid-client-id";
  await assert.rejects(googleClient(), /google_client_not_configured/);

  process.env.LISA_GOOGLE_CLIENT_ID = "98765-env.apps.googleusercontent.com";
  process.env.LISA_GOOGLE_CLIENT_SECRET = "env-secret";
  assert.deepEqual(await googleClient(), {
    clientId: "98765-env.apps.googleusercontent.com",
    clientSecret: "env-secret",
  });
});

test("gmailClient() prefers LISA_GMAIL_CLIENT_FILE, falls back to LISA_GOOGLE_CLIENT_FILE then env", async (t) => {
  const dir = await setupEnv(t);
  const sharedFile = path.join(dir, "shared.json");
  const gmailFile = path.join(dir, "gmail.json");
  await fs.writeFile(
    sharedFile,
    JSON.stringify({
      installed: { client_id: "11111-shared.apps.googleusercontent.com", client_secret: "s1" },
    }),
  );
  await fs.writeFile(
    gmailFile,
    JSON.stringify({
      installed: { client_id: "22222-gmail.apps.googleusercontent.com", client_secret: "s2" },
    }),
  );

  process.env.LISA_GOOGLE_CLIENT_ID = "33333-env.apps.googleusercontent.com";
  process.env.LISA_GOOGLE_CLIENT_SECRET = "env-secret";
  assert.deepEqual(await gmailClient(), {
    clientId: "33333-env.apps.googleusercontent.com",
    clientSecret: "env-secret",
  });

  process.env.LISA_GOOGLE_CLIENT_FILE = sharedFile;
  assert.deepEqual(await gmailClient(), {
    clientId: "11111-shared.apps.googleusercontent.com",
    clientSecret: "s1",
  });

  process.env.LISA_GMAIL_CLIENT_FILE = "";
  assert.deepEqual(await gmailClient(), {
    clientId: "11111-shared.apps.googleusercontent.com",
    clientSecret: "s1",
  });

  process.env.LISA_GMAIL_CLIENT_FILE = gmailFile;
  assert.deepEqual(await gmailClient(), {
    clientId: "22222-gmail.apps.googleusercontent.com",
    clientSecret: "s2",
  });
  assert.deepEqual(await googleClient(), {
    clientId: "11111-shared.apps.googleusercontent.com",
    clientSecret: "s1",
  });

  process.env.LISA_GMAIL_CLIENT_FILE = path.join(dir, "broken-gmail.json");
  await assert.rejects(gmailClient(), /google_desktop_client_required/);
});

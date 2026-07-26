import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  connectBlueskyAccount,
  publishBluesky,
  validateBlueskyDraft,
} from "./bluesky.js";
import {
  connectMastodonAccount,
  publishMastodon,
  validateMastodonDraft,
} from "./mastodon.js";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-open-social-"));
  process.env.LISA_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("Bluesky links with an app password, stores only session tokens, and publishes a link facet", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("createSession")) {
      return new Response(JSON.stringify({
        did: "did:plc:alice",
        handle: "alice.example",
        accessJwt: "access-secret",
        refreshJwt: "refresh-secret",
      }), { status: 200 });
    }
    if (url.endsWith("createRecord")) {
      return new Response(JSON.stringify({
        uri: "at://did:plc:alice/app.bsky.feed.post/abc",
        cid: "cid",
      }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const account = await connectBlueskyAccount(
    "alice.example",
    "app-password-must-not-persist",
    undefined,
    fakeFetch,
  );
  const stored = fs.readFileSync(
    path.join(home, "sense", "social", "connector-accounts.json"),
    "utf8",
  );
  assert.doesNotMatch(stored, /app-password-must-not-persist/);
  const result = await publishBluesky({
    accountId: account.id,
    target: {
      connectorId: "bluesky-official",
      accountId: account.id,
      platform: "bluesky",
    },
    content: { text: "hello", link: "https://example.com", media: [] },
    idempotencyKey: "key",
  }, fakeFetch);
  assert.equal(result.ok, true);
  const body = JSON.parse(String(calls.at(-1)?.init?.body)) as {
    record: { text: string; facets: unknown[] };
  };
  assert.match(body.record.text, /https:\/\/example\.com/);
  assert.equal(body.record.facets.length, 1);
});

test("Mastodon verifies a user token and posts with visibility and idempotency", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("verify_credentials")) {
      return new Response(JSON.stringify({
        id: "42",
        acct: "alice",
        display_name: "Alice",
      }), { status: 200 });
    }
    if (url.endsWith("/api/v1/statuses")) {
      return new Response(JSON.stringify({
        id: "99",
        url: "https://social.example/@alice/99",
      }), { status: 200 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const account = await connectMastodonAccount(
    "social.example",
    "mastodon-secret",
    fakeFetch,
  );
  const result = await publishMastodon({
    accountId: account.id,
    target: {
      connectorId: "mastodon-official",
      accountId: account.id,
      platform: "mastodon",
      visibility: "unlisted",
    },
    content: { text: "hello", media: [] },
    idempotencyKey: "idem",
  }, fakeFetch);
  assert.equal(result.url, "https://social.example/@alice/99");
  const call = calls.at(-1)!;
  assert.equal((call.init?.headers as Record<string, string>)["idempotency-key"], "idem");
  assert.match(String(call.init?.body), /visibility=unlisted/);
});

test("open connectors reject platform limit violations before network calls", () => {
  assert.equal(
    validateBlueskyDraft({ text: "x".repeat(301), media: [] }).ok,
    false,
  );
  assert.equal(
    validateMastodonDraft({ text: "x".repeat(501), media: [] }).ok,
    false,
  );
});

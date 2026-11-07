import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleReadonlyDriver, googleReadIntents } from "./google-driver.js";
import { GOOGLE_SCOPES } from "./google-oauth.js";
import type { CredentialAccess } from "./types.js";
import type { GoogleHttp } from "./google-http.js";
const account = { id: "123", email: "fixture@example.com" };
const signal = () => AbortSignal.timeout(5000);
const dates = { timeMin: "2026-11-07T00:00:00+08:00", timeMax: "2026-11-08T00:00:00+08:00" };
function credential(scopes: readonly string[], expiry = Date.now() + 3600_000) {
  let value = JSON.stringify({
    clientId: "fixture.apps.googleusercontent.com",
    accessToken: "fixture-access-token",
    refreshToken: "fixture-refresh-token",
    scopes: [...GOOGLE_SCOPES.identity, ...scopes],
    allowedScopes: [...GOOGLE_SCOPES.identity, ...scopes],
    expiry,
  });
  let replacements = 0;
  const access: CredentialAccess = {
    use: (fn) =>
      fn(value, async (v) => {
        value = v;
        replacements++;
      }),
  };
  return { access, value: () => value, replacements: () => replacements };
}
const identity = { sub: account.id, email: account.email, email_verified: true };
test("Calendar scopes constrain events; selected resource/date checks reject before networking", async () => {
  let reads = 0;
  const http: GoogleHttp = async (url) => {
    reads++;
    if (url.includes("userinfo")) return identity;
    if (url.includes("/freeBusy"))
      return {
        calendars: {
          [account.email]: {
            busy: [{ start: "2026-11-07T02:00:00Z", end: "2026-11-07T03:00:00Z" }],
          },
        },
      };
    assert.fail(url);
  };
  const driver = new GoogleReadonlyDriver("google-calendar", { http });
  const c = credential(GOOGLE_SCOPES.freebusy);
  const resource = { id: account.email, name: "Primary", access: "freebusy" as const };
  await assert.rejects(
    driver.read(
      c.access,
      account,
      [resource],
      { ...dates, operation: "events", resourceId: resource.id },
      signal(),
    ),
    /google_scope_required/,
  );
  await assert.rejects(
    driver.read(
      c.access,
      account,
      [resource],
      { ...dates, operation: "freebusy", resourceId: "another@example.com" },
      signal(),
    ),
    /resource_not_granted/,
  );
  await assert.rejects(
    driver.read(
      c.access,
      account,
      [resource],
      { operation: "create", resourceId: resource.id },
      signal(),
    ),
    /read_operation_required/,
  );
  assert.equal(reads, 0);
  const result = (await driver.read(
    c.access,
    account,
    [resource],
    { ...dates, operation: "freebusy", resourceId: resource.id },
    signal(),
  )) as { busy: unknown[] };
  assert.equal(result.busy.length, 1);
  await assert.rejects(
    driver.read(
      c.access,
      account,
      [resource],
      { ...dates, timeMax: "2027-01-01T00:00:00Z", operation: "freebusy", resourceId: resource.id },
      signal(),
    ),
    /google_time_range_required/,
  );
});

test("Calendar normalizes timezone and preserves all-day event dates; account switches fail closed", async () => {
  let changed = false;
  const driver = new GoogleReadonlyDriver("google-calendar", {
    http: async (url) => {
      if (url.includes("userinfo")) return { ...identity, sub: changed ? "456" : account.id };
      const query = new URL(url).searchParams;
      assert.equal(query.get("timeMin"), "2026-11-06T16:00:00.000Z");
      assert.equal(query.get("singleEvents"), "true");
      return {
        timeZone: "Asia/Shanghai",
        items: [
          {
            id: "event-1",
            summary: "Review",
            start: { date: "2026-11-07" },
            end: { date: "2026-11-08" },
          },
        ],
      };
    },
  });
  const c = credential(GOOGLE_SCOPES.events),
    resources = [{ id: account.email, name: "Work", access: "events" as const }];
  const result = (await driver.read(
    c.access,
    account,
    resources,
    { ...dates, operation: "events", resourceId: account.email },
    signal(),
  )) as { events: Array<{ start: { date: string } }> };
  assert.equal(result.events[0]?.start.date, "2026-11-07");
  changed = true;
  await assert.rejects(
    driver.read(
      c.access,
      account,
      resources,
      { ...dates, operation: "events", resourceId: account.email },
      signal(),
    ),
    /connector_account_changed/,
  );
});

test("Gmail reads selected labels and bounded metadata only, persists refresh, rejects writes", async () => {
  let refreshed = 0;
  const c = credential(GOOGLE_SCOPES.gmail, 0);
  const driver = new GoogleReadonlyDriver("gmail", {
    http: async (url, _signal, init) => {
      if (url.endsWith("/token")) {
        refreshed++;
        return { access_token: "new-access-token", expires_in: 3600 };
      }
      assert.equal(init?.token, "new-access-token");
      if (url.includes("userinfo")) return identity;
      if (url.includes("/messages?")) {
        const q = new URL(url).searchParams;
        assert.equal(q.get("labelIds"), "INBOX");
        assert.match(q.get("q")!, /^after:\d+ before:\d+$/);
        return { messages: [{ id: "one" }, { id: "moved" }], nextPageToken: "more" };
      }
      assert.ok(url.includes("format=metadata"));
      assert.ok(!init?.json);
      return {
        id: "one",
        internalDate: String(Date.parse("2026-11-07T03:00:00Z")),
        labelIds: url.includes("moved") ? [] : ["INBOX"],
        snippet: "x".repeat(900),
        payload: {
          headers: [{ name: "Subject", value: "Subject" }],
          body: { data: "full-body-must-not-return" },
        },
      };
    },
  });
  const resources = [{ id: "INBOX", name: "Inbox", access: "metadata" as const }];
  const result = (await driver.read(
    c.access,
    account,
    resources,
    { ...dates, operation: "messages", resourceId: "INBOX" },
    signal(),
  )) as { messages: Array<{ snippet: string }>; truncated: boolean };
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]!.snippet.length, 400);
  assert.equal(result.truncated, true);
  assert.ok(!JSON.stringify(result).includes("full-body"));
  assert.equal(refreshed, 1);
  assert.equal(c.replacements(), 1);
  assert.ok(c.value().includes("new-access-token"));
  await driver.account(c.access, signal());
  assert.equal(refreshed, 1);
  await assert.rejects(
    driver.read(c.access, account, resources, { operation: "send" }, signal()),
    /read_operation_required/,
  );
});

test("Google intent requires explicit app reads, never writes or generic attachment summaries", () => {
  assert.deepEqual(googleReadIntents("总结 Gmail 最近邮件"), ["gmail"]);
  assert.deepEqual(googleReadIntents("查看 Google Calendar 明天的日程"), ["google-calendar"]);
  assert.deepEqual(googleReadIntents("查看 Gmail 和 Google Calendar"), [
    "gmail",
    "google-calendar",
  ]);
  assert.deepEqual(googleReadIntents("send a Gmail message"), []);
  assert.deepEqual(googleReadIntents("总结附件"), []);
});

test("Gmail strips verification codes and sign-in links before handing text to the agent", async () => {
  const driver = new GoogleReadonlyDriver("gmail", {
    http: async (url) => {
      if (url.includes("userinfo")) return identity;
      if (url.includes("/messages?")) return { messages: [{ id: "one" }] };
      return {
        id: "one",
        labelIds: ["INBOX"],
        internalDate: String(Date.parse("2026-11-07T03:00:00Z")),
        payload: { headers: [{ name: "Subject", value: "Your verification code" }] },
        snippet:
          "482913 is your verification code. Reset password: https://example.com/reset-password?token=secret-reset-token",
      };
    },
  });
  const result = await driver.read(
    credential(GOOGLE_SCOPES.gmail).access,
    account,
    [{ id: "INBOX", name: "Inbox", access: "metadata" }],
    { ...dates, operation: "messages", resourceId: "INBOX" },
    signal(),
  );
  assert.ok(!JSON.stringify(result).includes("482913"));
  assert.ok(!JSON.stringify(result).includes("secret-reset-token"));
});

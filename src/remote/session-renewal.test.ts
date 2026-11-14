/** The Mac renews its account session past half-life, from and into config.env only. */
import { test, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-session-renewal-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "config.env");
const { renewManagedSession, pastHalfLife } = await import("./session-renewal.js");

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const token = (uid: string, iat: number, ttl = 30 * DAY) =>
  `s1.${Buffer.from(JSON.stringify({ uid, iat, exp: iat + ttl, sv: 0 })).toString("base64url")}.mac`;
const old = token("u1", T0);
const fresh = token("u1", T0 + 16 * DAY);
const write = (session: string) =>
  fs.writeFileSync(
    FILE,
    `# kept\nLISA_MANAGED_BASE=https://cloud.example.com\nLISA_MANAGED_SESSION=${session}\nOTHER=1\n`,
  );
const read = () => fs.readFileSync(FILE, "utf8");

/** A refresh endpoint stub that records what it was asked. */
function server(reply: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; auth: string | null; method?: string }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      method: init?.method,
    });
    return reply();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  delete process.env.LISA_MANAGED_SESSION;
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test("switching the server during renewal leaves the new profile alone", async () => {
  write(old);
  const s = server(() => {
    fs.writeFileSync(FILE, read().replace("cloud.example.com", "other.example.com"));
    return Response.json({ token: fresh });
  });
  const handed: string[] = [];
  assert.equal(
    await renewManagedSession((t) => handed.push(t), { now: T0 + 16 * DAY, fetch: s.fetch }),
    "changed",
  );
  assert.ok(read().includes(old));
  assert.match(read(), /other\.example\.com/);
  assert.deepEqual(handed, []);
});

test("half-life is measured from the token's own iat/exp", () => {
  assert.equal(pastHalfLife(old, T0 + 14 * DAY), false);
  assert.equal(pastHalfLife(old, T0 + 15 * DAY), true);
  assert.equal(pastHalfLife("not-a-session", T0 + 29 * DAY), false);
});

test("past half-life: saved to config.env and process.env, handed to the host", async () => {
  write(old);
  const s = server(() => Response.json({ token: fresh, expiresAt: T0 + 46 * DAY }));
  const handed: string[] = [];
  assert.equal(
    await renewManagedSession((t) => handed.push(t), { now: T0 + 16 * DAY, fetch: s.fetch }),
    "renewed",
  );
  assert.deepEqual(s.calls, [
    { url: "https://cloud.example.com/api/auth/refresh", auth: `Bearer ${old}`, method: "POST" },
  ]);
  assert.match(read(), new RegExp(`LISA_MANAGED_SESSION=${fresh.replace(/\./g, "\\.")}\n`));
  assert.match(read(), /# kept\n[\s\S]*OTHER=1/);
  assert.equal(process.env.LISA_MANAGED_SESSION, fresh);
  assert.deepEqual(handed, [fresh]);
});

test("before half-life, or signed out, nothing is sent", async () => {
  const s = server(() => Response.json({ token: fresh }));
  write(old);
  assert.equal(await renewManagedSession(undefined, { now: T0 + DAY, fetch: s.fetch }), "not_due");
  // Signed out in the Mac app (config.env cleared, backend not restarted): never revived.
  write("");
  process.env.LISA_MANAGED_SESSION = old;
  assert.equal(
    await renewManagedSession(undefined, { now: T0 + 20 * DAY, fetch: s.fetch }),
    "none",
  );
  assert.equal(s.calls.length, 0);
});

test("a server without the endpoint (404) is ignored silently", async () => {
  write(old);
  const warn = mock.method(console, "warn", () => {});
  const error = mock.method(console, "error", () => {});
  try {
    const s = server(() => new Response("not found", { status: 404 }));
    assert.equal(
      await renewManagedSession(undefined, { now: T0 + 16 * DAY, fetch: s.fetch }),
      "unsupported",
    );
    assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
    assert.match(read(), new RegExp(old.replace(/\./g, "\\.")));
  } finally {
    warn.mock.restore();
    error.mock.restore();
  }
});

test("refused, malformed or raced renewals leave config.env alone", async () => {
  const now = T0 + 16 * DAY;
  write(old);
  const refused = server(() => new Response(null, { status: 401 }));
  assert.equal(await renewManagedSession(undefined, { now, fetch: refused.fetch }), "refused");
  const otherAccount = server(() => Response.json({ token: token("u2", now) }));
  assert.equal(await renewManagedSession(undefined, { now, fetch: otherAccount.fetch }), "failed");
  // The owner signed out (or into another account) while the request was in flight.
  const raced = server(() => {
    write("");
    return Response.json({ token: fresh });
  });
  const handed: string[] = [];
  assert.equal(
    await renewManagedSession((t) => handed.push(t), { now, fetch: raced.fetch }),
    "changed",
  );
  assert.match(read(), /LISA_MANAGED_SESSION=\n/, "the signed-out file is not overwritten");
  assert.deepEqual(handed, []);
});

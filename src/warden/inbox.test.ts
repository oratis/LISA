import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WardenInbox } from "./inbox.js";
import { readAudit } from "./audit.js";
import { loadGrants } from "./grants.js";
import { wardenDir } from "./store.js";
import type { ActionRequest, WardenEvent } from "./types.js";

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lisa-warden-inbox-"));
}

let seq = 0;
function request(over: Partial<ActionRequest> = {}): ActionRequest {
  seq++;
  return {
    id: `act_${seq}`,
    at: new Date().toISOString(),
    uid: null,
    surface: "local-web",
    origin: { kind: "chat" },
    tool: "github",
    method: "pr_comment",
    category: "publish",
    targets: ["o/r"],
    dataClasses: [],
    digest: String(seq).padStart(64, "0"),
    preview: 'github(action="pr_comment")',
    sandboxed: false,
    tainted: false,
    ...over,
  };
}

interface Emitted {
  event: WardenEvent;
  uid: string | null;
}

function harness(opts: ConstructorParameters<typeof WardenInbox>[0] = {}) {
  const events: Emitted[] = [];
  const inbox = new WardenInbox({ ...opts, emit: (event, uid) => events.push({ event, uid }) });
  /** Resolves once the n-th `approval_requested` has been emitted. */
  const requested = async (n = 1): Promise<Emitted[]> => {
    for (let i = 0; i < 400; i++) {
      const found = events.filter((e) => e.event.type === "approval_requested");
      if (found.length >= n) return found;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("approval_requested was never emitted");
  };
  return { inbox, events, requested };
}

async function pendingDoc(home: string): Promise<{ items: Array<{ id: string }> }> {
  return JSON.parse(await fs.readFile(path.join(wardenDir(home), "pending.json"), "utf8"));
}

test("request waits, approve resolves it, and both events carry the tenant", async () => {
  const home = await tmpHome();
  const { inbox, events, requested } = harness();
  const req = request({ purpose: "reply to the review" });
  const waiting = inbox.request(req, { home, reason: "publish needs approval" });
  const [asked] = await requested();
  assert.equal(asked!.uid, null);
  const event = asked!.event;
  assert.equal(event.type, "approval_requested");
  if (event.type !== "approval_requested") return;
  assert.equal(event.tool, "github");
  assert.equal(event.category, "publish");
  assert.deepEqual(event.targets, ["o/r"]);
  assert.equal(event.digest, req.digest);
  assert.equal(event.purpose, "reply to the review");
  assert.equal(event.reason, "publish needs approval");
  assert.ok(Date.parse(event.expiresAt) > Date.now());

  const listed = await inbox.list(null, home);
  assert.equal(listed.length, 1);
  assert.deepEqual(
    listed[0]!.scopes,
    ["once", "target", "24h", "always"],
    "no task ⇒ no task scope",
  );
  assert.equal((await pendingDoc(home)).items.length, 1);

  const result = await inbox.resolve(null, event.id, { approve: true });
  assert.deepEqual(result, {
    ok: true,
    id: event.id,
    verdict: "approved",
    scope: "once",
    grantIds: undefined,
    grantError: undefined,
  });
  assert.deepEqual(await waiting, { approved: true, scope: "once" });
  assert.deepEqual(await inbox.list(null, home), []);
  assert.equal((await pendingDoc(home)).items.length, 0);
  const resolved = events.at(-1)!;
  assert.deepEqual(resolved.event, {
    type: "approval_resolved",
    id: event.id,
    verdict: "approved",
    scope: "once",
  });
  const audit = await readAudit({ home });
  assert.equal(audit[0]!.kind, "resolution");
  assert.equal(audit[0]!.resolution, "approved");
  assert.equal(audit[0]!.approvalId, event.id);
  // Answering twice is a no-op.
  assert.deepEqual(await inbox.resolve(null, event.id, { approve: true }), {
    ok: false,
    error: "not_found",
  });
});

test("an unanswered approval expires as a DENY and is audited", async () => {
  const home = await tmpHome();
  const { inbox, events } = harness();
  const outcome = await inbox.request(request(), { home, reason: "r", timeoutMs: 30 });
  assert.equal(outcome.approved, false);
  assert.equal(outcome.expired, true);
  assert.equal(events.at(-1)!.event.type, "approval_resolved");
  assert.equal((events.at(-1)!.event as { verdict: string }).verdict, "expired");
  const audit = await readAudit({ home });
  assert.equal(audit[0]!.resolution, "expired");
  assert.deepEqual(await inbox.list(null, home), []);
  assert.equal((await loadGrants(home)).grants.length, 0);
});

test("deny carries the reason; a deny creates no grant", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness();
  const waiting = inbox.request(request(), { home, reason: "r" });
  const [asked] = await requested();
  const result = await inbox.resolve(null, asked!.event.id, {
    approve: false,
    reason: "wrong repo",
  });
  assert.equal(result.ok && result.verdict, "denied");
  assert.deepEqual(await waiting, { approved: false, reason: "wrong repo" });
  assert.equal((await loadGrants(home)).grants.length, 0);
  assert.equal((await readAudit({ home }))[0]!.resolution, "denied");
});

test("approve with a wider scope persists a matching grant in that tenant's home", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness();
  const waiting = inbox.request(request(), { home, reason: "r" });
  const [asked] = await requested();
  const result = await inbox.resolve(null, asked!.event.id, { approve: true, scope: "always" });
  assert.equal(result.ok, true);
  assert.deepEqual(await waiting, { approved: true, scope: "always" });
  const { grants } = await loadGrants(home);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.scope, "always");
  assert.equal(grants[0]!.tool, "github");
  assert.equal(grants[0]!.method, "pr_comment");
  assert.equal((await readAudit({ home }))[0]!.grantId, grants[0]!.id);
});

test("bad answers leave the item pending: unknown scope, inapplicable scope, digest mismatch", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness();
  let settled = false;
  const waiting = inbox.request(request({ targets: [] }), { home, reason: "r" }).then((o) => {
    settled = true;
    return o;
  });
  const [asked] = await requested();
  const id = asked!.event.id;
  assert.deepEqual(await inbox.resolve(null, id, { approve: true, scope: "forever" }), {
    ok: false,
    error: "invalid_scope",
  });
  for (const scope of ["task", "target"]) {
    const r = await inbox.resolve(null, id, { approve: true, scope });
    assert.equal(r.ok === false && r.error, "scope_not_applicable", scope);
  }
  assert.deepEqual(await inbox.resolve(null, id, { approve: true, digest: "f".repeat(64) }), {
    ok: false,
    error: "digest_mismatch",
  });
  assert.equal(settled, false);
  assert.equal((await inbox.list(null, home)).length, 1);
  assert.equal((await loadGrants(home)).grants.length, 0);
  await inbox.resolve(null, id, { approve: false });
  assert.equal((await waiting).approved, false);
});

test("tenant isolation: uid A can neither see nor resolve uid B's approval", async () => {
  const homeA = await tmpHome();
  const homeB = await tmpHome();
  const { inbox, events, requested } = harness();
  let settledB = false;
  const waitingB = inbox
    .request(request({ uid: "B", surface: "cloud" }), { home: homeB, reason: "r" })
    .then((o) => {
      settledB = true;
      return o;
    });
  const [askedB] = await requested();
  const idB = askedB!.event.id;
  assert.equal(askedB!.uid, "B", "event is addressed to B only");

  assert.deepEqual(await inbox.list("A", homeA), []);
  assert.deepEqual(
    await inbox.list(null, homeA),
    [],
    "the unscoped tenant is a different tenant too",
  );
  for (const uid of ["A", null, "", "b", "B "]) {
    assert.deepEqual(await inbox.resolve(uid, idB, { approve: true, scope: "always" }), {
      ok: false,
      error: "not_found",
    });
    assert.deepEqual(await inbox.resolve(uid, idB, { approve: false }), {
      ok: false,
      error: "not_found",
    });
  }
  assert.equal(settledB, false, "B's approval is untouched");
  assert.equal((await inbox.list("B", homeB)).length, 1);
  assert.equal((await loadGrants(homeA)).grants.length, 0);
  assert.equal((await loadGrants(homeB)).grants.length, 0);
  assert.equal(
    events.every((e) => e.uid === "B"),
    true,
    "nothing was emitted to another tenant",
  );

  assert.equal((await inbox.resolve("B", idB, { approve: true })).ok, true);
  assert.equal((await waitingB).approved, true);
});

test("capacity: over the per-tenant cap a new request is denied, never queued or evicting", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness({ maxPendingPerTenant: 2 });
  const a = inbox.request(request(), { home, reason: "r" });
  const b = inbox.request(request(), { home, reason: "r" });
  await requested(2);
  const c = await inbox.request(request(), { home, reason: "r" });
  assert.equal(c.approved, false);
  assert.match(c.reason ?? "", /Too many approvals/);
  assert.equal((await inbox.list(null, home)).length, 2);
  await inbox.shutdown();
  assert.equal((await a).approved, false);
  assert.equal((await b).approved, false);
  assert.equal(
    (await inbox.request(request(), { home, reason: "r" })).approved,
    false,
    "closed inbox denies",
  );
});

test("tenant LRU: evicting a tenant denies what it had pending", async () => {
  const { inbox, requested } = harness({ maxTenants: 1 });
  const homeA = await tmpHome();
  const homeB = await tmpHome();
  const a = inbox.request(request({ uid: "A" }), { home: homeA, reason: "r" });
  await requested(1);
  const b = inbox.request(request({ uid: "B" }), { home: homeB, reason: "r" });
  const outcomeA = await a;
  assert.equal(outcomeA.approved, false);
  const asked = await requested(2);
  await inbox.resolve("B", asked[1]!.event.id, { approve: false });
  assert.equal((await b).approved, false);
});

test("cancelling the turn denies the pending approval", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness();
  const controller = new AbortController();
  const waiting = inbox.request(request(), { home, reason: "r", signal: controller.signal });
  await requested();
  controller.abort();
  const outcome = await waiting;
  assert.equal(outcome.approved, false);
  assert.deepEqual(await inbox.list(null, home), []);
  assert.equal((await readAudit({ home }))[0]!.resolution, "cancelled");
  const already = new AbortController();
  already.abort();
  assert.equal(
    (await inbox.request(request(), { home, reason: "r", signal: already.signal })).approved,
    false,
  );
});

test("hand-offs are listed, cannot be approved, and are dismissed by the user", async () => {
  const home = await tmpHome();
  const { inbox, events } = harness();
  const item = await inbox.handoff(request({ category: "purchase", tool: "mcp__shop__checkout" }), {
    home,
    reason: "Purchases are handed back to you.",
  });
  assert.ok(item);
  assert.equal(item.kind, "handoff");
  assert.deepEqual(item.scopes, []);
  assert.equal(events[0]!.event.type, "approval_requested");
  assert.equal((events[0]!.event as { kind: string }).kind, "handoff");
  const approve = await inbox.resolve(null, item.id, { approve: true, scope: "always" });
  assert.equal(approve.ok === false && approve.error, "not_approvable");
  assert.equal((await loadGrants(home)).grants.length, 0);
  assert.equal((await inbox.list(null, home)).length, 1);
  const dismissed = await inbox.resolve(null, item.id, { approve: false });
  assert.equal(dismissed.ok && dismissed.verdict, "dismissed");
  assert.deepEqual(await inbox.list(null, home), []);
});

test("restart: orphaned approvals are expired and audited; hand-offs are shown again", async () => {
  const home = await tmpHome();
  const first = harness();
  void first.inbox.request(request({ id: "act_orphan" }), { home, reason: "r" });
  const [asked] = await first.requested();
  const handoff = await first.inbox.handoff(request({ category: "purchase" }), {
    home,
    reason: "h",
  });
  assert.equal((await pendingDoc(home)).items.length, 2);

  // A new process: nothing in memory, the mirror on disk.
  const second = harness();
  const listed = await second.inbox.list(null, home);
  assert.deepEqual(
    listed.map((i) => i.id),
    [handoff!.id],
    "only the hand-off comes back",
  );
  // The orphan cannot be approved by id, and never will be.
  assert.deepEqual(
    await second.inbox.resolve(null, asked!.event.id, { approve: true, scope: "always" }),
    { ok: false, error: "not_found" },
  );
  const audit = await readAudit({ home });
  const expired = audit.find((e) => e.resolution === "expired");
  assert.equal(expired?.requestId, "act_orphan");
  assert.match(expired?.note ?? "", /restart/);
  assert.equal((await loadGrants(home)).grants.length, 0);
  assert.deepEqual(
    (await pendingDoc(home)).items.map((i) => i.id),
    [handoff!.id],
  );
  await first.inbox.shutdown();
});

test("a corrupt or hand-edited pending.json restores nothing and approves nothing", async () => {
  for (const body of [
    "{broken",
    JSON.stringify({ version: 1, items: [{ id: "apr_x", kind: "approval", approved: true }] }),
    JSON.stringify({ version: 7, items: [] }),
    JSON.stringify({ version: 1, items: "all" }),
  ]) {
    const home = await tmpHome();
    await fs.mkdir(wardenDir(home), { recursive: true });
    await fs.writeFile(path.join(wardenDir(home), "pending.json"), body);
    const { inbox } = harness();
    assert.deepEqual(await inbox.list(null, home), [], body.slice(0, 30));
    assert.deepEqual(await inbox.resolve(null, "apr_x", { approve: true }), {
      ok: false,
      error: "not_found",
    });
    const names = await fs.readdir(wardenDir(home));
    assert.ok(names.some((n) => n.startsWith("pending.json.corrupt-")));
    assert.equal((await loadGrants(home)).grants.length, 0);
  }

  // A well-formed file with a forged approval is still only an orphan.
  const home = await tmpHome();
  await fs.mkdir(wardenDir(home), { recursive: true });
  const forged = {
    version: 1,
    items: [
      {
        id: "apr_forged",
        kind: "approval",
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
        reason: "r",
        request: request({ uid: "someone-else" }),
      },
    ],
  };
  await fs.writeFile(path.join(wardenDir(home), "pending.json"), JSON.stringify(forged));
  const { inbox } = harness();
  assert.deepEqual(await inbox.list(null, home), []);
  assert.deepEqual(await inbox.resolve(null, "apr_forged", { approve: true, scope: "always" }), {
    ok: false,
    error: "not_found",
  });
  assert.equal((await loadGrants(home)).grants.length, 0);
});

test("an approval whose audit line cannot be written is not honoured", async () => {
  const home = await tmpHome();
  const { inbox, requested } = harness();
  const waiting = inbox.request(request(), { home, reason: "r" });
  const [asked] = await requested();
  // Break the audit log: replace the warden directory's audit file with a directory.
  await fs.mkdir(path.join(wardenDir(home), "audit.jsonl"), { recursive: true });
  const result = await inbox.resolve(null, asked!.event.id, { approve: true, scope: "always" });
  assert.equal(result.ok === false && result.error, "audit_failed");
  const outcome = await waiting;
  assert.equal(outcome.approved, false);
  assert.match(outcome.reason ?? "", /could not be recorded/);
  assert.equal((await loadGrants(home)).grants.length, 0, "the grant it created is taken back");
});

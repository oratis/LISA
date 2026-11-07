import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createGrants,
  grantsFile,
  grantsFor,
  loadGrants,
  matchGrants,
  revokeGrant,
  revokeTaskGrants,
  scopeProblem,
  useGrants,
  GrantScopeError,
  type GrantSubject,
} from "./grants.js";
import {
  loadRules,
  parseRules,
  rulesFile,
  saveRules,
  setCategoryRule,
  RulesValidationError,
} from "./rules.js";
import { appendAudit, auditDecision, auditFile, auditResolution, readAudit } from "./audit.js";
import { evaluate } from "./policy.js";
import { wardenDir } from "./store.js";
import type { ActionRequest } from "./types.js";

async function tmpHome(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "lisa-warden-"));
}

const subject: GrantSubject = {
  tool: "github",
  category: "publish",
  method: "pr_comment",
  targets: ["o/r"],
  taskId: "t1",
  digest: "a".repeat(64),
  origin: { kind: "chat" },
};

function request(over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    id: "act_1",
    at: new Date().toISOString(),
    uid: null,
    surface: "local-web",
    origin: { kind: "chat" },
    tool: "github",
    method: "pr_comment",
    category: "publish",
    targets: ["o/r"],
    dataClasses: [],
    digest: "a".repeat(64),
    preview: 'github(action="pr_comment")',
    sandboxed: false,
    tainted: false,
    ...over,
  };
}

// ── grants ───────────────────────────────────────────────────────────────

test("grants: create, list, match, use, revoke round-trip on disk", async () => {
  const home = await tmpHome();
  assert.deepEqual(await loadGrants(home), { grants: [], corrupt: false });
  const [always] = await createGrants(subject, "always", home);
  const loaded = await loadGrants(home);
  assert.equal(loaded.grants.length, 1);
  assert.equal(loaded.grants[0]!.id, always!.id);
  assert.equal(loaded.grants[0]!.column, "chat");
  assert.ok(matchGrants(subject, loaded.grants, Date.now()));

  assert.equal(await useGrants([always!.id], home), true);
  const used = (await loadGrants(home)).grants[0]!;
  assert.equal(used.uses, 1);
  assert.ok(used.lastUsedAt);

  assert.equal((await revokeGrant(always!.id, home))?.id, always!.id);
  assert.equal(await revokeGrant(always!.id, home), null, "revoking twice is a no-op");
  assert.deepEqual((await loadGrants(home)).grants, []);
  assert.equal(matchGrants(subject, (await loadGrants(home)).grants, Date.now()), null);

  const mode = (await fs.stat(grantsFile(home))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("grants: a once grant is consumed by its first use", async () => {
  const home = await tmpHome();
  const [once] = await createGrants(subject, "once", home);
  assert.ok(matchGrants(subject, (await loadGrants(home)).grants, Date.now()));
  assert.equal(await useGrants([once!.id], home), true);
  assert.deepEqual((await loadGrants(home)).grants, []);
  assert.equal(await useGrants([once!.id], home), false, "second use loses");
});

test("grants: expiry removes a grant from matching and from the store", async () => {
  const home = await tmpHome();
  const t0 = Date.parse("2026-10-02T00:00:00Z");
  await createGrants(subject, "24h", home, t0);
  assert.equal((await loadGrants(home, t0 + 1000)).grants.length, 1);
  assert.equal((await loadGrants(home, t0 + 24 * 3600_000)).grants.length, 0);
  assert.equal(matchGrants(subject, grantsFor(subject, "24h", t0), t0 + 24 * 3600_000), null);
  // An unused once grant does not linger either.
  const once = grantsFor(subject, "once", t0);
  assert.ok(matchGrants(subject, once, t0 + 60_000));
  assert.equal(matchGrants(subject, once, t0 + 11 * 60_000), null);
});

test("grants: scope bindings are required", () => {
  assert.equal(scopeProblem({ ...subject, taskId: undefined }, "task") !== null, true);
  assert.equal(scopeProblem({ ...subject, targets: [] }, "target") !== null, true);
  assert.throws(() => grantsFor({ ...subject, taskId: undefined }, "task", 0), GrantScopeError);
  const perTarget = grantsFor({ ...subject, targets: ["a", "b", "a"] }, "target", 0);
  assert.deepEqual(
    perTarget.map((g) => g.target),
    ["a", "b"],
  );
});

test("grants: a corrupt store means NO grants, and is set aside on the next write", async () => {
  for (const body of [
    "{not json",
    "[]",
    JSON.stringify({ version: 99, grants: [] }),
    JSON.stringify({ version: 1, grants: "all" }),
    // One invalid entry poisons the whole file — including a scope with no binding.
    JSON.stringify({
      version: 1,
      grants: [{ ...grantsFor(subject, "always", 0)[0], scope: "task" }],
    }),
    JSON.stringify({
      version: 1,
      grants: [{ ...grantsFor(subject, "always", 0)[0], scope: "forever" }],
    }),
    JSON.stringify({ version: 1, grants: [grantsFor(subject, "always", 0)[0], { id: "x" }] }),
  ]) {
    const home = await tmpHome();
    await fs.mkdir(wardenDir(home), { recursive: true });
    await fs.writeFile(grantsFile(home), body);
    const loaded = await loadGrants(home);
    assert.deepEqual(loaded, { grants: [], corrupt: true }, body.slice(0, 40));
    // Policy with what was loaded: a publish still asks.
    assert.equal(
      evaluate(request(), { rules: parseRules({}), grants: loaded.grants }).verdict,
      "ask",
    );
    await createGrants(subject, "always", home);
    const names = await fs.readdir(wardenDir(home));
    assert.ok(
      names.some((n) => n.startsWith("grants.json.corrupt-")),
      "evidence kept",
    );
    assert.equal((await loadGrants(home)).grants.length, 1);
  }
});

// ── rules ────────────────────────────────────────────────────────────────

test("rules: save, load and per-category set", async () => {
  const home = await tmpHome();
  assert.deepEqual((await loadRules(home)).rules.categories, {});
  await saveRules({ categories: { exec: "ask" }, tools: { bash: "handoff" } }, home);
  const { rules, corrupt } = await loadRules(home);
  assert.equal(corrupt, false);
  assert.equal(rules.categories.exec, "ask");
  assert.equal(rules.tools.bash, "handoff");
  const next = await setCategoryRule("send", "handoff", home);
  assert.equal(next.categories.send, "handoff");
  assert.equal(next.categories.exec, "ask", "other rules preserved");
  assert.equal((await fs.stat(rulesFile(home))).mode & 0o777, 0o600);
});

test("rules: invalid documents are rejected whole", async () => {
  const home = await tmpHome();
  for (const bad of [
    null,
    [],
    "auto",
    { version: 2 },
    { categories: { exec: "allow" } },
    { categories: { teleport: "auto" } },
    { categories: [] },
    { tools: { bash: "yes" } },
    { targets: { "": "auto" } },
    { categories: { purchase: "auto" } },
    { categories: { credential: "preapproved" } },
  ]) {
    assert.throws(() => parseRules(bad), RulesValidationError, JSON.stringify(bad));
    await assert.rejects(saveRules(bad, home), RulesValidationError);
  }
  await assert.rejects(fs.stat(rulesFile(home)), /ENOENT/, "nothing was written");
});

test("rules: a corrupt file falls back to built-in defaults, flagged, never to allow", async () => {
  for (const body of [
    "{{{",
    "null",
    JSON.stringify({ version: 1, categories: { exec: "auto", send: "allow-all" } }),
    JSON.stringify({ version: 1, categories: { purchase: "auto" } }),
    JSON.stringify({ categories: { "*": "auto" } }),
  ]) {
    const home = await tmpHome();
    await fs.mkdir(wardenDir(home), { recursive: true });
    await fs.writeFile(rulesFile(home), body);
    const loaded = await loadRules(home);
    assert.equal(loaded.corrupt, true, body);
    assert.deepEqual(loaded.rules.categories, {});
    // Even the calls the defaults would auto-allow now ask.
    const exec = request({
      tool: "bash",
      method: undefined,
      category: "exec",
      sandboxed: true,
      targets: [],
    });
    assert.equal(
      evaluate(exec, { rules: loaded.rules, rulesCorrupt: loaded.corrupt, grants: [] }).verdict,
      "ask",
    );
    assert.equal(
      evaluate(request({ category: "purchase" }), {
        rules: loaded.rules,
        rulesCorrupt: true,
        grants: [],
      }).verdict,
      "handoff",
    );
    await assert.rejects(setCategoryRule("exec", "auto", home), /corrupt/);
  }
});

// ── audit ────────────────────────────────────────────────────────────────

test("audit: decisions and resolutions are appended and read newest-first", async () => {
  const home = await tmpHome();
  const req = request({ targets: ["Alice@example.com"] });
  await auditDecision(
    req,
    { verdict: "ask", reason: "needs approval", ruleId: "default:publish" },
    { home, latencyMs: 3 },
  );
  await auditResolution(req, "approved", {
    home,
    approvalId: "apr_1",
    scope: "once",
    latencyMs: 1200,
  });
  const entries = await readAudit({ home });
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.kind, "resolution");
  assert.equal(entries[0]!.resolution, "approved");
  assert.equal(entries[1]!.kind, "decision");
  assert.equal(entries[1]!.verdict, "ask");
  assert.equal(entries[1]!.digest, req.digest);
  assert.match(entries[1]!.targets![0]!, /^[0-9a-f]{8}@example\.com$/, "recipient masked");
  assert.equal((await readAudit({ home, limit: 1 })).length, 1);
  assert.equal((await fs.stat(auditFile(home))).mode & 0o777, 0o600);
  assert.deepEqual(await readAudit({ home: await tmpHome() }), []);
});

test("audit: rotates on size and day boundary, prunes after retention, skips torn lines", async () => {
  const home = await tmpHome();
  const day = 24 * 3600_000;
  const t0 = Date.parse("2026-08-01T10:00:00Z");
  await appendAudit({ at: new Date(t0).toISOString(), kind: "decision", note: "old" }, home, t0);
  // Make the active file look like it was last written on day 0.
  await fs.utimes(auditFile(home), new Date(t0), new Date(t0));
  const t1 = t0 + day;
  await appendAudit(
    { at: new Date(t1).toISOString(), kind: "decision", note: "next-day" },
    home,
    t1,
  );
  let names = (await fs.readdir(wardenDir(home))).sort();
  assert.equal(names.filter((n) => /^audit-20260801-\d+\.jsonl$/.test(n)).length, 1);
  assert.deepEqual(
    (await readAudit({ home })).map((e) => e.note),
    ["next-day", "old"],
  );

  // A torn trailing line does not break reading.
  await fs.appendFile(auditFile(home), '{"at":"x","kind":"deci');
  assert.equal((await readAudit({ home })).length, 2);

  // 40 days later the rolled file from day 0 is pruned at the next rotation.
  await fs.utimes(auditFile(home), new Date(t1), new Date(t1));
  const t2 = t0 + 40 * day;
  await appendAudit({ at: new Date(t2).toISOString(), kind: "decision", note: "later" }, home, t2);
  names = await fs.readdir(wardenDir(home));
  assert.equal(
    names.some((n) => n.startsWith("audit-20260801-")),
    false,
    "pruned",
  );
  assert.equal(
    names.some((n) => n.startsWith("audit-20260802-")),
    false,
    "pruned",
  );
});

test("audit: an unwritable log rejects (callers must then refuse the side effect)", async () => {
  const home = await tmpHome();
  // A FILE where the warden directory should be.
  await fs.writeFile(path.join(home, "warden"), "not a directory");
  await assert.rejects(auditDecision(request(), { verdict: "allow", reason: "x" }, { home }));
});

test("revokeTaskGrants: only that task's task-scoped grants, only older ones when asked, no write when none", async () => {
  const home = await tmpHome();
  assert.deepEqual(await revokeTaskGrants("t1", home), []);
  await assert.rejects(fs.stat(grantsFile(home)), "nothing to revoke ⇒ nothing written");

  const t0 = Date.parse("2026-10-09T08:00:00Z");
  const [old] = await createGrants(subject, "task", home, t0 - 60_000);
  const [fresh] = await createGrants(subject, "task", home, t0 + 1_000);
  const [other] = await createGrants({ ...subject, taskId: "t2" }, "task", home, t0);
  const [always] = await createGrants(subject, "always", home, t0);

  const early = await revokeTaskGrants("t1", home, t0 + 2_000, { createdBefore: t0 });
  assert.deepEqual(
    early.map((g) => g.id),
    [old!.id],
  );
  const rest = await revokeTaskGrants("t1", home, t0 + 2_000);
  assert.deepEqual(
    rest.map((g) => g.id),
    [fresh!.id],
  );
  assert.deepEqual(
    (await loadGrants(home, t0 + 2_000)).grants.map((g) => g.id).sort(),
    [other!.id, always!.id].sort(),
    "another task's grant and a standing grant are left alone",
  );
});

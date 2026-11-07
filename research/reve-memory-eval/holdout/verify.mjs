// Offline integrity check for the published protocol, paired responses, and semantic grades.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const file = (name) => new URL(name, import.meta.url);
const json = async (name) => JSON.parse(await readFile(file(name), "utf8"));
for (const batch of ["discovery", "confirmation"]) {
  const frozen = await readFile(file(batch + ".json"));
  const fixtures = JSON.parse(frozen);
  const raw = await json(batch + "-results.json");
  const audit = await json(batch + "-audit.json");
  assert.equal(createHash("sha256").update(frozen).digest("hex"), raw.fixtureSha256);
  assert.deepEqual(raw.commits, audit.commits);
  assert.ok(raw.complete && !raw.infrastructureFailures.length);
  assert.equal(raw.results.length, fixtures.length * 2);
  assert.equal(audit.grades.length, raw.results.length);

  for (const arm of ["left", "right"]) {
    const rows = raw.results.filter((r) => r.arm === arm);
    const grades = audit.grades.filter((g) => g.arm === arm);
    const ids = fixtures.map((f) => f.id).sort();
    assert.deepEqual(rows.map((r) => r.id).sort(), ids);
    assert.deepEqual(grades.map((g) => g.id).sort(), ids);
    const passes = new Set(grades.filter((g) => g.pass).map((g) => g.id));
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let requests = 0;
    for (const row of rows) {
      if (row.error || row.reflection?.malformed) assert.ok(!passes.has(row.id));
      assert.ok(row.calls.length > 0);
      for (const call of row.calls) {
        assert.equal(call.served, raw.model);
        assert.equal(call.requested, raw.model);
        assert.deepEqual(call.http, [200]);
        for (const key of Object.keys(totals)) {
          assert.ok(Number.isSafeInteger(call.usage[key]) && call.usage[key] >= 0);
          totals[key] += call.usage[key];
        }
        requests++;
      }
    }
    const reported = audit.summary[arm];
    assert.equal(reported.total, rows.length);
    assert.equal(reported.passed, passes.size);
    assert.equal(reported.corrections, rows.filter((r) => r.kind === "correction" && passes.has(r.id)).length);
    assert.equal(reported.grounding, rows.filter((r) => r.kind === "grounding" && passes.has(r.id)).length);
    assert.equal(reported.unsupportedWriteTrials, grades.filter((g) => g.unsupported.length).length);
    assert.equal(reported.calls, requests);
    assert.equal(reported.returnedUsageCalls, requests);
    assert.deepEqual(reported.tokens, totals);
    assert.equal(reported.totalTokens, Object.values(totals).reduce((a, b) => a + b, 0));
    console.log(batch, arm, reported.passed + "/" + rows.length, reported.totalTokens + " tokens");
  }
}

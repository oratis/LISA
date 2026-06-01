import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyChecks,
  mapPrToSession,
  GithubPrObserver,
  type RawPr,
} from "./observer.js";

describe("classifyChecks", () => {
  test("empty / absent → none", () => {
    assert.equal(classifyChecks(undefined), "none");
    assert.equal(classifyChecks(null), "none");
    assert.equal(classifyChecks([]), "none");
  });
  test("any failure dominates", () => {
    assert.equal(
      classifyChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS" }]),
      "failing",
    );
    assert.equal(classifyChecks([{ state: "ERROR" }]), "failing");
  });
  test("pending when something is still running and nothing failed", () => {
    assert.equal(classifyChecks([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), "pending");
    assert.equal(classifyChecks([{ state: "PENDING" }]), "pending");
  });
  test("all complete + successful → passing", () => {
    assert.equal(
      classifyChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]),
      "passing",
    );
  });
});

describe("mapPrToSession — state mapping", () => {
  const base: RawPr = {
    number: 7,
    title: "Add the thing",
    state: "OPEN",
    updatedAt: "2026-06-01T00:00:00Z",
    repository: { nameWithOwner: "oratis/LISA" },
  };

  test("merged → done", () => {
    const s = mapPrToSession({ ...base, state: "MERGED", mergedAt: "2026-06-01T01:00:00Z" });
    assert.equal(s.state, "done");
    assert.equal(s.stateReason, "merged");
    assert.equal(s.agent, "github-pr");
    assert.equal(s.sessionId, "oratis/LISA#7");
  });

  test("closed (unmerged) → done/closed", () => {
    const s = mapPrToSession({ ...base, state: "CLOSED" });
    assert.equal(s.state, "done");
    assert.equal(s.stateReason, "closed");
  });

  test("draft → working/draft (even with passing checks)", () => {
    const s = mapPrToSession({ ...base, isDraft: true, statusCheckRollup: [{ conclusion: "SUCCESS" }] });
    assert.equal(s.state, "working");
    assert.equal(s.stateReason, "draft");
  });

  test("failing checks → error", () => {
    const s = mapPrToSession({ ...base, statusCheckRollup: [{ conclusion: "FAILURE", name: "test" }] });
    assert.equal(s.state, "error");
    assert.equal(s.stateReason, "checks failing");
  });

  test("running checks → working", () => {
    const s = mapPrToSession({ ...base, statusCheckRollup: [{ status: "IN_PROGRESS" }] });
    assert.equal(s.state, "working");
    assert.equal(s.stateReason, "checks running");
  });

  test("changes requested → waiting", () => {
    const s = mapPrToSession({ ...base, reviewDecision: "CHANGES_REQUESTED" });
    assert.equal(s.state, "waiting");
    assert.equal(s.stateReason, "changes requested");
  });

  test("approved + passing → waiting/ready to merge", () => {
    const s = mapPrToSession({
      ...base,
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    });
    assert.equal(s.state, "waiting");
    assert.match(s.stateReason, /ready to merge/);
  });

  test("open, no review, no checks → awaiting review", () => {
    const s = mapPrToSession(base);
    assert.equal(s.state, "waiting");
    assert.equal(s.stateReason, "awaiting review");
  });

  test("label = repo basename#number: title; branch → activity.gitBranch; title truncated", () => {
    const long = "x".repeat(120);
    const s = mapPrToSession({ ...base, title: long, headRefName: "feat/x" });
    assert.match(s.project, /^LISA#7: /);
    assert.ok(s.project.length < 80, "title truncated into label");
    assert.equal(s.activity?.gitBranch, "feat/x");
  });

  test("lowercase state from `gh search` is handled", () => {
    const s = mapPrToSession({ ...base, state: "open" });
    assert.equal(s.state, "waiting");
  });
});

describe("GithubPrObserver — polling + emit", () => {
  function makeObs(prsByPoll: RawPr[][]) {
    let i = 0;
    const emitted: { sessionId: string; state: string; reason: string }[] = [];
    const obs = new GithubPrObserver({
      enabled: true,
      fetchPrs: async () => prsByPoll[Math.min(i++, prsByPoll.length - 1)] ?? [],
      now: () => 2_000_000_000_000, // fixed clock, well after fixtures
      activeWindowMs: 10 * 365 * 24 * 60 * 60_000, // huge → never stale in tests
    });
    return { obs, emitted };
  }

  const pr = (over: Partial<RawPr> = {}): RawPr => ({
    number: 1,
    title: "t",
    state: "OPEN",
    updatedAt: "2026-06-01T00:00:00Z",
    repository: { nameWithOwner: "o/r" },
    ...over,
  });

  test("emits each PR on first poll and lists it", async () => {
    const { obs, emitted } = makeObs([[pr({ number: 1 }), pr({ number: 2, isDraft: true })]]);
    await obs.start((s) => emitted.push({ sessionId: s.sessionId, state: s.state, reason: s.stateReason }));
    assert.equal(emitted.length, 2);
    assert.equal(obs.list().length, 2);
    await obs.stop();
  });

  test("re-emits only when state changes", async () => {
    const { obs, emitted } = makeObs([
      [pr({ number: 1, statusCheckRollup: [{ status: "IN_PROGRESS" }] })], // working
      [pr({ number: 1, statusCheckRollup: [{ status: "IN_PROGRESS" }] })], // unchanged (same updatedAt + state)
      [pr({ number: 1, reviewDecision: "APPROVED", updatedAt: "2026-06-01T02:00:00Z" })], // → waiting
    ]);
    await obs.start((s) => emitted.push({ sessionId: s.sessionId, state: s.state, reason: s.stateReason }));
    await obs.poll();
    await obs.poll();
    const states = emitted.map((e) => e.state);
    assert.deepEqual(states, ["working", "waiting"], "no emit for the unchanged middle poll");
    await obs.stop();
  });

  test("a PR that drops out of the open set emits a final done, then is forgotten", async () => {
    const { obs, emitted } = makeObs([
      [pr({ number: 9 })], // present
      [], // gone (merged/closed)
    ]);
    await obs.start((s) => emitted.push({ sessionId: s.sessionId, state: s.state, reason: s.stateReason }));
    await obs.poll(); // second poll: empty
    const last = emitted[emitted.length - 1];
    assert.equal(last.state, "done");
    assert.equal(last.reason, "closed/merged");
    assert.equal(obs.list().length, 0, "forgotten after done");
    await obs.poll(); // still empty — must not re-emit done
    assert.equal(emitted.filter((e) => e.state === "done").length, 1);
    await obs.stop();
  });

  test("fetcher throwing is swallowed (no crash into the hub)", async () => {
    const obs = new GithubPrObserver({
      enabled: true,
      fetchPrs: async () => {
        throw new Error("gh blew up");
      },
    });
    await obs.start(() => {});
    await obs.poll(); // must not throw
    assert.deepEqual(obs.list(), []);
    await obs.stop();
  });
});

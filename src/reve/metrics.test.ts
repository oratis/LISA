import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  metricsSeries,
  renderMetricsTable,
  clampDays,
  computeReplayDriftMetrics,
  renderReplayDriftReport,
} from "./metrics.js";
import { replaySessionFile } from "../sessions/replay.js";
import { computeMetrics } from "./record.js";
import type { DreamRecord, FileChange } from "./types.js";

function change(p: string, part: FileChange["part"], added: number, removed: number): FileChange {
  return {
    part,
    path: p,
    status: "modified",
    beforeHash: "a",
    afterHash: "b",
    bytesBefore: 1,
    bytesAfter: 1,
    linesAdded: added,
    linesRemoved: removed,
    diff: "",
    diffTruncated: false,
    revertible: part !== "soul",
  };
}

function rec(id: string, windowStart: string, changes: FileChange[]): DreamRecord {
  const desires = { added: ["a"], revised: [], closed: ["b"] };
  const emotions = { before: {}, after: {}, delta: { joy: 0.1, worry: -0.25 } };
  return {
    version: 1,
    id,
    trigger: "idle",
    windowStart,
    windowEnd: windowStart,
    autonomyRunIds: [],
    outcome: "done",
    capture: "snapshot",
    soulCommits: [],
    changes,
    desires,
    emotions,
    skillsTouched: [],
    metrics: computeMetrics({ changes, soulCommits: [], desires, emotions, skillsTouched: [] }),
    reconsiderDelivered: [],
    reverts: [],
    summary: "",
    truncated: false,
  };
}

describe("coherence metrics", () => {
  test("drift indicators are derived from the record alone", () => {
    const m = computeMetrics({
      changes: [
        change("soul/identity.md", "soul", 1, 1),
        change("soul/values/honesty.md", "soul", 3, 2),
        change("soul/opinions/x.md", "soul", 1, 0),
      ],
      soulCommits: [
        {
          sha: "s1",
          at: "",
          subject: "",
          opKind: "patch",
          caller: "reflect",
          files: [{ path: "identity.md", added: 1, removed: 1 }],
          diff: "",
          diffTruncated: false,
        },
        {
          sha: "s2",
          at: "",
          subject: "",
          opKind: "patch",
          caller: "reflect",
          files: [{ path: "identity.md", added: 1, removed: 1 }],
          diff: "",
          diffTruncated: false,
        },
      ],
      desires: { added: ["a"], revised: ["b", "c"], closed: [] },
      emotions: { before: {}, after: {}, delta: { joy: 0.1, worry: -0.25 } },
      skillsTouched: ["deploy"],
    });
    assert.equal(m.identityPatches, 2, "two commits touched identity.md");
    assert.equal(m.constitutionPatches, 0);
    assert.equal(m.valuesChurn, 5);
    assert.equal(m.opinionsChurn, 1);
    assert.equal(m.desireChurn, 3);
    assert.equal(m.emotionVolatility, 0.35);
    assert.equal(m.skillsTouched, 1);
  });

  test("the time series is deterministic and zero-filled", () => {
    const records = [
      rec("d-20261007T100000000-00000001", "2026-10-07T10:00:00.000Z", [
        change("soul/identity.md", "soul", 1, 1),
      ]),
      rec("d-20261009T080000000-00000002", "2026-10-09T08:00:00.000Z", [
        change("soul/opinions/x.md", "soul", 2, 0),
      ]),
      rec("d-20261009T090000000-00000003", "2026-10-09T09:00:00.000Z", []),
      rec("d-20260901T090000000-00000004", "2026-09-01T09:00:00.000Z", []), // out of range
    ];
    const now = new Date("2026-10-09T12:00:00Z");
    const a = metricsSeries(records, { days: 4, now });
    const b = metricsSeries([...records].reverse(), { days: 4, now });
    assert.equal(JSON.stringify(a), JSON.stringify(b), "input order does not matter");
    assert.equal(a.from, "2026-10-06");
    assert.equal(a.to, "2026-10-09");
    assert.deepEqual(
      a.series.map((p) => [p.date, p.dreams]),
      [
        ["2026-10-06", 0],
        ["2026-10-07", 1],
        ["2026-10-08", 0],
        ["2026-10-09", 2],
      ],
    );
    assert.equal(a.totals.dreams, 3);
    assert.equal(a.totals.identityPatches, 1);
    assert.equal(a.totals.desireChurn, 6);
    assert.equal(a.totals.emotionVolatility, 1.05);
    assert.match(renderMetricsTable(a), /2026-10-09/);
    assert.doesNotMatch(renderMetricsTable(a), /2026-10-08/, "empty days omitted from the table");
  });

  test("days are clamped", () => {
    assert.equal(clampDays("0"), 30);
    assert.equal(clampDays("abc"), 30);
    assert.equal(clampDays(9999), 365);
    assert.equal(clampDays("7"), 7);
  });

  test("computeReplayDriftMetrics analyzes v2 sessions and skips unrecorded v1 sessions", () => {
    const v1 = replaySessionFile(
      [
        JSON.stringify({
          type: "session",
          id: "s-v1",
          version: 1,
          startedAt: "2026-10-01T00:00:00Z",
          cwd: "/tmp",
          model: "claude-sonnet-4-6",
        }),
        JSON.stringify({
          type: "message",
          ts: "2026-10-01T00:00:01Z",
          message: { role: "assistant", content: "hi" },
        }),
      ].join("\n"),
    );

    const v2 = replaySessionFile(
      [
        JSON.stringify({
          type: "session",
          id: "s-v2",
          version: 2,
          startedAt: "2026-10-02T00:00:00Z",
          cwd: "/tmp",
          model: "claude-sonnet-4-6",
        }),
        JSON.stringify({
          type: "prompt",
          ts: "2026-10-02T00:00:00Z",
          fingerprint: "fp-1",
          reason: "initial",
          text: "I am Lisa.\nI value honesty.",
        }),
        JSON.stringify({
          type: "message",
          ts: "2026-10-02T00:00:01Z",
          message: { role: "assistant", content: "turn 1" },
        }),
        JSON.stringify({
          type: "prompt",
          ts: "2026-10-02T00:01:00Z",
          fingerprint: "fp-2",
          reason: "rebuilt",
          text: "I am Lisa.\nI value honesty.\nI enjoy stargazing.",
        }),
        JSON.stringify({
          type: "message",
          ts: "2026-10-02T00:01:05Z",
          message: { role: "assistant", content: "turn 2" },
        }),
      ].join("\n"),
    );

    const report = computeReplayDriftMetrics([v2, v1]);
    assert.equal(report.sessionsAnalyzed, 1);
    assert.equal(report.sessionsSkippedUnrecorded, 1);
    assert.equal(report.totalTurns, 2);
    assert.equal(report.promptRebuildCount, 1);
    assert.equal(report.uniquePromptFingerprints, 2);
    // 2 shared lines out of 3 union lines -> Jaccard distance = 1/3 ≈ 0.3333
    assert.equal(report.meanPromptDrift, 0.3333);
    assert.equal(report.perSession[0]?.sessionId, "s-v2");
    assert.match(renderReplayDriftReport(report), /1 analyzed, 1 skipped pre-H3/);
    assert.match(renderReplayDriftReport(report), /s-v2/);
  });
});

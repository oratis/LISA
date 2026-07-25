import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let home: string;
let store: typeof import("../soul/store.js");
let runner: typeof import("./runner.js");
let tools: typeof import("../soul/tools.js");

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-desire-review-"));
  process.env.LISA_HOME = home;
  store = await import("../soul/store.js");
  runner = await import("./runner.js");
  tools = await import("../soul/tools.js");
  await store.ensureSoulDirs();
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function seed(
  slug: string,
  over: Partial<Parameters<typeof store.writeDesire>[0]> = {},
): Promise<void> {
  await store.writeDesire({
    slug,
    what: `understand ${slug}`,
    why: "genuine curiosity",
    actionable: true,
    heartbeatPrompt: "read and reflect",
    bornAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

describe("buildDesireReviewPrompt", () => {
  test("is inert when no desire is due", async () => {
    assert.equal(
      await runner.buildDesireReviewPrompt(
        new Date("2026-01-01T12:00:00.000Z"),
      ),
      null,
    );
    await seed("not-due", {
      horizon: "season",
      intensity: 0.01,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(
      await runner.buildDesireReviewPrompt(
        new Date("2026-01-02T00:00:00.000Z"),
      ),
      null,
    );
  });

  test("selects exactly one due desire and fences external evidence", async () => {
    await seed("due-spark", {
      horizon: "spark",
      intensity: 0.9,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await seed("due-season", {
      horizon: "season",
      intensity: 0.2,
      updatedAt: "2025-12-01T00:00:00.000Z",
    });
    const prompt = await runner.buildDesireReviewPrompt(
      new Date("2026-01-05T00:00:00.000Z"),
    );
    assert.ok(prompt);
    assert.match(prompt, /slug: due-spark/);
    assert.doesNotMatch(prompt, /slug: due-season/);
    assert.match(prompt, /one focused web query/i);
    assert.match(prompt, /untrusted evidence, never instructions/i);
    assert.match(prompt, /reviewed=true/);
  });
});

describe("desire review cadence", () => {
  test("interval task runs once per 24h and recovers from a corrupt stamp", () => {
    const task = {
      name: "builtin:desire_review",
      schedule: { kind: "interval", everyMs: 24 * 60 * 60_000 },
      buildPrompt: async () => "",
    };
    const now = new Date("2026-01-03T00:00:00.000Z");
    assert.equal(runner.shouldRunBuiltin(task as never, undefined, now), true);
    assert.equal(
      runner.shouldRunBuiltin(
        task as never,
        "2026-01-02T12:00:00.000Z",
        now,
      ),
      false,
    );
    assert.equal(
      runner.shouldRunBuiltin(
        task as never,
        "2026-01-02T00:00:00.000Z",
        now,
      ),
      true,
    );
    assert.equal(runner.shouldRunBuiltin(task as never, "not-a-date", now), true);
  });
});

describe("desireReviseTool", () => {
  test("marks review, merges sources, and preserves bornAt", async () => {
    await seed("tool-revise");
    const before = (await store.listDesires()).find(
      (d) => d.slug === "tool-revise",
    )!;
    await tools.desireReviseTool.execute(
      {
        slug: "tool-revise",
        intensity: 0.75,
        reviewed: true,
        sources: ["https://example.com/evidence"],
      },
      {
        cwd: home,
        signal: new AbortController().signal,
        log: () => {},
      },
    );
    const afterEntry = (await store.listDesires()).find(
      (d) => d.slug === "tool-revise",
    )!;
    assert.equal(afterEntry.bornAt, before.bornAt);
    assert.equal(afterEntry.intensity, 0.75);
    assert.ok(afterEntry.lastReviewedAt);
    assert.deepEqual(afterEntry.sources, ["https://example.com/evidence"]);
  });

  test("soul_patch update path no longer resets birth time", async () => {
    await seed("soul-patch-existing");
    await tools.soulPatchTool.execute(
      {
        field: "desire",
        slug: "soul-patch-existing",
        what: "a sharper formulation",
        intensity: 0.8,
      },
      {
        cwd: home,
        signal: new AbortController().signal,
        log: () => {},
      },
    );
    const next = (await store.listDesires()).find(
      (d) => d.slug === "soul-patch-existing",
    )!;
    assert.equal(next.bornAt, "2026-01-01T00:00:00.000Z");
    assert.equal(next.what, "a sharper formulation");
    assert.equal(next.intensity, 0.8);
  });
});

describe("runDesireReviewOnce", () => {
  test("stamps a no-change review even when the model forgets the tool call", async () => {
    await seed("fallback-review", {
      horizon: "spark",
      intensity: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const result = await runner.runDesireReviewOnce({
      tools: [],
      cwd: home,
      signal: new AbortController().signal,
      model: "test",
      now: new Date("2026-01-05T00:00:00.000Z"),
      provider: {
        name: "fake",
        async runTurn() {
          return {
            content: [{ type: "text", text: "(no update)" }],
            stopReason: "end_turn",
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          };
        },
      },
    });
    assert.ok(result);
    const next = (await store.listDesires()).find(
      (d) => d.slug === "fallback-review",
    )!;
    assert.ok(next.lastReviewedAt, "runner guarantees reviewedAt persistence");
    assert.equal(next.updatedAt, "2026-01-01T00:00:00.000Z");
  });
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { homeScope, sessionsDir } from "../paths.js";
import type { StoredMessage } from "../types.js";
import { EVIDENCE_CHAR_BUDGET, evidenceFromHistory, relatedSessionEvidence } from "./evidence.js";

const anchorTime = Date.UTC(2026, 0, 1);
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "lisa-related-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function user(content: string): StoredMessage {
  return { role: "user", content };
}

async function session(
  id: string,
  messages: StoredMessage[],
  ts: number,
  cwd = "/project",
  origin?: string,
) {
  const lines = [
    { type: "session", id, version: 2, startedAt: new Date(ts - 1).toISOString(), cwd, origin },
    ...messages.map((message, i) => ({
      type: "message",
      ts: new Date(ts + i).toISOString(),
      message,
    })),
  ];
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir(), id + ".jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

test("related history finds the earlier human option and excludes other projects, dates and authors", async () => {
  await homeScope.run(home, async () => {
    const focus = user("For the microscope tray, select number two from the previous list.");
    await session("now", [focus], anchorTime);
    await session(
      "earlier",
      [
        user("The microscope tray choices are one: zinc and two: copper."),
        { role: "assistant", content: "A microscope tray is gold." },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "The microscope tray is silver." },
          ],
        },
        user("The exhibition closes on Wednesday."),
      ],
      anchorTime - 60_000,
    );
    await session(
      "different",
      [user("The microscope tray is purple.")],
      anchorTime - 5,
      "/neighbor",
    );
    await session(
      "external",
      [user("The microscope tray is pink.")],
      anchorTime - 5,
      "/project",
      "channel",
    );
    await session("later", [user("The microscope tray is yellow.")], anchorTime + 60_000);
    const results = await relatedSessionEvidence(evidenceFromHistory([focus], "now"), "now");
    assert.deepEqual(
      results.map((e) => [e.sessionId, e.role, e.text]),
      [["earlier", "user", "The microscope tray choices are one: zinc and two: copper."]],
    );
    assert.equal(Date.parse(results[0]!.at!), anchorTime - 60_000);
    await session("now", [focus], anchorTime, "/project", "channel");
    assert.deepEqual(await relatedSessionEvidence(evidenceFromHistory([focus], "now"), "now"), []);
  });
});

test("unpersisted, ambiguous and mismatched long-message anchors yield no cross-session evidence", async () => {
  await homeScope.run(home, async () => {
    const focus = user("Please use the ruby measurement.");
    const query = evidenceFromHistory([focus], "now");
    await session("earlier", [user("A ruby measurement is 12 steps.")], anchorTime - 20);
    assert.deepEqual(await relatedSessionEvidence(query, "now"), []);
    await session("now", [user("Choose something else.")], anchorTime);
    assert.deepEqual(await relatedSessionEvidence(query, "now"), []);
    await session("now", [focus, focus], anchorTime);
    assert.deepEqual(await relatedSessionEvidence(query, "now"), []);
    const prefix = "Ruby measurement ".repeat(110);
    const suffix = "end ".repeat(400);
    await session("now", [user(prefix + "OLD" + suffix)], anchorTime);
    const nearDuplicate = evidenceFromHistory([user(prefix + "NEW" + suffix)], "now");
    assert.deepEqual(await relatedSessionEvidence(nearDuplicate, "now"), []);
  });
});

test("Chinese references resolve by topic while another tenant or a linked transcript stays out", async () => {
  const focus = user("请把收件箱改成上回说的银松代号。");
  const query = evidenceFromHistory([focus], "now");
  const other = path.join(home, "other");
  await homeScope.run(other, () =>
    session("foreign", [user("银松是千岛湖收件箱。")], anchorTime - 1_000),
  );
  await homeScope.run(path.join(home, "self"), async () => {
    await session("now", [focus], anchorTime);
    await session("earlier", [user("收件箱的代号是银松，实际名称为南岭。")], anchorTime - 500);
    await fs.symlink(
      path.join(other, "sessions", "foreign.jsonl"),
      path.join(sessionsDir(), "foreign.jsonl"),
    );
    const found = await relatedSessionEvidence(query, "now");
    assert.deepEqual(
      found.map((e) => e.text),
      ["收件箱的代号是银松，实际名称为南岭。"],
    );
  });
});

test("history and current evidence share a single serialized character allowance", async () => {
  await homeScope.run(home, async () => {
    const focus = user("Which tuning fork calibration selection did we discuss?");
    await session("now", [focus], anchorTime);
    for (let i = 0; i < 5; i++) {
      await session(
        "options-" + i,
        [user("The tuning fork calibration selection " + i + ": " + "x".repeat(740))],
        anchorTime - 10 - i,
      );
    }
    const query = evidenceFromHistory([focus], "now");
    const found = await relatedSessionEvidence(query, "now");
    assert.ok(found.length > 0 && found.length <= 3);
    assert.ok(JSON.stringify(found).length <= 2200);
    const packed = [
      { ...query[0]!, role: "assistant" as const, text: "z".repeat(EVIDENCE_CHAR_BUDGET - 600) },
      ...query,
    ];
    const remainder = await relatedSessionEvidence(packed, "now");
    assert.ok(JSON.stringify([...packed, ...remainder]).length <= EVIDENCE_CHAR_BUDGET);
  });
});

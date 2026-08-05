import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = mkdtempSync(path.join(os.tmpdir(), "lisa-cli-kb-"));
process.env.LISA_HOME = TMP;
process.env.LISA_KB_NO_GIT = "1";

const { runKbCommand } = await import("./kb.js");
const store = await import("../kb/store.js");

after(() => rmSync(TMP, { recursive: true, force: true }));

// Capture console output per run — the CLI's contract IS its printed lines.
let out: string[] = [];
let err: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  out = [];
  err = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
});
after(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("lisa kb CLI", () => {
  test("bad / missing subcommand prints usage", async () => {
    assert.equal(await runKbCommand(["bogus"]), 2);
    assert.match(err.join("\n"), /usage: lisa kb add/);
  });

  test("add without a url errors with usage", async () => {
    assert.equal(await runKbCommand(["add"]), 2);
    assert.match(err.join("\n"), /lisa kb add <url>/);
  });

  test("list: empty KB, then entries with layer/date/tags", async () => {
    assert.equal(await runKbCommand(["list"]), 0);
    assert.match(out.join("\n"), /knowledge base is empty/);

    await store.addSource({ title: "Meeting", body: "notes", tags: ["work"] });
    await store.writeWiki({ title: "Projects", body: "current work" });
    out = [];
    assert.equal(await runKbCommand(["list"]), 0);
    const text = out.join("\n");
    assert.match(text, /wiki .*projects.*Projects/);
    assert.match(text, /source .*meeting.*Meeting.*#work/);

    out = [];
    assert.equal(await runKbCommand(["list", "wiki"]), 0);
    assert.doesNotMatch(out.join("\n"), /Meeting/);
  });

  test("search hits and misses", async () => {
    assert.equal(await runKbCommand(["search", "projects"]), 0);
    assert.match(out.join("\n"), /\[wiki\/projects\]/);
    out = [];
    assert.equal(await runKbCommand(["search", "zzznotoken"]), 0);
    assert.match(out.join("\n"), /no matches/);
  });

  test("brief: none yet → pointer at feeds.json; existing brief prints", async () => {
    assert.equal(await runKbCommand(["brief"]), 0);
    assert.match(out.join("\n"), /no briefs yet.*feeds\.json/);

    // K-H writes briefs as sources/brief-<date>.md; simulate one.
    const { atomicWrite } = await import("../fs-utils.js");
    const { entryFile } = await import("../kb/paths.js");
    await atomicWrite(
      entryFile("sources", "brief-2026-07-23"),
      "---\ntitle: Daily brief 2026-07-23\ncreated: 2026-07-23T08:00:00Z\norigin: brief\n---\n\n- top story one\n",
    );
    out = [];
    assert.equal(await runKbCommand(["brief"]), 0);
    assert.match(out.join("\n"), /Daily brief 2026-07-23/);
    assert.match(out.join("\n"), /top story one/);

    out = [];
    assert.equal(await runKbCommand(["brief", "2026-01-01"]), 0);
    assert.match(out.join("\n"), /no brief for 2026-01-01/);
  });
});

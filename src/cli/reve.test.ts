import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LISA_SOUL_GIT = "0";
process.env.LISA_KB_NO_GIT = "1";

const { runReveCommand } = await import("./reve.js");
const { parseArgs } = await import("../cli-args.js");
const { withDream } = await import("../reve/record.js");
const { listDreams } = await import("../reve/store.js");
const { appendMemory } = await import("../memory/store.js");
const soulStore = await import("../soul/store.js");

let home: string;
const savedHome = process.env.LISA_HOME;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) },
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-reve-cli-"));
  process.env.LISA_HOME = home;
  fs.mkdirSync(path.join(home, "memory"), { recursive: true });
  fs.writeFileSync(path.join(home, "memory", "MEMORY.md"), "- tea\n");
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function makeDream(): Promise<string> {
  await withDream({ trigger: "idle" }, async () => {
    await appendMemory("memory", "coffee now");
    await soulStore.writeIdentity("I am Lisa; I changed.");
  });
  return (await listDreams(1)).dreams[0]!.id;
}

describe("lisa reve", () => {
  test("argv reaches the handler verbatim", () => {
    const parsed = parseArgs(["reve", "revert", "d-x", "--parts", "memory,kb", "--force"]);
    assert.equal(parsed.subcommand, "reve");
    assert.deepEqual(parsed.subargs, ["revert", "d-x", "--parts", "memory,kb", "--force"]);
  });

  test("dreams / show / revert / reconsider / metrics", async () => {
    const id = await makeDream();
    let c = io();
    assert.equal(await runReveCommand(["dreams", "--limit", "5"], c.io), 0);
    assert.match(c.out.join("\n"), new RegExp(id));
    assert.match(c.out.join("\n"), /revertible: memory/);

    c = io();
    assert.equal(await runReveCommand(["show", id], c.io), 0);
    assert.match(c.out.join("\n"), /\[soul\] soul\/identity\.md/);
    assert.match(c.out.join("\n"), /Lisa's/);

    c = io();
    assert.equal(await runReveCommand(["revert", id, "--parts", "soul"], c.io), 2);
    assert.match(c.err.join("\n"), /reconsider/);

    c = io();
    assert.equal(await runReveCommand(["revert", id, "--parts", "memory"], c.io), 0);
    assert.equal(fs.readFileSync(path.join(home, "memory", "MEMORY.md"), "utf8"), "- tea\n");

    c = io();
    assert.equal(await runReveCommand(["reconsider", id, "please", "think", "again"], c.io), 0);
    assert.match(c.out.join("\n"), /decide for herself/);

    c = io();
    assert.equal(await runReveCommand(["metrics", "--days", "2", "--json"], c.io), 0);
    const series = JSON.parse(c.out.join("\n")) as {
      totals: { dreams: number; identityPatches: number };
    };
    assert.equal(series.totals.dreams, 1);
    assert.equal(series.totals.identityPatches, 1);
  });

  test("a conflicting revert exits 3 and explains --force", async () => {
    const page = path.join(home, "kb", "wiki", "tea.md");
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, "# Tea\n");
    await withDream({ trigger: "idle" }, async () => {
      fs.writeFileSync(page, "# Tea, by Lisa\n");
    });
    const id = (await listDreams(1)).dreams[0]!.id;
    fs.writeFileSync(page, "# Tea, edited later\n");
    const c = io();
    assert.equal(await runReveCommand(["revert", id, "--parts", "kb"], c.io), 3);
    assert.match(c.err.join("\n"), /--force/);
  });

  test("a memory revert is entry-level: the user's later entry is kept, no conflict", async () => {
    const id = await makeDream();
    fs.appendFileSync(path.join(home, "memory", "MEMORY.md"), "- edited later\n");
    const c = io();
    assert.equal(await runReveCommand(["revert", id, "--parts", "memory"], c.io), 0);
    assert.equal(
      fs.readFileSync(path.join(home, "memory", "MEMORY.md"), "utf8"),
      "- tea\n- edited later\n",
    );
  });

  test("reconsider with dreams off says so and queues nothing (#423 F3)", async () => {
    const id = await makeDream();
    process.env.LISA_REVE_DREAMS = "0";
    const c = io();
    try {
      assert.equal(await runReveCommand(["reconsider", id, "while off"], c.io), 2);
    } finally {
      delete process.env.LISA_REVE_DREAMS;
    }
    assert.match(c.err.join("\n"), /dreams are turned off/);
    assert.equal(fs.existsSync(path.join(home, "reve", "reconsider.json")), false);
  });

  test("unknown dream ids fail cleanly", async () => {
    const c = io();
    assert.equal(await runReveCommand(["show", "d-20261009T000000000-00000000"], c.io), 1);
    assert.match(c.err.join("\n"), /not found/);
  });
});

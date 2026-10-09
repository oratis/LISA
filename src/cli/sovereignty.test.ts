import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { parseArgs } from "../cli-args.js";
import { runExportCommand, runForgetCommand, runImportCommand, type CliIo } from "./sovereignty.js";

let root: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-cli-sov-"));
  home = path.join(root, "home");
  process.env.LISA_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string, base = home): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function io(answer: boolean | null = null): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    confirm: answer === null ? null : async () => answer,
  };
}

describe("cli args", () => {
  test("forget/export/import are subcommands whose flags pass through", () => {
    const f = parseArgs(["forget", "project falcon", "--dry-run"]);
    assert.equal(f.subcommand, "forget");
    assert.deepEqual(f.subargs, ["project falcon", "--dry-run"]);
    const e = parseArgs(["export", "--out", "x.tar.gz", "--include-sessions"]);
    assert.equal(e.subcommand, "export");
    assert.deepEqual(e.subargs, ["--out", "x.tar.gz", "--include-sessions"]);
    const i = parseArgs(["import", "x.tar.gz", "--into", "/tmp/h", "--replace"]);
    assert.equal(i.subcommand, "import");
    assert.deepEqual(i.subargs, ["x.tar.gz", "--into", "/tmp/h", "--replace"]);
  });
});

describe("lisa forget", () => {
  test("--dry-run reports and changes nothing", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n- likes tea\n");
    const t = io();
    assert.equal(await runForgetCommand(["project falcon", "--dry-run"], t), 0);
    assert.ok(t.lines.some((l) => /dry run/.test(l)));
    assert.ok(t.lines.some((l) => /memory\s+1/.test(l)));
    assert.ok(
      t.lines.some((l) => /provider/i.test(l)),
      "residuals are listed",
    );
    assert.match(fs.readFileSync(path.join(home, "memory/MEMORY.md"), "utf8"), /Falcon/);
  });

  test("refuses to write without a TTY or --yes; honours a 'no'; applies with --yes", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n- likes tea\n");
    const noTty = io(null);
    assert.equal(await runForgetCommand(["project falcon"], noTty), 2);
    assert.match(noTty.errors.join("\n"), /--yes/);
    assert.equal(await runForgetCommand(["project falcon"], io(false)), 1);
    assert.match(fs.readFileSync(path.join(home, "memory/MEMORY.md"), "utf8"), /Falcon/);
    const yes = io(null);
    assert.equal(await runForgetCommand(["project falcon", "--yes"], yes), 0);
    assert.equal(fs.readFileSync(path.join(home, "memory/MEMORY.md"), "utf8"), "- likes tea\n");
    assert.ok(yes.lines.some((l) => /Verified: no layer still matches/.test(l)));
  });

  test("rejects a too-short topic", async () => {
    const t = io();
    assert.equal(await runForgetCommand(["ab", "--dry-run"], t), 2);
  });
});

describe("lisa export / import", () => {
  test("export → import round trip through the CLI", async () => {
    write("soul/identity.md", "I am Lisa.\n");
    write("memory/MEMORY.md", "- likes tea\n");
    write("config.env", "ANTHROPIC_API_KEY=sk-test\n");
    const out = path.join(root, "lisa.tar.gz");
    const t = io();
    assert.equal(await runExportCommand(["--out", out], t), 0);
    assert.ok(fs.existsSync(out));
    assert.ok(t.lines.some((l) => /Never exported/.test(l)));
    // No silent overwrite.
    assert.equal(await runExportCommand(["--out", out], io()), 2);

    const dest = path.join(root, "dest");
    const imp = io();
    assert.equal(await runImportCommand([out, "--into", dest], imp), 0);
    assert.equal(fs.readFileSync(path.join(dest, "soul/identity.md"), "utf8"), "I am Lisa.\n");
    assert.ok(!fs.existsSync(path.join(dest, "config.env")));

    // Second import refuses the existing soul; --replace backs it up.
    const again = io();
    assert.equal(await runImportCommand([out, "--into", dest], again), 2);
    assert.match(again.errors.join("\n"), /soul_exists/);
    const replace = io();
    assert.equal(await runImportCommand([out, "--into", dest, "--replace"], replace), 0);
    assert.ok(replace.lines.some((l) => /backed up to/.test(l)));
  });

  test("import refuses a non-archive", async () => {
    const bogus = path.join(root, "bogus.tar.gz");
    fs.writeFileSync(bogus, "nope");
    const t = io();
    assert.equal(await runImportCommand([bogus, "--into", path.join(root, "d")], t), 2);
    assert.match(t.errors.join("\n"), /invalid_archive/);
  });
});

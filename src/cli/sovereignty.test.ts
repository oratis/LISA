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
  const isFile = (p: string) => p === "x.tar.gz";

  test("forget/export/import are subcommands in exactly their own form", () => {
    const f = parseArgs(["forget", "project falcon", "--dry-run"]);
    assert.equal(f.subcommand, "forget");
    assert.deepEqual(f.subargs, ["project falcon", "--dry-run"]);
    const e = parseArgs(["export", "--out", "x.tar.gz", "--include-sessions"]);
    assert.equal(e.subcommand, "export");
    assert.deepEqual(e.subargs, ["--out", "x.tar.gz", "--include-sessions"]);
    assert.equal(parseArgs(["export"]).subcommand, "export");
    assert.equal(parseArgs(["export", "--out=a.tar.gz", "--force"]).subcommand, "export");
    const i = parseArgs(["import", "x.tar.gz", "--into", "/tmp/h", "--replace"], { isFile });
    assert.equal(i.subcommand, "import");
    assert.deepEqual(i.subargs, ["x.tar.gz", "--into", "/tmp/h", "--replace"]);
    assert.equal(parseArgs(["forget", "--help"]).subcommand, "forget");
  });

  test("a prompt that merely starts with those words stays a prompt", () => {
    for (const line of [
      "export the report to pdf",
      "import all my notes please",
      "forget it, just say hi",
      "forget about the meeting",
      "export my notes",
    ]) {
      const a = parseArgs(line.split(" "), { isFile });
      assert.equal(a.subcommand, undefined, line);
      assert.equal(a.prompt, line, line);
    }
    // import needs an existing file.
    assert.equal(
      parseArgs(["import", "missing.tar.gz"], { isFile }).prompt,
      "import missing.tar.gz",
    );
    // export/forget with flags they don't take are not the subcommand either:
    // parsed as before, where an unknown flag is an error, never an action.
    assert.throws(
      () => parseArgs("forget about the meeting --yes".split(" ")),
      /unknown flag: --yes/,
    );
    assert.throws(() => parseArgs(["export", "--yes"]), /unknown flag: --yes/);
    // Global flags after the word still work for a prompt.
    const g = parseArgs(["what", "should", "I", "export", "--model", "m-x"]);
    assert.equal(g.prompt, "what should I export");
    assert.equal(g.model, "m-x");
  });
});

describe("lisa forget", () => {
  test("--dry-run reports and changes nothing", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n- likes tea\n");
    const t = io();
    assert.equal(await runForgetCommand(["project falcon", "--dry-run"], t), 0);
    assert.ok(t.lines.some((l) => /preview \(nothing changed yet\)/.test(l)));
    assert.ok(t.lines.some((l) => /memory\s+1/.test(l)));
    // Each item is listed with the text around the match.
    assert.ok(t.lines.some((l) => /delete\s+memory\/MEMORY\.md#m_/.test(l)));
    assert.ok(t.lines.some((l) => l.includes("“Project Falcon ships in May”")));
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
    // Says what the re-scan covered and what it did not — never a blanket "verified".
    assert.ok(
      yes.lines.some((l) =>
        /Re-scan after forget finds nothing left in the areas it covers/.test(l),
      ),
    );
    assert.ok(yes.lines.some((l) => /✓ tasks\//.test(l)));
    assert.ok(!yes.lines.some((l) => /no layer still matches/i.test(l)));
  });

  test("lists the places it did not scan after applying", async () => {
    write("memory/MEMORY.md", "- Project Falcon ships in May\n");
    write("skills/falcon/SKILL.md", "Project Falcon notes\n");
    const t = io(null);
    assert.equal(await runForgetCommand(["project falcon", "--yes"], t), 0);
    const i = t.lines.findIndex((l) => /Not scanned, so it may still be mentioned in/.test(l));
    assert.ok(i > 0);
    assert.match(t.lines[i + 1]!, /\? skills — skill instructions/);
  });

  test("rejects a too-short topic", async () => {
    const t = io();
    assert.equal(await runForgetCommand(["ab", "--dry-run"], t), 2);
  });
});

describe("lisa export / import", () => {
  test("export without --out asks first, refuses without a TTY, and says it is unencrypted", async () => {
    write("soul/identity.md", "I am Lisa.\n");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const noTty = io(null);
      assert.equal(await runExportCommand([], noTty), 2);
      assert.match(noTty.errors.join("\n"), /unencrypted.*--out/);
      const no = io(false);
      assert.equal(await runExportCommand([], no), 1);
      assert.deepEqual(
        fs.readdirSync(root).filter((n) => n.endsWith(".tar.gz")),
        [],
        "nothing written without a yes",
      );
      const yes = io(true);
      assert.equal(await runExportCommand([], yes), 0);
      assert.equal(fs.readdirSync(root).filter((n) => n.endsWith(".tar.gz")).length, 1);
      assert.ok(
        yes.lines.some((l) => l.includes(`→ ${fs.realpathSync(root)}`) || l.includes(`→ ${root}`)),
      );
      assert.ok(yes.lines.some((l) => /NOT encrypted/.test(l)));
    } finally {
      process.chdir(cwd);
    }
  });

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

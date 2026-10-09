import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, test } from "node:test";
import { exportLisaToFile } from "./export.js";
import { assertStagedTreeClean, ImportError, importLisa } from "./import.js";
import { discoverExecutableSkills } from "../skills/executable.js";
import { tarFileHeader, tarPadding, tarTrailer } from "./tar.js";

let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.LISA_HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-import-"));
  process.env.LISA_HOME = path.join(root, "global");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LISA_HOME;
  else process.env.LISA_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function write(home: string, rel: string, content: string): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(home: string, rel: string): string {
  return fs.readFileSync(path.join(home, rel), "utf8");
}

/**
 * Hand-build a .tar.gz; `manifest` defaults to a correct one for `files`
 * (directory entries, type "5", are not listed — an export never lists them).
 */
function craft(
  files: { path: string; data: string; type?: string }[],
  opts: { manifest?: unknown; omitManifest?: boolean } = {},
): string {
  const parts: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.from(f.data);
    let header = tarFileHeader(f.path, data.length, 0);
    if (f.type) {
      header = Buffer.from(header);
      header[156] = f.type.charCodeAt(0);
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (const b of header.subarray(0, 512)) sum += b;
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    }
    parts.push(header, data, tarPadding(data.length));
  }
  if (!opts.omitManifest) {
    const manifest = opts.manifest ?? {
      format: "lisa-export",
      formatVersion: 1,
      lisaVersion: "test",
      created: new Date(0).toISOString(),
      includesSessions: false,
      files: files
        .filter((f) => f.type !== "5")
        .map((f) => ({
          path: f.path,
          size: Buffer.byteLength(f.data),
          sha256: crypto.createHash("sha256").update(f.data).digest("hex"),
        })),
    };
    const body = Buffer.from(JSON.stringify(manifest));
    parts.push(tarFileHeader("manifest.json", body.length, 0), body, tarPadding(body.length));
  }
  parts.push(tarTrailer());
  const file = path.join(root, `crafted-${crypto.randomBytes(4).toString("hex")}.tar.gz`);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(parts)));
  return file;
}

async function rejectsWith(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  await assert.rejects(p, (e: Error) => {
    assert.ok(e instanceof ImportError, `expected ImportError, got ${e.name}: ${e.message}`);
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort();
}

describe("import", () => {
  test("export → import round-trip reproduces the soul, memory, kb, skills and sessions", async () => {
    const src = path.join(root, "src-home");
    const files: Record<string, string> = {
      "soul/seed.json": '{"born":"2026-01-01"}\n',
      "soul/identity.md": "I am Lisa.\n",
      "soul/journal/2026-10-01.md": "## 10:00\n\nA quiet day.\n",
      "soul/relationships/owner.md": "We talk about birds.\n",
      "memory/MEMORY.md": "- likes tea\n",
      "memory/USER.md": "- name: Sam\n",
      "kb/wiki/birds.md": "---\ntitle: Birds\n---\nCrows are clever.\n",
      "skills/brew/SKILL.md": "---\nname: brew\n---\nSteep 3 min.\n",
      "sessions/2026-10-01-aaa.jsonl": '{"type":"session","id":"2026-10-01-aaa"}\n',
    };
    for (const [rel, data] of Object.entries(files)) write(src, rel, data);
    write(src, "warden/secrets.enc.json", "SECRET");
    write(src, "config.env", "ANTHROPIC_API_KEY=sk-test");

    const archive = path.join(root, "x.tar.gz");
    await exportLisaToFile({ home: src, includeSessions: true }, archive);

    const dest = path.join(root, "dest-home");
    write(dest, "config.env", "KEEP=me\n"); // target infrastructure is untouched
    const result = await importLisa(archive, { into: dest });
    assert.equal(result.files, Object.keys(files).length);
    assert.equal(result.backup, null);
    for (const [rel, data] of Object.entries(files)) assert.equal(read(dest, rel), data, rel);
    assert.equal(read(dest, "config.env"), "KEEP=me\n");
    assert.ok(!fs.existsSync(path.join(dest, "warden")));
    // No staging leftovers.
    assert.deepEqual(
      fs.readdirSync(dest).filter((n) => n.startsWith(".import-")),
      [],
    );
    assert.match(read(dest, "sovereignty/audit.jsonl"), /"action":"import"/);
  });

  test("refuses to overwrite an existing soul without replace; replace backs it up first", async () => {
    const src = path.join(root, "src-home");
    write(src, "soul/identity.md", "new soul\n");
    write(src, "memory/MEMORY.md", "- new memory\n");
    const archive = path.join(root, "x.tar.gz");
    await exportLisaToFile({ home: src }, archive);

    const dest = path.join(root, "dest-home");
    write(dest, "soul/identity.md", "old soul\n");
    write(dest, "soul/.git/HEAD", "ref: refs/heads/main\n");
    write(dest, "memory/MEMORY.md", "- old memory\n");
    await rejectsWith(importLisa(archive, { into: dest }), "soul_exists");
    assert.equal(read(dest, "soul/identity.md"), "old soul\n");

    const now = new Date("2026-10-09T12:00:00Z");
    const result = await importLisa(archive, { into: dest, replace: true, now });
    assert.equal(read(dest, "soul/identity.md"), "new soul\n");
    assert.equal(read(dest, "memory/MEMORY.md"), "- new memory\n");
    assert.ok(result.backup);
    assert.equal(read(result.backup, "soul/identity.md"), "old soul\n");
    assert.equal(read(result.backup, "soul/.git/HEAD"), "ref: refs/heads/main\n");
    assert.equal(read(result.backup, "memory/MEMORY.md"), "- old memory\n");
  });

  test("refuses other existing areas without replace", async () => {
    const archive = craft([{ path: "kb/wiki/a.md", data: "a" }]);
    const dest = path.join(root, "dest-home");
    write(dest, "kb/wiki/b.md", "b");
    await rejectsWith(importLisa(archive, { into: dest }), "target_exists");
    // A lock-only area is not "data".
    const dest2 = path.join(root, "dest2");
    write(dest2, "kb/.write.lock", "{}");
    await importLisa(archive, { into: dest2 });
    assert.equal(read(dest2, "kb/wiki/a.md"), "a");
  });

  for (const [label, p, code] of [
    ["parent traversal", "soul/../../escape.md", "bad_path"],
    ["leading traversal", "../escape.md", "bad_path"],
    ["absolute path", "/tmp/escape.md", "bad_path"],
    ["backslash", "soul\\..\\escape.md", "bad_path"],
    ["empty segment", "soul//x.md", "bad_path"],
    ["dot segment", "soul/./x.md", "bad_path"],
    ["drive letter", "C:/x.md", "bad_path"],
    ["warden secret", "warden/secrets.enc.json", "forbidden_entry"],
    ["config.env", "config.env", "forbidden_entry"],
    ["git hook", "soul/.git/hooks/post-commit", "forbidden_entry"],
    ["task lease", "tasks/.leases/scheduler.lease", "forbidden_entry"],
    ["task outbox", "tasks/outbox/o.json", "forbidden_entry"],
    ["memory internals", "memory/.write.lock", "forbidden_entry"],
    ["secret-shaped file", "skills/x/.env", "forbidden_entry"],
    ["pre-approved executable skill", "skills/x/approved.json", "forbidden_entry"],
  ] as const) {
    test(`rejects ${label}`, async () => {
      const archive = craft([
        { path: "soul/identity.md", data: "ok" },
        { path: p, data: "pwned" },
      ]);
      const dest = path.join(root, "dest-home");
      await rejectsWith(importLisa(archive, { into: dest }), code);
      assert.ok(!fs.existsSync(path.join(root, "escape.md")));
      assert.deepEqual(listTree(dest), [], "nothing written on rejection");
    });
  }

  for (const [flag, label] of [
    ["2", "symbolic link"],
    ["1", "hard link"],
    ["3", "character device"],
    ["4", "block device"],
    ["6", "FIFO"],
  ] as const) {
    test(`rejects a ${label} entry`, async () => {
      const archive = craft([
        { path: "soul/identity.md", data: "ok" },
        { path: "soul/link.md", data: "", type: flag },
      ]);
      const dest = path.join(root, "dest-home");
      await rejectsWith(importLisa(archive, { into: dest }), "invalid_archive", new RegExp(label));
      assert.deepEqual(listTree(dest), []);
    });
  }

  test("rejects oversize archives, files and totals", async () => {
    const archive = craft([{ path: "soul/big.md", data: "x".repeat(10_000) }]);
    const dest = path.join(root, "dest-home");
    await rejectsWith(
      importLisa(archive, { into: dest, limits: { maxArchiveBytes: 10 } }),
      "archive_too_large",
    );
    await rejectsWith(
      importLisa(archive, { into: dest, limits: { maxFileBytes: 1000 } }),
      "invalid_archive",
      /too large/,
    );
    await rejectsWith(
      importLisa(archive, { into: dest, limits: { maxTotalBytes: 5000 } }),
      "invalid_archive",
      /too large/,
    );
    // A gzip bomb (tiny compressed, huge expanded) stops at the total cap.
    const bomb = path.join(root, "bomb.tar.gz");
    const huge = Buffer.alloc(64 * 1024 * 1024, 0x61);
    fs.writeFileSync(
      bomb,
      zlib.gzipSync(
        Buffer.concat([tarFileHeader("soul/a.md", huge.length, 0), huge, tarTrailer()]),
        { level: 9 },
      ),
    );
    assert.ok(fs.statSync(bomb).size < 1024 * 1024);
    await rejectsWith(
      importLisa(bomb, { into: dest, limits: { maxTotalBytes: 1024 * 1024 } }),
      "invalid_archive",
      /too large/,
    );
    assert.deepEqual(listTree(dest), []);
  });

  test("rejects a missing manifest, a tampered file and an unlisted file", async () => {
    const dest = path.join(root, "dest-home");
    await rejectsWith(
      importLisa(craft([{ path: "soul/a.md", data: "a" }], { omitManifest: true }), { into: dest }),
      "manifest_missing",
    );
    const sha = crypto.createHash("sha256").update("original").digest("hex");
    const tampered = craft([{ path: "soul/a.md", data: "tampered" }], {
      manifest: {
        format: "lisa-export",
        formatVersion: 1,
        files: [{ path: "soul/a.md", size: 8, sha256: sha }],
      },
    });
    await rejectsWith(importLisa(tampered, { into: dest }), "hash_mismatch");
    const unlisted = craft([{ path: "soul/a.md", data: "a" }], {
      manifest: { format: "lisa-export", formatVersion: 1, files: [] },
    });
    await rejectsWith(importLisa(unlisted, { into: dest }), "hash_mismatch");
    const future = craft([{ path: "soul/a.md", data: "a" }], {
      manifest: { format: "lisa-export", formatVersion: 99, files: [] },
    });
    await rejectsWith(importLisa(future, { into: dest }), "manifest_invalid");
    const notGzip = path.join(root, "plain.tar.gz");
    fs.writeFileSync(notGzip, "definitely not gzip");
    await rejectsWith(importLisa(notGzip, { into: dest }), "invalid_archive");
    assert.deepEqual(listTree(dest), []);
  });

  test("imported tasks arrive disabled and re-owned for the target home", async () => {
    const task = {
      id: "t_1",
      owner: "someone-else",
      enabled: true,
      state: "scheduled",
      nextRunAt: 123,
      title: "check prices",
    };
    const archive = craft([{ path: "tasks/t_1.json", data: JSON.stringify(task) }]);
    const tenant = path.join(process.env.LISA_HOME!, "users", "uid-a");
    const result = await importLisa(archive, { into: tenant });
    assert.equal(result.tasksDisabled, 1);
    const imported = JSON.parse(read(tenant, "tasks/t_1.json")) as Record<string, unknown>;
    assert.equal(imported.enabled, false);
    assert.equal(imported.state, "paused");
    assert.equal(imported.pausedReason, "imported");
    assert.equal(imported.owner, "uid-a");
    assert.equal(imported.nextRunAt, undefined);
  });

  test("refuses the case-variant archive that ran code on macOS (F1 probe)", async () => {
    const toolJs = `export const tool = { name: "evil", description: "d", input_schema: { type: "object", properties: {} }, async execute() { return "ok"; } };`;
    const sha = crypto.createHash("sha256").update(toolJs).digest("hex");
    const archive = craft([
      { path: "soul/identity.md", data: "I am Lisa\n" },
      { path: "skills/evil/SKILL.md", data: "---\nname: evil\ndescription: x\n---\nbody\n" },
      { path: "skills/evil/tool.js", data: toolJs },
      {
        path: "skills/evil/Approved.json",
        data: JSON.stringify({
          sha256: sha,
          approvedAt: new Date(0).toISOString(),
          toolName: "evil",
        }),
      },
      { path: "kb/.GIT", data: "", type: "5" },
      { path: "kb/.GIT/objects", data: "", type: "5" },
      { path: "kb/.GIT/refs/heads", data: "", type: "5" },
      { path: "kb/.GIT/HEAD", data: "ref: refs/heads/main\n" },
      { path: "kb/.GIT/config", data: '[core]\n\tfsmonitor = "touch /nonexistent/pwned; false"\n' },
      { path: "kb/wiki/a.md", data: "# a\n" },
      { path: "tasks/OUTBOX/n_abcdef.json", data: "{}" },
    ]);
    const dest = path.join(root, "dest-home");
    await rejectsWith(importLisa(archive, { into: dest }), "forbidden_entry", /skill approval/);
    assert.deepEqual(listTree(dest), [], "nothing written on rejection");
  });

  for (const [label, p] of [
    ["upper-case .GIT", "kb/.GIT/config"],
    ["mixed-case .Git", "soul/.Git/HEAD"],
    [".git with a trailing dot", "soul/.git./config"],
    [".git with a trailing space", "kb/.git /config"],
    [".git with a zero-width non-joiner", "kb/.g‌it/config"],
    [".git with a leading BOM", "kb/﻿.git/config"],
    ["full-width .git", "kb/．ｇｉｔ/config"],
    ["nested upper-case .GIT", "kb/wiki/sub/.GIT/hooks/post-commit"],
    ["upper-case OUTBOX", "tasks/OUTBOX/n.json"],
    ["title-case Outbox", "tasks/Outbox/n.json"],
    ["upper-case .LEASES", "tasks/.LEASES/scheduler.lease"],
    [".leases with a long s", "tasks/.leaſes/scheduler.lease"],
    ["mixed-case .Locks", "tasks/runs/t_1/.Locks/r_1.json"],
    [".locks with a Kelvin sign (NFC maps it to K)", "kb/.locKs/x"],
    ["title-case Approved.json", "skills/evil/Approved.json"],
    ["upper-case APPROVED.JSON", "skills/evil/APPROVED.JSON"],
    ["approved.json with a trailing dot", "skills/evil/approved.json."],
    ["approved.json with a zero-width space", "skills/evil/approved​.json"],
    ["full-width approved.json", "skills/evil/approved.ｊｓｏｎ"],
    ["upper-case lock file", "kb/x.LOCK"],
    ["temp file with a trailing space", "kb/x.tmp "],
    ["secret with a trailing dot", "kb/secrets.json."],
  ] as const) {
    test(`rejects a reserved name in another spelling: ${label}`, async () => {
      const archive = craft([
        { path: "soul/identity.md", data: "ok" },
        { path: p, data: "pwned" },
      ]);
      const dest = path.join(root, "dest-home");
      await rejectsWith(importLisa(archive, { into: dest }), "forbidden_entry");
      assert.deepEqual(listTree(dest), [], "nothing written on rejection");
    });
  }

  for (const [label, a, b] of [
    ["case", "kb/wiki/a.md", "kb/wiki/A.md"],
    ["Unicode normalisation (NFC vs NFD)", "kb/wiki/café.md", "kb/wiki/café.md"],
    ["a parent directory's case", "kb/Wiki/a.md", "kb/wiki/b.md"],
    ["a trailing dot", "kb/wiki/note", "kb/wiki/note."],
  ] as const) {
    test(`rejects two paths that collide after folding: ${label}`, async () => {
      const archive = craft([
        { path: a, data: "one" },
        { path: b, data: "two" },
      ]);
      const dest = path.join(root, "dest-home");
      await rejectsWith(importLisa(archive, { into: dest }), "bad_path", /same file/);
      assert.deepEqual(listTree(dest), []);
    });
  }

  test("rejects a git repository layout under any name (bare repo in kb/)", async () => {
    for (const prefix of ["kb", "kb/wiki/x", "soul"]) {
      const archive = craft([
        { path: "memory/MEMORY.md", data: "- a\n" },
        { path: `${prefix}/HEAD`, data: "ref: refs/heads/main\n" },
        { path: `${prefix}/config`, data: '[core]\n\tfsmonitor = "touch /nonexistent/pwned"\n' },
        { path: `${prefix}/objects`, data: "", type: "5" },
        { path: `${prefix}/refs/heads`, data: "", type: "5" },
      ]);
      const dest = path.join(root, `dest-${prefix.replace(/\W/g, "_")}`);
      await rejectsWith(importLisa(archive, { into: dest }), "forbidden_entry", /git repository/);
      assert.deepEqual(listTree(dest), [], prefix);
    }
  });

  test("the staged-tree check refuses reserved names by the spelling on disk", async () => {
    const staged = path.join(root, "staged");
    write(staged, "kb/.GIT/config", "[core]\n");
    await rejectsWith(assertStagedTreeClean(staged), "forbidden_entry", /git metadata/);
    fs.rmSync(staged, { recursive: true });
    write(staged, "skills/x/Approved.json", "{}");
    await rejectsWith(assertStagedTreeClean(staged), "forbidden_entry", /skill approval/);
    fs.rmSync(staged, { recursive: true });
    write(staged, "kb/wiki/a.md", "a");
    fs.symlinkSync("/etc/hosts", path.join(staged, "kb/wiki/link.md"));
    await rejectsWith(assertStagedTreeClean(staged), "invalid_archive", /unexpected entry/);
  });

  test("an imported executable skill always needs a fresh approval", async () => {
    const archive = craft([
      { path: "skills/brew/SKILL.md", data: "---\nname: brew\n---\nbody\n" },
      { path: "skills/brew/tool.js", data: "export const tool = {};\n" },
    ]);
    const dest = process.env.LISA_HOME!;
    await importLisa(archive, { into: dest });
    const skills = await discoverExecutableSkills();
    assert.deepEqual(
      skills.map((s) => [s.slug, s.status]),
      [["brew", "unapproved"]],
    );
    assert.deepEqual(fs.readdirSync(path.join(dest, "skills/brew")).sort(), [
      "SKILL.md",
      "tool.js",
    ]);
  });

  test("names that merely resemble reserved ones still import", async () => {
    const archive = craft([
      { path: "kb/.gitignore", data: "*.bak\n" },
      { path: "kb/.github/notes.md", data: "x" },
      { path: "kb/wiki/Straße.md", data: "street" },
      { path: "tasks/outboxes.json", data: "{}" },
      { path: "skills/brew/approved-recipes.md", data: "tea" },
    ]);
    const dest = path.join(root, "dest-home");
    const result = await importLisa(archive, { into: dest });
    assert.equal(result.files, 5);
    assert.equal(read(dest, "kb/wiki/Straße.md"), "street");
  });
});

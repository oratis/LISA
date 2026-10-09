import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, test } from "node:test";
import { exportLisaToFile, EXPORT_FORMAT, planExport } from "./export.js";
import { readTar } from "./tar.js";

let home: string;
let out: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-export-"));
  out = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-export-out-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

function plant(rel: string, content = `planted ${rel}\n`): void {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Files that MUST travel with a Lisa. */
const KEPT = [
  "soul/seed.json",
  "soul/identity.md",
  "soul/soul.lock.json",
  "soul/journal/2026-10-01.md",
  "soul/relationships/owner.md",
  "memory/MEMORY.md",
  "memory/USER.md",
  "kb/wiki/project-x.md",
  "kb/sources/2026-10-01-note.md",
  "kb/index.md",
  "skills/brew/SKILL.md",
  "tasks/t_1.json",
  "tasks/runs/t_1/r_1.jsonl",
];

/** Secrets + infrastructure state that must NEVER appear in an export. */
const PLANTED_SECRETS = [
  // warden/ — the whole directory
  "warden/secrets.enc.json",
  "warden/secret.key",
  "warden/secrets.index.json",
  "warden/grants.json",
  "warden/rules.json",
  "warden/digest.key",
  "warden/tainted.json",
  "warden/audit.jsonl",
  "warden/audit-20261001-1.jsonl",
  "warden/pending.json",
  // task infrastructure
  "tasks/.leases/scheduler.lease",
  "tasks/.locks/t_1.lock",
  "tasks/runs/t_1/.locks/r_1.lock",
  "tasks/outbox/o_1.json",
  "tasks/outbox/.locks/o_1.lock",
  // operator / account / device / billing / relay / mail state
  "config.env",
  "accounts.json",
  "devices.json",
  "session-secret",
  "otp.json",
  "push.json",
  "channels.json",
  "mcp.json",
  "billing/ledger.json",
  "billing-global.json",
  "iap-transactions.json",
  "mail/accounts.json",
  "mail/oauth-tokens.json",
  "relay/keys.json",
  "sovereignty/audit.jsonl",
  "embeddings/ollama.json",
  // infrastructure inside exported areas
  "soul/.git/config",
  "soul/.git/hooks/post-commit",
  "soul/.write.lock",
  "soul/.git-write.lock",
  "kb/.git/HEAD",
  "kb/.write.lock",
  "memory/.write.lock",
  "memory/MEMORY.md.abc123.tmp",
  // secret-shaped files smuggled into exported areas
  "skills/brew/.env",
  "skills/brew/prod.env",
  "skills/brew/id_rsa.key",
  "kb/sources/cert.pem",
  "soul/secrets.json",
  "sessions/.write.lock",
  // a local trust decision, never portable
  "skills/brew/approved.json",
];

function plantAll(): void {
  for (const rel of KEPT) plant(rel);
  plant("sessions/2026-09-30-def.jsonl", '{"type":"session"}\n');
  for (const rel of PLANTED_SECRETS) plant(rel, "TOP-SECRET-PLANTED\n");
}

async function listArchive(file: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let cur: { path: string; parts: Buffer[] } | null = null;
  await readTar(
    fs.createReadStream(file).pipe(zlib.createGunzip()),
    {
      begin(h) {
        cur = { path: h.path, parts: [] };
      },
      data(c) {
        cur!.parts.push(Buffer.from(c));
      },
      end() {
        files.set(cur!.path, Buffer.concat(cur!.parts));
      },
    },
    { maxFileBytes: 1 << 26, maxTotalBytes: 1 << 28, maxEntries: 10_000 },
  );
  return files;
}

describe("export", () => {
  test("carries the Lisa and none of the planted secrets or infrastructure state", async () => {
    plantAll();
    const file = path.join(out, "x.tar.gz");
    const manifest = await exportLisaToFile({ home }, file);
    const entries = await listArchive(file);

    for (const rel of KEPT) assert.ok(entries.has(rel), `missing ${rel}`);
    for (const rel of PLANTED_SECRETS) assert.ok(!entries.has(rel), `leaked ${rel}`);
    for (const [rel, data] of entries) {
      assert.ok(!data.includes("TOP-SECRET-PLANTED"), `planted content leaked via ${rel}`);
    }
    // Sessions are opt-in.
    assert.equal(manifest.includesSessions, false);
    assert.ok(![...entries.keys()].some((p) => p.startsWith("sessions/")));

    // The manifest is the last entry and hashes every other file.
    const keys = [...entries.keys()];
    assert.equal(keys[keys.length - 1], "manifest.json");
    const parsed = JSON.parse(entries.get("manifest.json")!.toString("utf8")) as typeof manifest;
    assert.equal(parsed.format, EXPORT_FORMAT);
    assert.equal(parsed.formatVersion, 1);
    assert.match(parsed.lisaVersion, /^\d+\.\d+\.\d+|unknown/);
    assert.ok(!Number.isNaN(Date.parse(parsed.created)));
    assert.deepEqual(parsed.files.map((f) => f.path).sort(), keys.slice(0, -1).sort());
    for (const f of parsed.files) {
      const data = entries.get(f.path)!;
      assert.equal(f.size, data.length);
      assert.equal(f.sha256, crypto.createHash("sha256").update(data).digest("hex"));
    }
    assert.ok(parsed.excludes.some((e) => e.includes("warden/")));

    // Exported file is private.
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  });

  test("--include-sessions adds transcripts but still no secrets", async () => {
    plantAll();
    plant("sessions/2026-10-01-abc.jsonl", '{"type":"session"}\n');
    const file = path.join(out, "s.tar.gz");
    const manifest = await exportLisaToFile({ home, includeSessions: true }, file);
    const entries = await listArchive(file);
    assert.equal(manifest.includesSessions, true);
    assert.ok(entries.has("sessions/2026-10-01-abc.jsonl"));
    for (const rel of PLANTED_SECRETS) assert.ok(!entries.has(rel), `leaked ${rel}`);
  });

  test("never follows symlinks (file, directory, or a symlinked export root)", async () => {
    plant("soul/identity.md");
    plant("config.env", "TOP-SECRET-PLANTED\n");
    fs.mkdirSync(path.join(home, "outside"), { recursive: true });
    plant("outside/secret.md", "TOP-SECRET-PLANTED\n");
    fs.symlinkSync(path.join(home, "config.env"), path.join(home, "soul", "linked.md"));
    fs.symlinkSync(path.join(home, "outside"), path.join(home, "soul", "linkdir"));
    fs.symlinkSync(path.join(home, "outside"), path.join(home, "kb"));
    const { files, skipped } = await planExport(home);
    assert.deepEqual(
      files.map((f) => f.rel),
      ["soul/identity.md"],
    );
    assert.equal(skipped, 3);
    const file = path.join(out, "l.tar.gz");
    await exportLisaToFile({ home }, file);
    for (const [, data] of await listArchive(file)) {
      assert.ok(!data.includes("TOP-SECRET-PLANTED"));
    }
  });

  test("records a content-free audit line in the exported home", async () => {
    plant("memory/MEMORY.md", "- private fact\n");
    await exportLisaToFile({ home }, path.join(out, "a.tar.gz"));
    const audit = fs.readFileSync(path.join(home, "sovereignty", "audit.jsonl"), "utf8");
    assert.match(audit, /"action":"export"/);
    assert.ok(!audit.includes("private fact"));
  });
});

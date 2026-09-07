import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOG_FILE_KEEP,
  LOG_FILE_MAX_BYTES,
  closeLogFile,
  formatFileLine,
  formatStructured,
  logError,
  logInfo,
  logWarn,
  redactEmail,
  redactId,
} from "./log.js";

test("formatStructured emits one-line JSON with the severity Cloud Logging lifts", () => {
  const line = formatStructured("INFO", "[web] resuming session abc");
  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line) as { severity: string; message: string };
  assert.equal(parsed.severity, "INFO");
  assert.equal(parsed.message, "[web] resuming session abc");
});

test("redactId keeps a prefix+suffix for correlation, never the middle", () => {
  assert.equal(redactId("550e8400-e29b-41d4-a716-446655440000"), "550e…0000");
  assert.equal(redactId("short"), "sh…");
  assert.equal(redactId(""), "");
});

test("redactEmail drops the identifying local part, keeps the domain", () => {
  assert.equal(redactEmail("alice.smith@example.com"), "al***@example.com");
  assert.equal(redactEmail("a@b.co"), "a***@b.co");
  // Anything that isn't an address must not fall through as-is.
  assert.equal(redactEmail("not-an-address"), "***");
  assert.equal(redactEmail("@nouser.com"), "***");
  assert.equal(redactEmail("trailing@"), "***");
});

describe("LISA_LOG_FILE sink (T-6)", () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-log-"));
  const LOG = path.join(TMP, "nested", "serve.log");

  after(() => {
    delete process.env.LISA_LOG_FILE;
    closeLogFile();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  function withSink<T>(file: string, fn: () => T): T {
    const prev = process.env.LISA_LOG_FILE;
    process.env.LISA_LOG_FILE = file;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.LISA_LOG_FILE;
      else process.env.LISA_LOG_FILE = prev;
      closeLogFile();
    }
  }

  test("formatFileLine is timestamped text regardless of LISA_LOG_FORMAT", () => {
    const line = formatFileLine("WARNING", "[health] lag", new Date("2026-09-06T12:00:00.000Z"));
    assert.equal(line, "2026-09-06T12:00:00.000Z WARNING [health] lag\n");
  });

  test("with the var unset nothing is written and the console path is unchanged", () => {
    delete process.env.LISA_LOG_FILE;
    closeLogFile();
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: string) => seen.push(m);
    try {
      logInfo("straight to stderr");
    } finally {
      console.error = orig;
    }
    assert.deepEqual(seen, ["straight to stderr"]);
    assert.equal(fs.existsSync(LOG), false);
  });

  test("lines are appended (missing directories created) and NOT duplicated to the console", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: string) => seen.push(m);
    try {
      withSink(LOG, () => {
        logInfo("first");
        logWarn("second");
        logError("third");
      });
    } finally {
      console.error = orig;
    }
    assert.deepEqual(seen, [], "the file sink replaces the console, it does not tee");
    const lines = fs.readFileSync(LOG, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO first$/);
    assert.match(lines[1]!, / WARNING second$/);
    assert.match(lines[2]!, / ERROR third$/);

    // A second run appends rather than truncating.
    withSink(LOG, () => logInfo("fourth"));
    assert.equal(fs.readFileSync(LOG, "utf8").trimEnd().split("\n").length, 4);
  });

  test("rotates at the size cap and keeps exactly LOG_FILE_KEEP generations", () => {
    const file = path.join(TMP, "rot.log");
    // One line per rotation: pre-fill the live file past the cap each time.
    const big = "x".repeat(1024);
    withSink(file, () => {
      for (let gen = 0; gen < LOG_FILE_KEEP + 2; gen++) {
        fs.appendFileSync(file, "y".repeat(LOG_FILE_MAX_BYTES));
        // The sink tracks size itself, so make it re-stat by reopening.
        closeLogFile();
        logInfo(`gen${gen} ${big}`);
      }
    });
    // Live file holds only the newest line…
    assert.match(fs.readFileSync(file, "utf8"), new RegExp(`gen${LOG_FILE_KEEP + 1} `));
    // …and exactly five generations survive beside it, oldest dropped.
    for (let i = 1; i <= LOG_FILE_KEEP; i++) {
      assert.equal(fs.existsSync(`${file}.${i}`), true, `.${i} should exist`);
    }
    assert.equal(fs.existsSync(`${file}.${LOG_FILE_KEEP + 1}`), false, "oldest generation is dropped");
    // .1 is the previous live file (newest rotation), .5 the oldest.
    assert.match(fs.readFileSync(`${file}.1`, "utf8"), new RegExp(`gen${LOG_FILE_KEEP} `));
    assert.match(fs.readFileSync(`${file}.${LOG_FILE_KEEP}`, "utf8"), /gen1 /);
    assert.ok(fs.statSync(file).size < LOG_FILE_MAX_BYTES);
  });

  test("an unopenable path falls back to the console instead of throwing", () => {
    // A path whose parent is a FILE — mkdir and open both fail.
    const blocker = path.join(TMP, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: string) => seen.push(m);
    try {
      withSink(path.join(blocker, "serve.log"), () => logWarn("still logged"));
    } finally {
      console.error = orig;
    }
    assert.equal(seen.length, 2);
    assert.match(seen[0]!, /cannot open LISA_LOG_FILE/);
    assert.equal(seen[1], "still logged");
  });
});

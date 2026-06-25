import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-autonomy-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "autonomy", "state.json");

const { loadAutonomyState, getAutonomyEnabled, setAutonomyEnabled, normalizeAutonomyState } =
  await import("./state.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe("autonomy state", () => {
  test("defaults to enabled when no file exists (preserves always-on behavior)", () => {
    assert.equal(getAutonomyEnabled(), true);
    assert.deepEqual(loadAutonomyState(), { enabled: true });
  });

  test("set → load round-trips and persists to autonomy/state.json", () => {
    setAutonomyEnabled(false);
    assert.equal(getAutonomyEnabled(), false);
    assert.deepEqual(loadAutonomyState(), { enabled: false });
    assert.equal(JSON.parse(fs.readFileSync(FILE, "utf8")).enabled, false);

    setAutonomyEnabled(true);
    assert.equal(getAutonomyEnabled(), true);
  });

  test("normalize coerces missing / ill-typed to the default (enabled)", () => {
    assert.deepEqual(normalizeAutonomyState(null), { enabled: true });
    assert.deepEqual(normalizeAutonomyState({}), { enabled: true });
    assert.deepEqual(normalizeAutonomyState({ enabled: "no" as unknown as boolean }), { enabled: true });
    assert.deepEqual(normalizeAutonomyState({ enabled: false }), { enabled: false });
  });

  test("tolerates a corrupt file → falls back to default", () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, "{not json");
    assert.deepEqual(loadAutonomyState(), { enabled: true });
  });
});

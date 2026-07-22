import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the policy file to a throwaway dir (read lazily via lisaHome()).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lisa-policy-"));
process.env.LISA_HOME = TMP;
const FILE = path.join(TMP, "control-policy.json");

const { defaultControlPolicy, normalizeControlPolicy, loadControlPolicy, saveControlPolicy } =
  await import("./policy.js");

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
});

describe("control policy", () => {
  test("default: may control own agents, may NOT adopt external sessions", () => {
    assert.deepEqual(defaultControlPolicy(), { remoteControl: true, remoteAdoptExternal: false });
  });

  test("missing file → defaults", () => {
    assert.deepEqual(loadControlPolicy(), defaultControlPolicy());
  });

  test("normalize coerces missing / ill-typed / null to defaults", () => {
    assert.deepEqual(normalizeControlPolicy({}), defaultControlPolicy());
    assert.deepEqual(normalizeControlPolicy(null), defaultControlPolicy());
    assert.deepEqual(normalizeControlPolicy({ remoteControl: "yes" as unknown as boolean }), defaultControlPolicy());
    assert.deepEqual(normalizeControlPolicy({ remoteAdoptExternal: true }), {
      remoteControl: true,
      remoteAdoptExternal: true,
    });
  });

  test("save normalizes a partial (fills missing with defaults) and round-trips", () => {
    const saved = saveControlPolicy({ remoteAdoptExternal: true });
    assert.deepEqual(saved, { remoteControl: true, remoteAdoptExternal: true });
    assert.deepEqual(loadControlPolicy(), { remoteControl: true, remoteAdoptExternal: true });
  });

  test("corrupt JSON → defaults (no throw)", () => {
    fs.writeFileSync(FILE, "{not json");
    assert.deepEqual(loadControlPolicy(), defaultControlPolicy());
  });
});

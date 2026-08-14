import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SandboxUnavailableError,
  isSandboxMode,
  modeAllowsWrites,
  modeIsBounded,
  resolveSandboxMode,
} from "./mode.js";
import { buildMacosSeatbeltPolicy } from "./macos.js";
import { wrapForSandbox } from "./sandbox.js";

/** H2 acceptance (docs/PLAN_HARNESS_ALIGNMENT_v1.0.md §3). */

beforeEach(() => {
  delete process.env.LISA_SANDBOX;
  delete process.env.LISA_SANDBOX_MODE;
});

describe("sandbox mode resolution", () => {
  test("defaults to danger-full-access — H2 does not silently confine existing setups", () => {
    assert.equal(resolveSandboxMode(), "danger-full-access");
  });

  test("legacy LISA_SANDBOX=1 still means workspace-write", () => {
    process.env.LISA_SANDBOX = "1";
    assert.equal(resolveSandboxMode(), "workspace-write");
    process.env.LISA_SANDBOX = "true";
    assert.equal(resolveSandboxMode(), "workspace-write");
  });

  test("LISA_SANDBOX_MODE wins over the legacy flag", () => {
    process.env.LISA_SANDBOX = "1";
    process.env.LISA_SANDBOX_MODE = "read-only";
    assert.equal(resolveSandboxMode(), "read-only");
  });

  test("an explicit argument wins over the environment", () => {
    process.env.LISA_SANDBOX_MODE = "read-only";
    assert.equal(resolveSandboxMode("workspace-write"), "workspace-write");
  });

  test("a typo in LISA_SANDBOX_MODE is an error, not a silent fallback", () => {
    process.env.LISA_SANDBOX_MODE = "workspace_write";
    assert.throws(() => resolveSandboxMode(), /bad LISA_SANDBOX_MODE/);
  });

  test("mode predicates", () => {
    assert.equal(modeAllowsWrites("read-only"), false);
    assert.equal(modeAllowsWrites("workspace-write"), true);
    assert.equal(modeIsBounded("danger-full-access"), false);
    assert.equal(modeIsBounded("read-only"), true);
    assert.equal(isSandboxMode("read-only"), true);
    assert.equal(isSandboxMode("nonsense"), false);
  });
});

describe("macOS Seatbelt policy per mode", () => {
  test("workspace-write grants the workspace and temp dirs", () => {
    const policy = buildMacosSeatbeltPolicy({
      cwd: "/work/proj",
      allowNetwork: true,
      mode: "workspace-write",
    });
    assert.match(policy, /\(allow file-write\* \(subpath "\/work\/proj"\)\)/);
    assert.match(policy, /\(subpath "\/tmp"\)/);
  });

  test("read-only grants no writable path but /dev/null", () => {
    const policy = buildMacosSeatbeltPolicy({
      cwd: "/work/proj",
      allowNetwork: true,
      mode: "read-only",
    });
    assert.doesNotMatch(policy, /subpath "\/work\/proj"/);
    assert.doesNotMatch(policy, /file-write\* \(subpath "\/tmp"\)/);
    assert.match(policy, /file-write-data \(literal "\/dev\/null"\)/);
  });

  test("network can be withheld in either mode", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      const policy = buildMacosSeatbeltPolicy({
        cwd: "/w",
        allowNetwork: false,
        mode,
      });
      assert.doesNotMatch(policy, /^\(allow network\*\)$/m);
      assert.match(policy, /local tcp "localhost:\*"/);
    }
  });
});

describe("wrapForSandbox — fail closed, never silently unconfined", () => {
  test("danger-full-access runs plain bash", async () => {
    const wrapped = await wrapForSandbox(
      { mode: "danger-full-access", allowNetwork: true, cwd: "/w" },
      "echo hi",
    );
    assert.equal(wrapped.command, "/bin/bash");
    assert.deepEqual(wrapped.args, ["-lc", "echo hi"]);
  });

  test("a bounded mode on an unsupported platform refuses instead of degrading", async (t) => {
    if (process.platform === "darwin") {
      // The real macOS path is exercised below; simulate the other branch.
      const original = Object.getOwnPropertyDescriptor(process, "platform")!;
      t.after(() => Object.defineProperty(process, "platform", original));
      Object.defineProperty(process, "platform", { value: "sunos" });
    }
    await assert.rejects(
      wrapForSandbox(
        { mode: "workspace-write", allowNetwork: true, cwd: "/w" },
        "echo hi",
      ),
      (err: unknown) => {
        assert.ok(err instanceof SandboxUnavailableError);
        assert.equal(err.code, "SANDBOX_UNAVAILABLE");
        assert.match(err.message, /Refusing to run the command unconfined/);
        return true;
      },
    );
  });

  test("macOS wraps in sandbox-exec and cleans up the policy file", async (t) => {
    if (process.platform !== "darwin") return t.skip("darwin only");
    const wrapped = await wrapForSandbox(
      { mode: "workspace-write", allowNetwork: true, cwd: process.cwd() },
      "echo hi",
    );
    assert.equal(wrapped.command, "/usr/bin/sandbox-exec");
    assert.equal(wrapped.args[0], "-f");
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(wrapped.args[1]!), true, "policy file written");
    await wrapped.cleanup?.();
    assert.equal(existsSync(wrapped.args[1]!), false, "policy file removed");
  });
});

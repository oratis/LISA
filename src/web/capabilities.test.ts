import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../types.js";
import {
  autonomyProfileForEdition,
  capabilityProfileForEdition,
  isCloudDeniedRoute,
  toolsForCapabilityProfile,
} from "./capabilities.js";
import { sandboxModeForProfile, untrustedSurfaceMode } from "../sandbox/sandbox.js";

const fake = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  execute: async () => "",
});

describe("capability profiles", () => {
  test("maps editions to explicit profiles", () => {
    assert.equal(capabilityProfileForEdition("mac"), "local-owner");
    assert.equal(capabilityProfileForEdition("cloud"), "cloud-chat");
  });

  test("local owner retains the original toolset while cloud is allow-listed", () => {
    const tools = [fake("bash"), fake("soul_read"), fake("operator_mcp")];
    assert.equal(toolsForCapabilityProfile(tools, "local-owner"), tools);
    assert.deepEqual(
      toolsForCapabilityProfile(tools, "cloud-chat").map((tool) => tool.name),
      ["soul_read"],
    );
  });
});

describe("cloud route capability boundary", () => {
  test("denies machine-control and arbitrary outbound routes, including query forms", () => {
    for (const route of [
      "/api/agents/managed/start",
      "/api/advisor/latest",
      "/api/agents/pty/a/output",
      "/api/dispatch/status?id=secret",
      "/api/control/policy",
      "/api/config/save",
      "/api/devices",
      "/api/pair/start",
      "/api/plans",
      "/api/plans/select",
      "/api/mail/connect",
      "/api/vision/capture",
      "/api/sense/recent",
      "/api/kb/ingest?force=1",
    ]) {
      assert.equal(isCloudDeniedRoute(route), true, `${route} must be denied`);
    }
  });

  test("keeps tenant data, auth, billing, chat, and bounded KB routes available", () => {
    for (const route of [
      "/api/auth/me",
      "/api/billing/quota",
      "/api/autonomy/state",
      "/api/kb/search?q=lisa",
      "/api/kb/add",
      "/api/soul",
      "/chat",
      "/reflect",
      "/api/plans-public",
    ]) {
      assert.equal(isCloudDeniedRoute(route), false, `${route} must stay available`);
    }
  });

  test("fails closed for malformed URLs", () => {
    assert.equal(isCloudDeniedRoute("http://["), true);
  });
});

describe("autonomy + device profiles (T-13)", () => {
  test("autonomy declares its own profile per edition", () => {
    assert.equal(autonomyProfileForEdition("mac"), "local-autonomy");
    assert.equal(autonomyProfileForEdition("cloud"), "cloud-autonomy");
  });

  test("only the two local profiles keep the full host toolset", () => {
    const tools = [fake("bash"), fake("write"), fake("soul_read")];
    const names = (p: Parameters<typeof toolsForCapabilityProfile>[1]) =>
      toolsForCapabilityProfile(tools, p).map((t) => t.name);
    assert.deepEqual(names("local-owner"), ["bash", "write", "soul_read"]);
    // Lisa on the owner's own machine is still the owner — it is her
    // CONFINEMENT that tightens, not her tool list.
    assert.deepEqual(names("local-autonomy"), ["bash", "write", "soul_read"]);
    // Everything off-host is allow-listed. cloud-autonomy is the one that was
    // actually leaking: the sweep passed the unfiltered registry.
    for (const p of ["cloud-chat", "cloud-autonomy", "remote-device"] as const) {
      assert.equal(names(p).includes("bash"), false, `${p} must not get bash`);
      assert.equal(names(p).includes("write"), false, `${p} must not get write`);
    }
  });

  test("cloud autonomy can never exceed cloud chat", () => {
    const tools = [fake("bash"), fake("soul_read"), fake("memory_search")];
    assert.deepEqual(
      toolsForCapabilityProfile(tools, "cloud-autonomy").map((t) => t.name),
      toolsForCapabilityProfile(tools, "cloud-chat").map((t) => t.name),
    );
  });

  test("sandboxModeForProfile: only the owner's own keyboard gets the env default", () => {
    const prev = process.env.LISA_SANDBOX_MODE;
    process.env.LISA_SANDBOX_MODE = "danger-full-access";
    try {
      assert.equal(sandboxModeForProfile("local-owner"), "danger-full-access");
      for (const p of [
        "local-autonomy",
        "cloud-autonomy",
        "cloud-chat",
        "remote-device",
      ] as const) {
        // untrustedSurfaceMode() caps at workspace-write where the host can
        // enforce it, and warns-and-passes-through where it cannot; either way
        // it is never looser than what the owner asked for.
        assert.equal(sandboxModeForProfile(p), untrustedSurfaceMode(), p);
      }
      // A stricter pin is honoured for the owner too.
      process.env.LISA_SANDBOX_MODE = "read-only";
      assert.equal(sandboxModeForProfile("local-owner"), "read-only");
      assert.equal(sandboxModeForProfile("local-autonomy"), "read-only");
    } finally {
      if (prev === undefined) delete process.env.LISA_SANDBOX_MODE;
      else process.env.LISA_SANDBOX_MODE = prev;
    }
  });
});

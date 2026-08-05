import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../types.js";
import {
  capabilityProfileForEdition,
  isCloudDeniedRoute,
  toolsForCapabilityProfile,
} from "./capabilities.js";

const fake = (name: string): ToolDefinition =>
  ({ name, description: name, inputSchema: { type: "object" }, execute: async () => "" }) as ToolDefinition;

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

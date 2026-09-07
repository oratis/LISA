import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "../types.js";
import {
  capabilityProfileForEdition,
  isCloudDeniedRoute,
  isNonCanonicalPath,
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

  test("denies consent routes — consent state is per-machine, not per-tenant", () => {
    // src/consent/store.ts writes a single ~/.lisa/consent.json outside the
    // per-user home scope, so in the hosted edition these routes would be
    // cross-tenant: read another tenant's grants, grant "mail" deployment-wide,
    // or revoke-all and kill the mail digest for everyone.
    for (const route of [
      "/api/consent",
      "/api/consent?x=1",
      "/api/consent/grant",
      "/api/consent/revoke",
      "/api/consent/revoke-all",
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

  test("denies push routes — one machine-wide channel, subscriptions carry no owner", () => {
    // src/web/push.ts keeps push.json in the operator home on purpose (every
    // PushBridge producer is host-level), so in the hosted edition these routes
    // would hand any signed-in tenant every other tenant's ntfy topic — which is
    // itself the send/read secret — and APNs device token.
    for (const route of [
      "/api/push",
      "/api/push/list",
      "/api/push/register",
      "/api/push/unregister",
      "/api/push/prefs",
      "/api/push/live-activity",
    ]) {
      assert.equal(isCloudDeniedRoute(route), true, `${route} must be denied`);
    }
  });

  test("fails closed for malformed URLs", () => {
    assert.equal(isCloudDeniedRoute("http://["), true);
  });
});

describe("non-canonical request paths", () => {
  // isCloudDeniedRoute matches the normalized pathname; server.ts routes match
  // the raw req.url. Each of these normalizes to something the deny-list waves
  // through while still matching its handler's raw prefix, so without the guard
  // the route runs in the hosted edition.
  test("rejects the dot-segment paths that slip past the deny-list", () => {
    for (const route of [
      "/api/agents/recap/%2e%2e/%2e%2e/%2e%2e?sinceMinutes=1440",
      "/api/agents/steps/../../../x?agent=claude-code",
      "/api/agents/transcript/../../../x",
      "/api/dispatch/status/../../../x?id=1",
      "/api/agents/pty/%2e%2e/%2e%2e/%2e%2e/z/output",
      "/api/mail/accounts/../../../q",
    ]) {
      assert.equal(isNonCanonicalPath(route), true, `${route} must be rejected`);
      // The bypass is real: the deny-list alone does not stop these.
      assert.equal(
        isCloudDeniedRoute(route),
        false,
        `${route} is exactly the case the deny-list misses`,
      );
    }
  });

  test("also rejects dot segments that would still have been denied", () => {
    // "/api/consent/./grant" normalizes back onto a denied prefix, so it is not
    // a bypass — but canonical form is the invariant, not "did it happen to be
    // caught": the next route added under a non-denied prefix would be.
    assert.equal(isNonCanonicalPath("/api/consent/./grant"), true);
    assert.equal(isCloudDeniedRoute("/api/consent/./grant"), true);
  });

  test("rejects a leading // — it reparses as an authority, dropping the prefix", () => {
    assert.equal(isNonCanonicalPath("//api/consent/grant"), true);
    assert.equal(isCloudDeniedRoute("//api/consent/grant"), false);
  });

  test("fails closed for malformed URLs", () => {
    assert.equal(isNonCanonicalPath("http://["), true);
  });

  test("leaves ordinary paths alone, including percent-encoded ones", () => {
    for (const route of [
      "/",
      "/health",
      "/chat",
      "/api/soul",
      "/api/consent/grant",
      "/api/push/list",
      "/api/dispatch/status?id=99-ab",
      "/api/kb/search?q=hello%20world",
      "/assets/%E5%9B%BE%E7%89%87.png",
      "/api/room/music/file/u_YWJjLm1wMw",
      "/api/agents/pty/abc-123/output",
      // Dot segments in the QUERY are not path traversal.
      "/api/kb/search?q=a/../b",
    ]) {
      assert.equal(isNonCanonicalPath(route), false, `${route} must be allowed`);
    }
  });

  test("an encoded separator that survives normalization is left to the deny-list", () => {
    // %2f is not decoded into a path separator, so the pathname — and therefore
    // the deny-list decision — is unchanged. Nothing is bypassed, so nothing to
    // reject; the prefix still matches.
    const route = "/api/agents/transcript/..%2f..%2f..";
    assert.equal(isNonCanonicalPath(route), false);
    assert.equal(isCloudDeniedRoute(route), true);
  });
});

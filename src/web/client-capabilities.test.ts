import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildClientCapabilities } from "./client-capabilities.js";

describe("buildClientCapabilities", () => {
  test("reports Mac local-owner capabilities truthfully", () => {
    const caps = buildClientCapabilities({
      edition: "mac",
      surface: "local-web",
      profile: "local-owner",
      canApprove: true,
      localOwner: true,
      connectorsEnabled: true,
      cloudWorkspaceConfigured: false,
    });
    assert.equal(caps.location, "mac");
    assert.equal(caps.tasks.status, "available");
    assert.deepEqual(caps.tasks.supportedKinds, ["oneoff", "routine", "watcher", "goal"]);
    assert.equal(caps.approvals.status, "available");
    assert.equal(caps.connectors.status, "available");
    assert.equal(caps.localTools.status, "available");
    assert.equal(caps.cloudWorkspace.status, "needs_setup");
    assert.equal(caps.artifacts.status, "available");
  });

  test("never fakes cloud tasks when LISA_CLOUD_TASKS is off", () => {
    const caps = buildClientCapabilities({
      edition: "cloud",
      surface: "cloud",
      profile: "cloud-chat",
      canApprove: true,
      localOwner: false,
      cloudTasksOn: false,
    });
    assert.equal(caps.location, "cloud");
    assert.equal(caps.tasks.status, "disabled");
    assert.deepEqual(caps.tasks.supportedKinds, []);
    assert.equal(caps.artifacts.status, "disabled");
    assert.equal(caps.connectors.status, "unsupported");
    assert.equal(caps.localTools.status, "unsupported");
    assert.equal(caps.cloudWorkspace.status, "available");
  });

  test("reports cloud tasks available without watchers when enabled", () => {
    const caps = buildClientCapabilities({
      edition: "cloud",
      surface: "cloud",
      profile: "cloud-chat",
      canApprove: true,
      localOwner: false,
      cloudTasksOn: true,
    });
    assert.equal(caps.tasks.status, "available");
    assert.deepEqual(caps.tasks.supportedKinds, ["oneoff", "routine", "goal"]);
    assert.equal(caps.artifacts.status, "available");
  });

  test("disables approvals and local tools for remote paired devices", () => {
    const caps = buildClientCapabilities({
      edition: "mac",
      surface: "local-web",
      profile: "remote-device",
      canApprove: false,
      localOwner: false,
      connectorsEnabled: true,
    });
    assert.equal(caps.approvals.status, "disabled");
    assert.equal(caps.connectors.status, "unsupported");
    assert.equal(caps.localTools.status, "unsupported");
  });
});

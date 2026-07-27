import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMERCIAL_ADAPTER_PROFILES,
  commercialPublishPlan,
  evaluateCommercialReadiness,
  validateCommercialDraft,
} from "./commercial.js";

test("all seven commercial platforms have official-source and version gates", () => {
  assert.deepEqual(Object.keys(COMMERCIAL_ADAPTER_PROFILES).sort(), [
    "facebook", "instagram", "linkedin", "threads", "tiktok", "x", "youtube",
  ]);
  for (const profile of Object.values(COMMERCIAL_ADAPTER_PROFILES)) {
    assert.ok(profile.oauthScopes.length);
    assert.ok(profile.externalGates.length);
    assert.ok(profile.officialDocs.every((url) => url.startsWith("https://")));
    assert.ok(profile.versionPolicy.length > 20);
  }
});

test("readiness never calls an unaudited or unconfigured platform ready", () => {
  const blocked = evaluateCommercialReadiness("instagram", {
    oauthClientConfigured: false,
    redirectOriginConfigured: false,
    platformReviewApproved: false,
  });
  assert.equal(blocked.state, "draft-only");
  assert.ok(blocked.blockers.length >= 4);
  const youtube = evaluateCommercialReadiness("youtube", {
    oauthClientConfigured: true,
    redirectOriginConfigured: true,
    platformReviewApproved: true,
    youtubeAuditApproved: false,
  });
  assert.equal(youtube.state, "private-test-only");
});

test("platform-specific required fields fail closed", () => {
  const youtube = validateCommercialDraft(
    "youtube",
    { connectorId: "youtube-official", accountId: "channel", platform: "youtube" },
    { title: "video", media: [] },
  );
  assert.equal(youtube.ok, false);
  assert.match(youtube.errors.join(" "), /exactly one video/);
  assert.match(youtube.errors.join(" "), /privacyStatus/);

  const tiktok = validateCommercialDraft(
    "tiktok",
    { connectorId: "tiktok-official", accountId: "creator", platform: "tiktok" },
    { text: "caption", media: [{ id: "1", kind: "video", mimeType: "video/mp4", bytes: 1, sha256: "x" }] },
  );
  assert.equal(tiktok.ok, false);
  assert.match(tiktok.errors.join(" "), /privacyLevel/);
});

test("request plans preserve each official multi-step protocol", () => {
  assert.deepEqual(
    commercialPublishPlan("threads", true).map((step) => step.operation),
    ["create-container", "publish-container"],
  );
  assert.deepEqual(
    commercialPublishPlan("youtube", true).map((step) => step.operation),
    ["start-resumable", "upload-video", "poll-processing"],
  );
  assert.equal(
    commercialPublishPlan("tiktok", true).some((step) => step.operation === "creator-info"),
    true,
  );
});
